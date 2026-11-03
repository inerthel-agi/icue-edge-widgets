//! Spotify Web API polling, artwork, LRCLIB lyrics and command execution.
//! Polls /me/player every 3 s while playing, 5 s when paused, 10 s with nothing playing; every 15 s / 30 s
//! when the Spotify app is open on this PC, whose Windows session wakes the poller on each change,
//! and waits on Retry-After when Spotify rate-limits.
use super::{auth, lock, parse_lrc, publish, publish_if, Allowed, Art, Call, Device, Item, Line, Lyrics, Player, Status, Upcoming, HUB, QUEUE_LEN};
use crate::util::{now_ms, read_limited, SEC};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

const API: &str = "https://api.spotify.com/v1";
const LRCLIB: &str = "https://lrclib.net/api";
const USER_AGENT: &str = "icue-edge-companion (XENEON EDGE widget)";
const MAX_ART_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LYRICS_BYTES: u64 = 512 * 1024;
const MAX_API_BYTES: usize = 2 * 1024 * 1024;
/// Reported and predicted positions may drift this much before a snapshot is re-sent.
const DRIFT_MS: u64 = 1500;

/// Own budget: at most BUDGET Web API calls per WINDOW (Spotify counts over a rolling 30 s too).
/// Normal use is about 12: one reading every 3 s plus the queue, profile and commands.
const BUDGET: usize = 20;
const WINDOW_MS: u64 = 30 * SEC;
/// After a ban ends the poller stays gentle (>= 5 s between readings) for this long.
const COOLDOWN_MS: u64 = 5 * 60 * SEC;
static CALLS: Mutex<VecDeque<u64>> = Mutex::new(VecDeque::new());
static COOL_UNTIL: AtomicU64 = AtomicU64::new(0);

fn ban_path() -> std::path::PathBuf {
    crate::util::app_dir().join("spotify-ban.txt")
}

/// End of a Spotify ban saved by an earlier run, if it has not passed yet.
pub fn saved_ban() -> Option<u64> {
    std::fs::read_to_string(ban_path()).ok()?.trim().parse::<u64>().ok().filter(|&t| t > now_ms())
}

enum ApiError {
    Unauthorized,
    Premium,
    Forbidden,
    RateLimited(u64),
    Other(String),
}

fn direct_get(url: &str) -> Result<ureq::Response, ureq::Error> {
    ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(8)).build().get(url).set("User-Agent", USER_AGENT).call()
}

fn request(method: &str, path: &str, body: Option<&str>) -> Result<Option<Value>, ApiError> {
    // While Spotify says wait, no thread (queue, profile, devices, commands) may call it: extra calls can extend the ban.
    if let Some(t) = lock().rate_limited_until.filter(|&t| t > now_ms()) {
        return Err(ApiError::RateLimited(t - now_ms()));
    }
    {
        let now = now_ms();
        let mut calls = CALLS.lock().unwrap_or_else(|e| e.into_inner());
        while calls.front().is_some_and(|&t| t + WINDOW_MS < now) {
            calls.pop_front();
        }
        if calls.len() >= BUDGET {
            return Err(ApiError::RateLimited(calls[0] + WINDOW_MS - now + 1));
        }
        calls.push_back(now);
    }
    let token = auth::access_token().map_err(|s| match s {
        Status::NeedsLogin => ApiError::Unauthorized,
        Status::NotConfigured => ApiError::Other("Spotify is not connected".into()),
        _ => ApiError::Other("Spotify is unreachable".into()),
    })?;
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(8)).build();
    let req = agent.request(method, &format!("{API}{path}"))
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", "icue-edge-companion");
    let res = match body {
        Some(b) => req.set("Content-Type", "application/json").send_string(b),
        None if method == "GET" => req.call(),
        None => req.send_bytes(&[]),
    };
    match res {
        Ok(r) if r.status() == 204 => Ok(None),
        Ok(r) => {
            let bytes = read_limited(r.into_reader(), MAX_API_BYTES).map_err(|e| ApiError::Other(e.to_string()))?;
            Ok(if bytes.iter().all(u8::is_ascii_whitespace) { None } else { serde_json::from_slice(&bytes).ok() })
        }
        Err(ureq::Error::Status(401, _)) => Err(ApiError::Unauthorized),
        Err(ureq::Error::Status(403, r)) => {
            let v: Value = read_limited(r.into_reader(), MAX_API_BYTES).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            let reason = v["error"]["reason"].as_str().unwrap_or("");
            Err(if reason == "PREMIUM_REQUIRED" { ApiError::Premium } else { ApiError::Forbidden })
        }
        Err(ureq::Error::Status(429, r)) => {
            let secs = r.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(30);
            // Recorded here so background callers that drop errors (queue, devices) still honour the wait.
            let ms = secs.clamp(1, 86_400) * SEC;
            let err = ApiError::RateLimited(ms);
            COOL_UNTIL.store(now_ms() + ms + COOLDOWN_MS, Ordering::Relaxed);
            // Kept on disk: a restart must not call Spotify again before the ban ends.
            let _ = std::fs::write(ban_path(), (now_ms() + ms).to_string());
            apply_error(&err);
            Err(err)
        }
        Err(ureq::Error::Status(code, _)) => Err(ApiError::Other(format!("Spotify answered {code}"))),
        Err(_) => Err(ApiError::Other("Spotify is unreachable".into())),
    }
}

/// Calls once more after refreshing the token when Spotify answers 401.
fn call_api(method: &str, path: &str, body: Option<&str>) -> Result<Option<Value>, ApiError> {
    match request(method, path, body) {
        Err(ApiError::Unauthorized) => {
            auth::expire_access();
            request(method, path, body)
        }
        other => other,
    }
}

fn apply_error(e: &ApiError) {
    let mut st = lock();
    match e {
        ApiError::Unauthorized => {
            st.status = Status::NeedsLogin;
            st.message = Some("Spotify ended the session. Connect again.".into());
        }
        ApiError::Premium => {
            st.status = Status::PremiumRequired;
            st.message = Some("Spotify Premium is required for playback control.".into());
        }
        ApiError::Forbidden => st.message = Some("Spotify refused the request. Check User Management in your Spotify app.".into()),
        ApiError::RateLimited(ms) => st.rate_limited_until = Some(now_ms() + ms),
        ApiError::Other(m) => st.message = Some(m.clone()),
    }
    publish(&mut st);
}

// ---------- parsing ----------

fn device_from(v: &Value) -> Device {
    Device {
        id: v["id"].as_str().unwrap_or("").to_string(),
        name: v["name"].as_str().unwrap_or("Spotify device").to_string(),
        kind: v["type"].as_str().unwrap_or("Device").to_string(),
        active: v["is_active"].as_bool().unwrap_or(false),
        volume: if v["supports_volume"].as_bool() == Some(false) { None } else { v["volume_percent"].as_u64().map(|x| x.min(100) as u8) },
    }
}

fn item_from(player: &Value) -> Option<Item> {
    let kind = player["currently_playing_type"].as_str().unwrap_or("unknown").to_string();
    let it = &player["item"];
    if kind == "ad" {
        return Some(Item { key: "ad".into(), kind, title: "Advertisement".into(), artists: "Spotify".into(), ..Default::default() });
    }
    if it.is_null() {
        return None;
    }
    let names = |a: &Value| a.as_array().map(|x| x.iter().filter_map(|n| n["name"].as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let (artists, album, images) = if kind == "episode" {
        (it["show"]["name"].as_str().unwrap_or("").to_string(), it["show"]["publisher"].as_str().unwrap_or("").to_string(), &it["images"])
    } else {
        (names(&it["artists"]), it["album"]["name"].as_str().unwrap_or("").to_string(), &it["album"]["images"])
    };
    Some(Item {
        key: it["uri"].as_str().or(it["id"].as_str()).unwrap_or("unknown").to_string(),
        kind,
        title: it["name"].as_str().unwrap_or("").to_string(),
        artists,
        album,
        art_url: images.as_array().and_then(|a| a.first()).and_then(|i| i["url"].as_str()).map(String::from),
        duration_ms: it["duration_ms"].as_u64().unwrap_or(0),
    })
}

fn player_from(v: &Value, now: u64) -> Player {
    let d = &v["actions"]["disallows"];
    let no = |k: &str| d[k].as_bool().unwrap_or(false);
    let playing = v["is_playing"].as_bool().unwrap_or(false);
    Player {
        item: item_from(v),
        playing,
        progress_ms: v["progress_ms"].as_u64().unwrap_or(0),
        updated_at: now,
        shuffle: v["shuffle_state"].as_bool().unwrap_or(false),
        smart_shuffle: v["smart_shuffle"].as_bool().unwrap_or(false),
        repeat: v["repeat_state"].as_str().unwrap_or("off").to_string(),
        device: v.get("device").filter(|d| d.is_object()).map(device_from),
        allowed: Allowed {
            play_pause: !(if playing { no("pausing") } else { no("resuming") }),
            next: !no("skipping_next"),
            prev: !no("skipping_prev"),
            seek: !no("seeking"),
            shuffle: !no("toggling_shuffle"),
            repeat: !(no("toggling_repeat_context") && no("toggling_repeat_track")),
        },
    }
}

/// Whether the new reading changes anything a widget shows (position only past DRIFT_MS).
fn differs(old: &Player, new: &Player) -> bool {
    let predicted = old.progress_ms + if old.playing { new.updated_at.saturating_sub(old.updated_at) } else { 0 };
    let drift = predicted.abs_diff(new.progress_ms);
    old.item != new.item || old.playing != new.playing || old.shuffle != new.shuffle || old.smart_shuffle != new.smart_shuffle || old.repeat != new.repeat
        || old.device != new.device || old.allowed != new.allowed || drift > DRIFT_MS
}

// ---------- artwork and lyrics (background, dropped if the track moved on) ----------

fn art_host_ok(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.contains(['@', ':']) && (host.ends_with(".scdn.co") || host.ends_with(".spotifycdn.com"))
}

fn fetch_art(rev: u64, url: String) {
    let bytes = (|| {
        if !art_host_ok(&url) {
            return None;
        }
        let r = direct_get(&url).ok()?;
        let mut buf = Vec::new();
        r.into_reader().take(MAX_ART_BYTES + 1).read_to_end(&mut buf).ok()?;
        (buf.len() as u64 <= MAX_ART_BYTES).then_some(buf)
    })();
    let mut st = lock();
    if st.rev != rev {
        return;
    }
    st.art_pending = false;
    st.art = bytes.and_then(|b| crate::media::sniff(&b).map(|mime| Art { rev, mime, bytes: Arc::new(b) }));
    publish(&mut st);
}

static LYRICS_CACHE: LazyLock<Mutex<HashMap<String, Lyrics>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Ok(None) when LRCLIB answered without a match (404); Err when it could not be reached.
fn lrclib(path: &str, params: &[(&str, String)]) -> Result<Option<Value>, ()> {
    let query = params.iter().map(|(k, v)| format!("{k}={}", auth::percent(v))).collect::<Vec<_>>().join("&");
    let r = match direct_get(&format!("{LRCLIB}/{path}?{query}")) {
        Ok(r) => r,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(_) => return Err(()),
    };
    let bytes = read_limited(r.into_reader(), MAX_LYRICS_BYTES as usize).map_err(|_| ())?;
    Ok(serde_json::from_slice(&bytes).ok())
}

/// "Song (feat. X) - Remastered 2011" → "Song": the part LRCLIB entries usually share.
fn clean_title(title: &str) -> String {
    let mut t = title.split(" - ").next().unwrap_or(title).to_string();
    while let Some(i) = t.rfind(|c| c == '(' || c == '[').filter(|&i| i > 0 && t.trim_end().ends_with([')', ']'])) {
        t.truncate(i);
        t = t.trim_end().to_string();
    }
    t.trim().to_string()
}

/// The synced result closest in length (within 5 s) from a search answer.
fn closest(found: &Value, secs: u64) -> Option<Lyrics> {
    let gap = |r: &&Value| (r["duration"].as_f64().unwrap_or(0.0) as i64 - secs as i64).abs();
    found.as_array()?.iter().filter(|r| r["syncedLyrics"].is_string()).min_by_key(gap).filter(|r| gap(r) <= 5).and_then(lyrics_from)
}

fn lyrics_from(v: &Value) -> Option<Lyrics> {
    if v["instrumental"].as_bool() == Some(true) {
        return Some(Lyrics::Instrumental);
    }
    let lines: Vec<Line> = parse_lrc(v["syncedLyrics"].as_str()?);
    (!lines.is_empty()).then(|| Lyrics::Ready(Arc::new(lines)))
}

/// LRCLIB exact match first (title, artist, album, duration), then the closest synced search result.
/// None when LRCLIB could not be reached: that answer is not cached, the next play asks again.
fn find_lyrics(item: &Item, current: &dyn Fn() -> bool) -> Option<Lyrics> {
    find_lyrics_by(&item.title, item.artists.split(", ").next().unwrap_or(""), &item.album, item.duration_ms / 1000, current)
}

/// Lyrics of a track played by any Windows player (Now Playing), cached by title, artist and length.
/// Lyrics::None when LRCLIB has nothing or could not be reached (the latter is not cached).
pub fn lyrics_for(title: &str, artist: &str, album: &str, secs: u64, current: &dyn Fn() -> bool) -> Lyrics {
    let key = format!("media|{title}|{artist}|{secs}");
    if let Some(l) = LYRICS_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return l.clone();
    }
    let Some(found) = find_lyrics_by(title, artist, album, secs, current) else { return Lyrics::None };
    let mut cache = LYRICS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= 64 {
        cache.clear();
    }
    cache.insert(key, found.clone());
    found
}

/// Exact match, then searches from strict to loose: title + artist, cleaned title + artist, free text.
/// While LRCLIB cannot be reached (network, or its "server busy" 503) it is retried for about four
/// minutes, as long as `current()` says the track is still the one playing; NetEase is still tried.
/// None only when no source could be reached.
fn find_lyrics_by(title: &str, artist: &str, album: &str, secs: u64, current: &dyn Fn() -> bool) -> Option<Lyrics> {
    for wait in [0, 5, 15, 30, 60, 60, 60] {
        std::thread::sleep(Duration::from_secs(wait));
        if !current() {
            return None;
        }
        if wait == 15 {
            // LRCLIB down twice in a row: NetEase may still have it.
            if let Some(original) = netease(title, artist, secs) {
                return Some(original);
            }
        }
        if let Ok(found) = lookup(title, artist, album, secs) {
            // LRCLIB often has K-pop / J-pop only romanized: NetEase usually has the original script.
            if wants_original_script(&found, title, artist) {
                if let Some(original) = netease(title, artist, secs) {
                    return Some(original);
                }
            }
            return Some(found);
        }
    }
    None
}

fn non_latin(s: &str) -> bool {
    s.chars().any(|c| matches!(c as u32, 0x3040..=0x30FF | 0x3400..=0x9FFF | 0xAC00..=0xD7A3 | 0x1100..=0x11FF))
}

/// True when LRCLIB found nothing, or only Latin text for a track that is likely sung in Korean or
/// Japanese: a non-Latin title or artist, or lyrics that read like romanization.
/// ponytail: word-pattern heuristic; a song in English with many "eo"/"eu" words could trigger one extra lookup.
fn wants_original_script(found: &Lyrics, title: &str, artist: &str) -> bool {
    let lines = match found {
        Lyrics::Ready(lines) => lines,
        Lyrics::Instrumental => return false,
        _ => return true,
    };
    if lines.iter().any(|l| non_latin(&l.text)) {
        return false;
    }
    if non_latin(title) || non_latin(artist) {
        return true;
    }
    let words: Vec<String> = lines.iter().flat_map(|l| l.text.split_whitespace().map(|w| w.to_lowercase())).collect();
    if words.len() < 20 {
        return false;
    }
    let share = |f: &dyn Fn(&str) -> bool| words.iter().filter(|w| f(w)).count() as f64 / words.len() as f64;
    let korean = share(&|w| ["eo", "eu", "ae", "ui", "jj", "kk", "tt", "ss"].iter().any(|p| w.contains(p)) && !w.contains("ss "));
    let japanese = share(&|w| matches!(w, "no" | "wa" | "ga" | "wo" | "ni" | "de" | "mo" | "kimi" | "boku" | "watashi" | "kokoro" | "yo" | "ne"));
    korean > 0.18 || japanese > 0.12
}

/// NetEase Cloud Music (unofficial public interface): only the title and artist are sent.
/// Keeps the result only if it is the same recording (artist, length within 3 s, not a live,
/// cover or alternate version) and its lyrics are in a non-Latin script.
fn netease(title: &str, artist: &str, secs: u64) -> Option<Lyrics> {
    let get = |url: String| -> Option<Value> {
        let r = direct_get(&url).ok()?;
        serde_json::from_slice(&read_limited(r.into_reader(), MAX_LYRICS_BYTES as usize).ok()?).ok()
    };
    let q = auth::percent(&format!("{artist} {}", clean_title(title)));
    let found = get(format!("https://music.163.com/api/search/get?s={q}&type=1&limit=20"))?;
    let id = netease_pick(&found, title, artist, secs)?;
    let lrc = get(format!("https://music.163.com/api/song/lyric?id={id}&lv=1"))?;
    let lines: Vec<Line> = parse_lrc(lrc.pointer("/lrc/lyric")?.as_str()?).into_iter().filter(|l| !is_credit(&l.text)).collect();
    (lines.iter().any(|l| non_latin(&l.text))).then(|| Lyrics::Ready(Arc::new(lines)))
}

fn netease_pick(found: &Value, title: &str, artist: &str, secs: u64) -> Option<u64> {
    const VARIANTS: [&str; 10] = ["live", "ver", "remix", "cover", "inst", "acoustic", "sped", "slowed", "karaoke", "mr"];
    let (want_title, want_artist) = (title.to_lowercase(), artist.to_lowercase());
    let variant = |name: &str| {
        let n = name.to_lowercase();
        VARIANTS.iter().any(|v| n.split(|c: char| !c.is_alphanumeric()).any(|w| w == *v || (v.len() > 3 && w.starts_with(v))) && !want_title.contains(v))
    };
    let gap = |s: &Value| (s["duration"].as_u64().unwrap_or(0) as i64 / 1000 - secs as i64).abs();
    found
        .pointer("/result/songs")?
        .as_array()?
        .iter()
        .filter(|s| s["artists"].as_array().is_some_and(|a| a.iter().any(|x| x["name"].as_str().is_some_and(|n| n.to_lowercase() == want_artist))))
        .filter(|s| !variant(s["name"].as_str().unwrap_or("")) && gap(s) <= 3)
        .min_by_key(|s| gap(s))
        .and_then(|s| s["id"].as_u64())
}

/// NetEase puts credits first: "作词 : Teddy", "作曲 : …".
fn is_credit(text: &str) -> bool {
    text.split_once([':', '：']).is_some_and(|(k, _)| k.trim().chars().count() <= 6 && k.chars().any(|c| matches!(c as u32, 0x4E00..=0x9FFF)))
}

fn lookup(title: &str, artist: &str, album: &str, secs: u64) -> Result<Lyrics, ()> {
    let (t, a) = (title.to_string(), artist.to_string());
    let exact = lrclib("get", &[("track_name", t.clone()), ("artist_name", a.clone()), ("album_name", album.to_string()), ("duration", secs.to_string())])?;
    if let Some(l) = exact.as_ref().and_then(lyrics_from) {
        return Ok(l);
    }
    let clean = clean_title(title);
    let mut searches = vec![vec![("track_name", t), ("artist_name", a.clone())]];
    if clean != title && !clean.is_empty() {
        searches.push(vec![("track_name", clean.clone()), ("artist_name", a.clone())]);
    }
    searches.push(vec![("q", format!("{clean} {a}"))]);
    for params in searches {
        if let Some(l) = lrclib("search", &params)?.as_ref().and_then(|f| closest(f, secs)) {
            return Ok(l);
        }
    }
    Ok(Lyrics::None)
}

fn fetch_lyrics(rev: u64, item: Item) {
    let cached = LYRICS_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&item.key).cloned();
    let lyrics = cached.unwrap_or_else(|| {
        let Some(l) = find_lyrics(&item, &|| lock().rev == rev) else { return Lyrics::None };
        let mut cache = LYRICS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        // ponytail: whole cache cleared at 64 tracks; an LRU if re-fetches ever matter.
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(item.key.clone(), l.clone());
        l
    });
    let mut st = lock();
    if st.rev == rev {
        st.lyrics = lyrics;
        publish(&mut st);
    }
}

// ---------- queue (up next) ----------

/// The next tracks from a /me/player/queue answer, with the ~300 px cover (enough for a row thumbnail).
fn upcoming_from(v: &Value) -> Vec<Upcoming> {
    let names = |a: &Value| a.as_array().map(|x| x.iter().filter_map(|n| n["name"].as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let list = v["queue"].as_array().map(Vec::as_slice).unwrap_or_default();
    list.iter()
        .take(QUEUE_LEN)
        .map(|it| {
            let episode = it["type"].as_str() == Some("episode");
            let images = if episode { &it["images"] } else { &it["album"]["images"] };
            // Spotify lists images largest first: take the smallest one still at least 160 px wide.
            let imgs = images.as_array().map(Vec::as_slice).unwrap_or_default();
            let art = imgs.iter().rev().find(|i| i["width"].as_u64().unwrap_or(0) >= 160).or(imgs.first());
            Upcoming {
                title: it["name"].as_str().unwrap_or("").to_string(),
                artists: if episode { it["show"]["name"].as_str().unwrap_or("").to_string() } else { names(&it["artists"]) },
                art_url: art.and_then(|i| i["url"].as_str()).map(String::from),
            }
        })
        .collect()
}

static QUEUE_GEN: AtomicU64 = AtomicU64::new(0);
static QUEUE_AT: AtomicU64 = AtomicU64::new(0);
const QUEUE_EVERY_MS: u64 = 120 * SEC;
const MAX_THUMB_BYTES: u64 = 1024 * 1024;

fn fetch_queue() {
    let gen = QUEUE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let Ok(v) = call_api("GET", "/me/player/queue", None) else { return };
    let queue = v.as_ref().map(upcoming_from).unwrap_or_default();
    // Covers already downloaded for the same URL are kept; only new ones are fetched.
    let known: Vec<(Option<String>, Option<(&'static str, Arc<Vec<u8>>)>)> = {
        let st = lock();
        st.queue.iter().map(|q| q.art_url.clone()).zip(st.queue_art.iter().cloned()).collect()
    };
    let art = queue
        .iter()
        .map(|q| {
            let url = q.art_url.as_ref()?;
            if let Some((_, a)) = known.iter().find(|(u, a)| u.as_ref() == Some(url) && a.is_some()) {
                return a.clone();
            }
            if !art_host_ok(url) {
                return None;
            }
            let mut buf = Vec::new();
            direct_get(url).ok()?.into_reader().take(MAX_THUMB_BYTES + 1).read_to_end(&mut buf).ok()?;
            (buf.len() as u64 <= MAX_THUMB_BYTES).then_some(())?;
            crate::media::sniff(&buf).map(|mime| (mime, Arc::new(buf)))
        })
        .collect::<Vec<_>>();
    let mut st = lock();
    // A newer fetch started meanwhile: its answer wins.
    if QUEUE_GEN.load(Ordering::SeqCst) != gen {
        return;
    }
    let changed = st.queue != queue || st.queue_art.iter().map(Option::is_some).ne(art.iter().map(Option::is_some));
    if changed {
        st.queue = queue;
        st.queue_art = art;
        st.queue_rev += 1;
        publish(&mut st);
    }
}

// ---------- polling ----------

fn fetch_profile() {
    if let Ok(Some(v)) = call_api("GET", "/me", None) {
        let name = v["display_name"].as_str().or(v["id"].as_str()).unwrap_or("Spotify user").to_string();
        // Since February 2026 Spotify omits `product` for new development-mode apps:
        // a missing value proves nothing, only a 403 PREMIUM_REQUIRED does.
        let product = v["product"].as_str().unwrap_or("").to_string();
        let mut st = lock();
        if !product.is_empty() && product != "premium" {
            st.status = Status::PremiumRequired;
            st.message = Some("Spotify Premium is required for playback control.".into());
        }
        st.account = Some((name, product));
        publish(&mut st);
    }
}

fn fetch_devices() {
    if let Ok(Some(v)) = call_api("GET", "/me/player/devices", None) {
        let devices: Vec<Device> = v["devices"].as_array().map(|a| a.iter().map(device_from).filter(|d| !d.id.is_empty()).collect()).unwrap_or_default();
        let mut st = lock();
        let changed = st.devices != devices;
        st.devices = devices;
        publish_if(&mut st, changed);
    }
}

/// One reading of /me/player. Returns the delay before the next one.
fn poll_once(last_devices: &mut u64) -> Duration {
    let now = now_ms();
    let reading = call_api("GET", "/me/player?additional_types=episode", None);
    match reading {
        Err(e) => {
            let wait = if let ApiError::RateLimited(ms) = e { Duration::from_millis(ms) } else { Duration::from_secs(15) };
            apply_error(&e);
            wait
        }
        Ok(v) => {
            let player = v.as_ref().map(|v| player_from(v, now));
            let (spawn, wait, reshuffled) = {
                let mut st = lock();
                let reshuffled = matches!((&st.player, &player), (Some(a), Some(b)) if (a.shuffle, a.smart_shuffle) != (b.shuffle, b.smart_shuffle));
                if st.status == Status::Connecting {
                    st.status = Status::Connected;
                }
                if st.status == Status::Connected {
                    st.message = None;
                }
                st.rate_limited_until = None;
                st.last_seen = now;
                let old_key = st.player.as_ref().and_then(|p| p.item.as_ref()).map(|i| i.key.clone());
                let new_key = player.as_ref().and_then(|p| p.item.as_ref()).map(|i| i.key.clone());
                let mut spawn = None;
                if old_key != new_key {
                    st.rev += 1;
                    st.art = None;
                    let item = player.as_ref().and_then(|p| p.item.clone());
                    st.art_pending = item.as_ref().is_some_and(|i| i.art_url.is_some());
                    st.lyrics = if item.as_ref().is_some_and(|i| i.kind == "track") { Lyrics::Loading } else { Lyrics::None };
                    spawn = item.map(|i| (st.rev, i));
                }
                let changed = match (&st.player, &player) {
                    (Some(a), Some(b)) => differs(a, b),
                    (None, None) => false,
                    _ => true,
                };
                if changed {
                    st.player = player.clone();
                }
                publish_if(&mut st, changed || spawn.is_some());
                // With the Spotify app open on this PC, its Windows session wakes the poller on every change
                // (spotify::set_local), so the Web API is only read now and then: far fewer calls, no ban.
                let watched = st.local.is_some();
                let wait = match (&player, watched) {
                    (Some(p), false) if p.playing => 3,
                    (Some(_), false) => 5,
                    (None, false) => 10,
                    (Some(p), true) if p.playing => 15,
                    (_, true) => 30,
                };
                (spawn, Duration::from_secs(wait), reshuffled)
            };
            // Up next: at every track change or shuffle / Smart Shuffle toggle, and every 30 s while playing (the user may edit the queue).
            let playing = player.as_ref().is_some_and(|p| p.playing);
            if spawn.is_some() || reshuffled || (playing && now >= QUEUE_AT.load(Ordering::Relaxed) + QUEUE_EVERY_MS) {
                // Spotify reorders the queue a moment after a shuffle toggle: read it again 2 s later.
                QUEUE_AT.store(if reshuffled { now + 2 * SEC - QUEUE_EVERY_MS } else { now }, Ordering::Relaxed);
                std::thread::spawn(fetch_queue);
            }
            if let Some((rev, item)) = spawn {
                if let Some(url) = item.art_url.clone() {
                    std::thread::spawn(move || fetch_art(rev, url));
                }
                if item.kind == "track" {
                    std::thread::spawn(move || fetch_lyrics(rev, item));
                }
            }
            // The device list is only needed to offer "Play on …" when nothing is active.
            if player.is_none() && now >= *last_devices + 10 * SEC {
                *last_devices = now;
                fetch_devices();
            }
            if now_ms() < COOL_UNTIL.load(Ordering::Relaxed) { wait.max(Duration::from_secs(10)) } else { wait }
        }
    }
}

pub fn run() {
    super::init();
    let mut last_devices = 0u64;
    let mut profiled_for: Option<String> = None;
    loop {
        let status = lock().status;
        // Reading playback works without Premium, so keep polling in that state too.
        let wait = if matches!(status, Status::Connected | Status::Connecting | Status::PremiumRequired) {
            let who = lock().client_id.clone();
            if profiled_for != who {
                profiled_for = who;
                fetch_profile();
            }
            poll_once(&mut last_devices)
        } else {
            Duration::from_secs(5)
        };
        // Commands and sign-in set `poke` to cut the wait short.
        let st = lock();
        let (mut st, _) = HUB.changed.wait_timeout_while(st, wait, |s| !s.poke).unwrap_or_else(|e| e.into_inner());
        st.poke = false;
    }
}

/// Runs a validated widget command, then asks the poller for a fresh reading.
pub fn execute(call: &Call) -> Result<(), (u16, &'static str)> {
    let volume = |v: u8| call_api("PUT", &format!("/me/player/volume?volume_percent={v}"), None);
    // Muted so the tracks skipped over are not heard; if muting fails the skips still run.
    let muted = call.muted_from.is_some_and(|_| volume(0).is_ok());
    let mut result = Ok(None);
    for n in 0..call.times.max(1) {
        if n > 0 {
            // Spotify applies skips in order only when they are not fired at the same instant.
            std::thread::sleep(Duration::from_millis(150));
        }
        result = call_api(call.method, &call.path, call.body.as_deref());
        if result.is_err() {
            break;
        }
    }
    if let (true, Some(v)) = (muted, call.muted_from) {
        // Restored even when a skip failed: the player must never stay silent.
        std::thread::sleep(Duration::from_millis(250));
        if volume(v).is_err() {
            std::thread::sleep(Duration::from_secs(1));
            let _ = volume(v);
        }
    }
    let mut st = lock();
    st.poke = true;
    HUB.changed.notify_all();
    drop(st);
    match result {
        Ok(_) => Ok(()),
        Err(ApiError::RateLimited(ms)) => {
            apply_error(&ApiError::RateLimited(ms));
            Err((429, "rate_limited"))
        }
        Err(ApiError::Premium) => Err((403, "premium_required")),
        Err(ApiError::Forbidden) => Err((403, "refused_by_spotify")),
        Err(ApiError::Unauthorized) => Err((401, "needs_login")),
        Err(ApiError::Other(_)) => Err((502, "spotify_error")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn player_parsing_and_disallows() {
        let v = json!({
            "is_playing": true, "progress_ms": 5000, "shuffle_state": true, "smart_shuffle": true, "repeat_state": "context",
            "currently_playing_type": "track",
            "device": { "id": "d1", "name": "Desktop", "type": "Computer", "is_active": true, "volume_percent": 65, "supports_volume": true },
            "actions": { "disallows": { "skipping_prev": true, "toggling_shuffle": true } },
            "item": { "uri": "spotify:track:x", "name": "Song", "duration_ms": 210000,
                      "artists": [{ "name": "A" }, { "name": "B" }],
                      "album": { "name": "Album", "images": [{ "url": "https://i.scdn.co/image/abc" }] } }
        });
        let p = player_from(&v, 1000);
        let it = p.item.as_ref().unwrap();
        assert_eq!((it.title.as_str(), it.artists.as_str(), it.album.as_str()), ("Song", "A, B", "Album"));
        assert_eq!(it.art_url.as_deref(), Some("https://i.scdn.co/image/abc"));
        assert!(p.allowed.next && !p.allowed.prev && !p.allowed.shuffle && p.allowed.repeat && p.allowed.play_pause);
        assert_eq!(p.device.as_ref().unwrap().volume, Some(65));
        assert!(p.shuffle && p.smart_shuffle && differs(&Player { smart_shuffle: false, ..p.clone() }, &p));
        let ad = player_from(&json!({ "currently_playing_type": "ad", "is_playing": true, "item": null }), 0);
        assert_eq!(ad.item.unwrap().title, "Advertisement");
        let fixed = device_from(&json!({ "id": "p", "supports_volume": false, "volume_percent": 30 }));
        assert_eq!(fixed.volume, None);
    }

    #[test]
    fn drift_threshold() {
        let a = Player { playing: true, progress_ms: 10_000, updated_at: 0, ..Default::default() };
        let near = Player { progress_ms: 11_200, updated_at: 1000, ..a.clone() };
        let jump = Player { progress_ms: 40_000, updated_at: 1000, ..a.clone() };
        assert!(!differs(&a, &near));
        assert!(differs(&a, &jump));
    }

    #[test]
    fn artwork_hosts() {
        assert!(art_host_ok("https://i.scdn.co/image/ab67616d0000b273"));
        assert!(art_host_ok("https://image-cdn-ak.spotifycdn.com/image/x"));
        assert!(!art_host_ok("http://i.scdn.co/image/x"));
        assert!(!art_host_ok("https://evil.example/i.scdn.co/x"));
        assert!(!art_host_ok("https://i.scdn.co.evil.example/x"));
        assert!(!art_host_ok("https://evil.example?.scdn.co/x"));
        assert!(!art_host_ok("https://user@i.scdn.co/x"));
    }

    #[test]
    fn netease_fallback_picks_the_original_recording_and_drops_credits() {
        let line = |t: &str| Line { time_ms: 0, text: t.into() };
        let romanized = Lyrics::Ready(Arc::new((0..6).map(|_| line("Neo mwonde jakku saenggakna jajonsim sanghae aega ta eolguri tteugeopgo")).collect()));
        let english = Lyrics::Ready(Arc::new((0..6).map(|_| line("Baby come into me it's raining raining you can always come into me")).collect()));
        assert!(wants_original_script(&romanized, "As If It's Your Last", "BLACKPINK"));
        assert!(!wants_original_script(&english, "Umbrella", "Rihanna"));
        assert!(wants_original_script(&english, "행복 (Happiness)", "Red Velvet"));
        assert!(wants_original_script(&Lyrics::None, "Song", "Artist"));
        assert!(!wants_original_script(&Lyrics::Instrumental, "Song", "Artist"));
        let song = |id: u64, name: &str, artist: &str, s: u64| json!({ "id": id, "name": name, "artists": [{ "name": artist }], "duration": s * 1000 });
        let found = json!({ "result": { "songs": [
            song(1, "As If It's Your Last (마지막처럼) (Live)", "BLACKPINK", 213),
            song(2, "AS IF IT'S YOUR LAST (Japanese Ver.)", "BLACKPINK", 212),
            song(3, "마지막처럼 (Cover BLACKPINK)", "Blue.D", 213),
            song(4, "마지막처럼", "BLACKPINK", 213),
        ] } });
        assert_eq!(netease_pick(&found, "As If It's Your Last", "BLACKPINK", 213), Some(4));
        assert_eq!(netease_pick(&found, "As If It's Your Last", "BLACKPINK", 240), None);
        assert!(is_credit("作词 : Teddy/BrotherSu"));
        assert!(!is_credit("너 뭔데 자꾸 생각나"));
        assert!(!is_credit("Baby: come here"));
    }

    #[test]
    fn lyrics_search_cleanup_and_closest_length() {
        assert_eq!(clean_title("Song (feat. X) - Remastered 2011"), "Song");
        assert_eq!(clean_title("Song [Live] (Radio Edit)"), "Song");
        assert_eq!(clean_title("(Untitled)"), "(Untitled)");
        let found = json!([
            { "duration": 191.9, "syncedLyrics": "[00:01.00] far" },
            { "duration": 203.0, "syncedLyrics": "[00:01.00] near" },
            { "duration": 202.0, "syncedLyrics": null, "plainLyrics": "plain" },
        ]);
        match closest(&found, 202) {
            Some(Lyrics::Ready(l)) => assert_eq!(l[0].text, "near"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(closest(&found, 230).is_none());
    }

    #[test]
    fn lyrics_selection() {
        assert_eq!(lyrics_from(&json!({ "instrumental": true })), Some(Lyrics::Instrumental));
        assert_eq!(lyrics_from(&json!({ "syncedLyrics": null, "plainLyrics": "x" })), None);
        match lyrics_from(&json!({ "syncedLyrics": "[00:01.00] Hi" })) {
            Some(Lyrics::Ready(l)) => assert_eq!(l[0].text, "Hi"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn queue_parsing_keeps_five_with_mid_size_covers() {
        let track = |n: u32| json!({ "type": "track", "name": format!("T{n}"), "artists": [{ "name": "A" }, { "name": "B" }],
            "album": { "images": [{ "url": "https://i.scdn.co/640", "width": 640 }, { "url": "https://i.scdn.co/300", "width": 300 }, { "url": "https://i.scdn.co/64", "width": 64 }] } });
        let episode = json!({ "type": "episode", "name": "E", "show": { "name": "Show" }, "images": [{ "url": "https://i.scdn.co/e", "width": 640 }] });
        let q = upcoming_from(&json!({ "queue": [track(1), episode, track(3), track(4), track(5), track(6)] }));
        assert_eq!(q.len(), QUEUE_LEN);
        assert_eq!((q[0].title.as_str(), q[0].artists.as_str(), q[0].art_url.as_deref()), ("T1", "A, B", Some("https://i.scdn.co/300")));
        assert_eq!((q[1].artists.as_str(), q[1].art_url.as_deref()), ("Show", Some("https://i.scdn.co/e")));
        assert!(upcoming_from(&json!({})).is_empty());
    }

    #[test]
    fn external_fetches_do_not_follow_redirects() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/start", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert_eq!(direct_get(&url).unwrap().status(), 302);
        server.join().unwrap();
    }
}
