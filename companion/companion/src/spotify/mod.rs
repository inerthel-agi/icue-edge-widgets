//! Feature: Spotify for the XENEON EDGE Spotify widget (Web API, the user's own Spotify app).
//! Snapshot `spotify/1`: track, artwork and lyrics shown together share one revision `rev`;
//! artwork and lyrics fetched for an older revision are dropped. Commands are an allowlist.
pub mod api;
pub mod auth;

use crate::util::{now_ms, SEC};
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};

pub const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const HEARTBEAT_MS: u64 = 5 * SEC;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Status {
    #[default]
    NotConfigured,
    Connecting,
    Connected,
    NeedsLogin,
    PremiumRequired,
    Error,
}

impl Status {
    pub fn word(self) -> &'static str {
        match self {
            Status::NotConfigured => "not_configured",
            Status::Connecting => "connecting",
            Status::Connected => "connected",
            Status::NeedsLogin => "needs_login",
            Status::PremiumRequired => "premium_required",
            Status::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub active: bool,
    pub volume: Option<u8>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Item {
    /// Spotify URI, or a stand-in for ads and unknown items.
    pub key: String,
    pub kind: String,
    pub title: String,
    pub artists: String,
    pub album: String,
    pub art_url: Option<String>,
    pub duration_ms: u64,
}

/// Actions Spotify currently allows (from `actions.disallows`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Allowed {
    pub play_pause: bool,
    pub next: bool,
    pub prev: bool,
    pub seek: bool,
    pub shuffle: bool,
    pub repeat: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Player {
    pub item: Option<Item>,
    pub playing: bool,
    pub progress_ms: u64,
    pub updated_at: u64,
    pub shuffle: bool,
    /// Smart Shuffle keeps `shuffle_state` true, so it is tracked on its own to refresh Up next.
    pub smart_shuffle: bool,
    pub repeat: String,
    pub device: Option<Device>,
    pub allowed: Allowed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub time_ms: u64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub enum Lyrics {
    #[default]
    None,
    Loading,
    Instrumental,
    Ready(Arc<Vec<Line>>),
}

pub struct Art {
    pub rev: u64,
    pub mime: &'static str,
    pub bytes: Arc<Vec<u8>>,
}

/// One upcoming track from /me/player/queue, with its small cover once downloaded.
#[derive(Clone, Debug, PartialEq)]
pub struct Upcoming {
    pub title: String,
    pub artists: String,
    pub art_url: Option<String>,
}

/// Upcoming tracks shown by the widget.
pub const QUEUE_LEN: usize = 5;

/// The Spotify app's own Windows media session, as the media thread last read it. It tells the poller at
/// once when the music changes, and stands in for the Web API while Spotify rate-limits the app.
#[derive(Clone)]
pub struct Local {
    pub session_id: String,
    pub rev: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub updated_at: u64,
    /// Play/pause, next, previous, as Windows allows them.
    pub caps: (bool, bool, bool),
    pub art: Option<(&'static str, Arc<Vec<u8>>)>,
    pub lyrics: Lyrics,
}

/// Local revisions live above this, so their artwork URLs never collide with Web API ones.
const LOCAL_REV: u64 = 1 << 40;

#[derive(Default)]
pub struct State {
    pub version: u64,
    pub status: Status,
    pub message: Option<String>,
    pub client_id: Option<String>,
    pub account: Option<(String, String)>,
    pub scopes: Vec<String>,
    pub player: Option<Player>,
    pub devices: Vec<Device>,
    pub rev: u64,
    pub art: Option<Art>,
    pub art_pending: bool,
    pub lyrics: Lyrics,
    pub queue: Vec<Upcoming>,
    /// Bumped whenever `queue` changes; cover URLs carry it so a widget never shows a stale cover.
    pub queue_rev: u64,
    pub queue_art: Vec<Option<(&'static str, Arc<Vec<u8>>)>>,
    pub last_seen: u64,
    pub rate_limited_until: Option<u64>,
    /// Device and volume a muted multi-track skip could not restore (a 429 mid-skip); the poller restores it once Spotify answers again.
    pub restore_volume: Option<(String, u8)>,
    pub pending: Option<auth::Pending>,
    pub tokens: Option<auth::Tokens>,
    /// Set by commands and sign-in so the poller runs at once.
    pub poke: bool,
    pub local: Option<Local>,
    local_seen: u64,
    published_at: u64,
}

pub struct Hub {
    pub state: Mutex<State>,
    pub changed: Condvar,
}

pub static HUB: LazyLock<Hub> = LazyLock::new(|| Hub { state: Mutex::new(State::default()), changed: Condvar::new() });

pub fn lock() -> MutexGuard<'static, State> {
    HUB.state.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn publish(st: &mut State) {
    st.version += 1;
    st.published_at = now_ms();
    HUB.changed.notify_all();
}

/// Publishes on change, or as a heartbeat so widgets can tell fresh data from stale data.
pub fn publish_if(st: &mut State, changed: bool) {
    if changed || now_ms() >= st.published_at + HEARTBEAT_MS {
        publish(st);
    }
}

/// Loads a previous sign-in (client id + encrypted refresh token) at start.
pub fn init() {
    let mut st = lock();
    match auth::load() {
        Some((client_id, Some(refresh))) => {
            st.client_id = Some(client_id);
            st.tokens = Some(auth::Tokens { access: String::new(), expires_at: 0, refresh });
            st.status = Status::Connecting;
        }
        Some((client_id, None)) => {
            st.client_id = Some(client_id);
            st.status = Status::NeedsLogin;
        }
        None => st.status = Status::NotConfigured,
    }
    st.rate_limited_until = api::saved_ban();
    publish(&mut st);
}

pub fn disconnect() {
    auth::disconnect();
}

fn device_json(d: &Device) -> Value {
    json!({ "id": d.id, "name": d.name, "type": d.kind, "active": d.active, "volume": d.volume })
}

/// What the widget receives. Tokens, client id and account details are never included.
fn banned(st: &State) -> bool {
    st.rate_limited_until.is_some_and(|t| t > now_ms())
}

/// Records the Spotify app's Windows session (None: Spotify is not open on this PC).
pub fn set_local(local: Option<Local>, now: u64) {
    let mut st = lock();
    let key = |l: &Option<Local>| l.as_ref().map(|l| (l.rev, l.playing));
    let moved = key(&st.local) != key(&local);
    let shown = moved
        || st.local.as_ref().zip(local.as_ref()).is_some_and(|(a, b)| {
            a.position_ms != b.position_ms || a.art.is_some() != b.art.is_some() || a.lyrics != b.lyrics || a.caps != b.caps
        });
    st.local = local;
    st.local_seen = now;
    if banned(&st) {
        // The widget runs on these readings until the ban ends; the heartbeat keeps them fresh.
        publish_if(&mut st, shown);
    } else if moved && matches!(st.status, Status::Connected | Status::PremiumRequired) {
        // A new track, a pause or a play: read the Web API now instead of at the next slow poll.
        // Spotify updates its Web API a moment after the app, hence the short delay.
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            let mut st = lock();
            st.poke = true;
            HUB.changed.notify_all();
        });
    } else {
        publish_if(&mut st, false);   // heartbeat only: keeps lastSeen fresh between slow polls
    }
}

/// While Spotify rate-limits the app, play/pause and skips go to the Spotify app through Windows.
/// Returns the Windows media command to run instead, or None to use the Web API as usual.
pub fn local_command(st: &State, body: &Value) -> Option<Value> {
    let l = st.local.as_ref().filter(|_| banned(st))?;
    let cmd = body["cmd"].as_str().filter(|c| matches!(*c, "playPause" | "next" | "prev"))?;
    // The widget's rev for local data is LOCAL_REV + l.rev; any other rev names a track no longer shown, so media::resolve refuses the skip.
    let rev = body["rev"].as_u64().map_or(l.rev, |r| r.checked_sub(LOCAL_REV).unwrap_or(u64::MAX));
    Some(json!({ "cmd": cmd, "sessionId": l.session_id, "rev": rev }))
}

/// The widget's snapshot built from the Spotify app's Windows session (no queue, devices, volume or modes).
fn local_snapshot(st: &State, l: &Local) -> Value {
    let rev = LOCAL_REV + l.rev;
    json!({
        "schema": "spotify/1",
        "source": { "kind": "companion", "connected": true, "lastSeen": st.local_seen, "local": true },
        "account": { "status": st.status.word(), "message": st.message },
        "device": Value::Null,
        "devices": [],
        "item": {
            "id": format!("local:{}", l.session_id), "rev": rev, "type": "track",
            "title": l.title, "artists": l.artist, "album": l.album,
            "art": l.art.as_ref().map(|_| json!({ "url": format!("/api/spotify/art?r={rev}") })),
            "artState": if l.art.is_some() { "ready" } else { "none" },
            "duration": l.duration_ms as f64 / 1000.0,
        },
        "playback": { "playing": l.playing, "position": l.position_ms as f64 / 1000.0, "updatedAt": l.updated_at, "shuffle": false, "repeat": "off" },
        "actions": { "playPause": l.caps.0, "next": l.caps.1, "prev": l.caps.2, "seek": false, "shuffle": false, "repeat": false, "volume": false },
        "rateLimitedUntil": st.rate_limited_until.filter(|&t| t > now_ms()),
        "lyrics": lyrics_json(&l.lyrics),
        "queueRev": st.queue_rev,
        "queue": [],
    })
}

pub fn snapshot(st: &State) -> Value {
    if let Some(l) = st.local.as_ref().filter(|_| banned(st)) {
        return local_snapshot(st, l);
    }
    let p = st.player.as_ref();
    let item = p.and_then(|p| p.item.as_ref()).map(|it| {
        json!({
            "id": it.key,
            "rev": st.rev,
            "type": it.kind,
            "title": it.title,
            "artists": it.artists,
            "album": it.album,
            "art": st.art.as_ref().filter(|a| a.rev == st.rev).map(|a| json!({ "url": format!("/api/spotify/art?r={}", a.rev) })),
            "artState": if st.art.as_ref().is_some_and(|a| a.rev == st.rev) { "ready" } else if st.art_pending { "pending" } else { "none" },
            "duration": it.duration_ms as f64 / 1000.0,
        })
    });
    let allowed = p.map(|p| p.allowed).unwrap_or_default();
    let device = p.and_then(|p| p.device.as_ref());
    let lyrics = lyrics_json(&st.lyrics);
    json!({
        "schema": "spotify/1",
        // Between the slower Web API readings, the Spotify app's Windows session vouches that nothing changed.
        "source": { "kind": "companion", "connected": true, "lastSeen": if st.local.is_some() { st.last_seen.max(st.local_seen) } else { st.last_seen } },
        "account": { "status": st.status.word(), "message": st.message },
        "device": device.map(device_json),
        "devices": st.devices.iter().map(device_json).collect::<Vec<_>>(),
        "item": item,
        "playback": p.map(|p| json!({
            "playing": p.playing, "position": p.progress_ms as f64 / 1000.0, "updatedAt": p.updated_at,
            "shuffle": p.shuffle, "repeat": p.repeat,
        })),
        "actions": {
            "playPause": allowed.play_pause, "next": allowed.next, "prev": allowed.prev, "seek": allowed.seek,
            "shuffle": allowed.shuffle, "repeat": allowed.repeat,
            "volume": device.is_some_and(|d| d.volume.is_some()),
        },
        "rateLimitedUntil": st.rate_limited_until.filter(|&t| t > now_ms()),
        "lyrics": lyrics,
        "queueRev": st.queue_rev,
        "queue": st.queue.iter().enumerate().map(|(i, q)| json!({
            "title": q.title,
            "artist": q.artists,
            "art": st.queue_art.get(i).and_then(Option::as_ref).map(|_| json!({ "url": format!("/api/spotify/queue-art?i={i}&q={}", st.queue_rev) })),
        })).collect::<Vec<_>>(),
    })
}

/// The queue as the Now Playing widget shows it, only while `title` is the track Spotify reports as
/// playing: the queue of another track must never sit under this one.
pub fn queue_for(title: &str) -> Option<Value> {
    let st = lock();
    let playing = st.player.as_ref()?.item.as_ref()?;
    let live = matches!(st.status, Status::Connected | Status::PremiumRequired);
    if !live || st.queue.is_empty() || !playing.title.trim().eq_ignore_ascii_case(title.trim()) {
        return None;
    }
    Some(json!({
        "rev": st.queue_rev,
        // What `skipTo` must carry as `rev`, so the Now Playing widget can skip to a row without the Spotify feed.
        "spotifyRev": st.rev,
        "items": st.queue.iter().enumerate().map(|(i, q)| json!({
            "title": q.title,
            "artist": q.artists,
            "art": st.queue_art.get(i).and_then(Option::as_ref).map(|_| json!({ "url": format!("/api/spotify/queue-art?i={i}&q={}", st.queue_rev) })),
        })).collect::<Vec<_>>(),
    }))
}

pub fn queue_art_for(st: &State, index: usize, queue_rev: u64) -> Option<(&'static str, Arc<Vec<u8>>)> {
    (queue_rev == st.queue_rev).then(|| st.queue_art.get(index)?.as_ref().map(|(m, b)| (*m, Arc::clone(b)))).flatten()
}

/// What the companion window shows. Only the last 4 characters of the client id leave the store.
pub fn page(st: &State) -> Value {
    let p = st.player.as_ref();
    let it = p.and_then(|p| p.item.as_ref());
    json!({
        "status": st.status.word(),
        "message": st.message,
        "pending": st.pending.is_some(),
        "clientIdTail": st.client_id.as_deref().map(|c| c[c.len().saturating_sub(4)..].to_string()),
        "redirectUri": auth::REDIRECT_URI,
        "account": st.account.as_ref().map(|(name, product)| json!({ "name": name, "product": product })),
        "scopes": st.scopes,
        "device": p.and_then(|p| p.device.as_ref()).map(device_json),
        "item": it.map(|i| json!({ "title": i.title, "artists": i.artists, "playing": p.is_some_and(|p| p.playing) })),
        "lastSeen": st.last_seen,
        "rateLimitedUntil": st.rate_limited_until.filter(|&t| t > now_ms()),
        // What the widget follows during a wait: the Spotify app's Windows session.
        "local": st.local.as_ref().filter(|_| banned(st)).map(|l| json!({ "title": l.title, "artists": l.artist, "playing": l.playing })),
        "lyrics": match &st.lyrics { Lyrics::Ready(_) => "ready", Lyrics::Loading => "loading", Lyrics::Instrumental => "instrumental", Lyrics::None => "none" },
    })
}

/// The cover of the track the Web API shows, when it is the one the Windows session names. The Spotify app
/// often publishes no thumbnail to Windows, so Now Playing borrows this one.
pub fn art_matching(title: &str, artist: &str) -> Option<Vec<u8>> {
    let st = lock();
    let item = st.player.as_ref()?.item.as_ref()?;
    let first = artist.split(&[',', ';', '&'][..]).next().unwrap_or("").trim().to_lowercase();
    let same = item.title.trim().eq_ignore_ascii_case(title.trim()) && (first.is_empty() || item.artists.to_lowercase().contains(&first));
    let art = st.art.as_ref().filter(|a| a.rev == st.rev)?;
    same.then(|| art.bytes.as_ref().clone())
}

pub fn art_for(st: &State, rev: u64) -> Option<(&'static str, Arc<Vec<u8>>)> {
    if rev >= LOCAL_REV {
        return st.local.as_ref().filter(|l| LOCAL_REV + l.rev == rev).and_then(|l| l.art.clone());
    }
    st.art.as_ref().filter(|a| a.rev == rev && rev == st.rev).map(|a| (a.mime, Arc::clone(&a.bytes)))
}

/// One Web API call derived from a widget command.
#[derive(Debug, PartialEq)]
pub struct Call {
    pub method: &'static str,
    pub path: String,
    pub body: Option<String>,
    /// How many times to send it: `skipTo` is that many "next" in a row (Spotify has no jump-to-queue-item).
    pub times: u8,
    /// Volume to restore after a multi-track skip, which runs muted so the skipped tracks are not heard.
    pub muted_from: Option<u8>,
}

/// Validates a widget command against the state. Errors are (HTTP status, code).
pub fn resolve(st: &State, body: &Value) -> Result<Call, (u16, &'static str)> {
    if st.status != Status::Connected {
        return Err((409, "not_connected"));
    }
    if st.rate_limited_until.is_some_and(|t| t > now_ms()) {
        return Err((429, "rate_limited"));
    }
    let cmd = body["cmd"].as_str().ok_or((400, "bad_request"))?;
    let p = st.player.as_ref();
    let a = p.map(|p| p.allowed).unwrap_or_default();
    // Skips and seeks aimed at a track that already changed are refused, never replayed.
    let current = |need: bool| -> Result<(), (u16, &'static str)> {
        if !need {
            return Err((422, "unsupported"));
        }
        if body["rev"].as_u64() != Some(st.rev) {
            return Err((409, "track_changed"));
        }
        Ok(())
    };
    let call = |method: &'static str, path: String| Call { method, path, body: None, times: 1, muted_from: None };
    Ok(match cmd {
        "playPause" => {
            if !a.play_pause {
                return Err((422, "unsupported"));
            }
            if p.is_some_and(|p| p.playing) { call("PUT", "/me/player/pause".into()) } else { call("PUT", "/me/player/play".into()) }
        }
        "next" => {
            current(a.next)?;
            call("POST", "/me/player/next".into())
        }
        // Tap on an up-next row: skip forward to it. The list the widget saw must still be current.
        "skipTo" => {
            current(a.next)?;
            if body["q"].as_u64() != Some(st.queue_rev) {
                return Err((409, "queue_changed"));
            }
            let i = body["value"].as_u64().filter(|&i| (i as usize) < st.queue.len()).ok_or((400, "bad_request"))?;
            let volume = p.and_then(|p| p.device.as_ref()).and_then(|d| d.volume).filter(|&v| i > 0 && v > 0);
            Call { times: i as u8 + 1, muted_from: volume, ..call("POST", "/me/player/next".into()) }
        }
        "prev" => {
            current(a.prev)?;
            call("POST", "/me/player/previous".into())
        }
        "seek" => {
            current(a.seek)?;
            let v = body["value"].as_f64().filter(|v| v.is_finite() && *v >= 0.0).ok_or((400, "bad_request"))?;
            let max = p.and_then(|p| p.item.as_ref()).map_or(0, |i| i.duration_ms);
            call("PUT", format!("/me/player/seek?position_ms={}", ((v * 1000.0) as u64).min(max)))
        }
        "shuffle" => {
            if !a.shuffle {
                return Err((422, "unsupported"));
            }
            let on = body["value"].as_bool().ok_or((400, "bad_request"))?;
            call("PUT", format!("/me/player/shuffle?state={on}"))
        }
        "repeat" => {
            if !a.repeat {
                return Err((422, "unsupported"));
            }
            let mode = body["value"].as_str().filter(|m| ["off", "context", "track"].contains(m)).ok_or((400, "bad_request"))?;
            call("PUT", format!("/me/player/repeat?state={mode}"))
        }
        "volume" => {
            if !p.and_then(|p| p.device.as_ref()).is_some_and(|d| d.volume.is_some()) {
                return Err((422, "unsupported"));
            }
            let v = body["value"].as_f64().filter(|v| v.is_finite()).ok_or((400, "bad_request"))?;
            call("PUT", format!("/me/player/volume?volume_percent={}", v.round().clamp(0.0, 100.0) as u8))
        }
        "transfer" => {
            let id = body["deviceId"].as_str().ok_or((400, "bad_request"))?;
            // Only a device Spotify listed for this account; the id never reaches a URL.
            let d = st.devices.iter().find(|d| d.id == id).ok_or((404, "device_gone"))?;
            Call { method: "PUT", path: "/me/player".into(), body: Some(json!({ "device_ids": [d.id], "play": true }).to_string()), times: 1, muted_from: None }
        }
        _ => return Err((400, "unknown_command")),
    })
}

/// Wire shape of lyrics, shared by the Spotify and the media snapshots.
pub fn lyrics_json(l: &Lyrics) -> Value {
    match l {
        Lyrics::None => json!({ "state": "none" }),
        Lyrics::Loading => json!({ "state": "loading" }),
        Lyrics::Instrumental => json!({ "state": "instrumental" }),
        Lyrics::Ready(lines) => json!({ "state": "ready", "lines": lines.iter().map(|l| json!({ "timeMs": l.time_ms, "text": l.text })).collect::<Vec<_>>() }),
    }
}

/// Parses LRC text (`[mm:ss.xx] line`) into timed lines.
pub fn parse_lrc(raw: &str) -> Vec<Line> {
    let mut lines: Vec<Line> = raw
        .lines()
        .filter_map(|l| {
            let rest = l.trim().strip_prefix('[')?;
            let (stamp, text) = rest.split_once(']')?;
            let (m, s) = stamp.split_once(':')?;
            let ms = m.trim().parse::<u64>().ok()?.checked_mul(60_000)?.checked_add((s.trim().parse::<f64>().ok()? * 1000.0) as u64)?;
            Some(Line { time_ms: ms, text: text.trim().to_string() })
        })
        .collect();
    lines.sort_by_key(|l| l.time_ms);
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected() -> State {
        State {
            status: Status::Connected,
            rev: 7,
            player: Some(Player {
                item: Some(Item { key: "spotify:track:1".into(), kind: "track".into(), duration_ms: 200_000, ..Default::default() }),
                playing: true,
                repeat: "off".into(),
                device: Some(Device { id: "d1".into(), volume: Some(40), active: true, ..Default::default() }),
                allowed: Allowed { play_pause: true, next: true, prev: true, seek: true, shuffle: true, repeat: false },
                ..Default::default()
            }),
            devices: vec![Device { id: "d1".into(), ..Default::default() }],
            ..Default::default()
        }
    }

    #[test]
    fn the_windows_session_stands_in_only_during_a_ban() {
        let mut st = connected();
        st.local = Some(Local {
            session_id: "m-1".into(), rev: 3, title: "RBB".into(), artist: "Red Velvet".into(), album: String::new(),
            playing: true, position_ms: 34_000, duration_ms: 187_000, updated_at: 1, caps: (true, true, false),
            art: Some(("image/png", Arc::new(vec![1, 2, 3]))), lyrics: Lyrics::None,
        });
        let play = json!({ "cmd": "playPause" });
        assert!(local_command(&st, &play).is_none());
        assert_ne!(snapshot(&st)["item"]["title"], "RBB");
        st.rate_limited_until = Some(now_ms() + 60 * SEC);
        let snap = snapshot(&st);
        assert_eq!((snap["item"]["title"].as_str(), snap["source"]["local"].as_bool(), snap["actions"]["prev"].as_bool()), (Some("RBB"), Some(true), Some(false)));
        assert_eq!(local_command(&st, &play), Some(json!({ "cmd": "playPause", "sessionId": "m-1", "rev": 3 })));
        assert!(local_command(&st, &json!({ "cmd": "volume", "value": 10 })).is_none());
        let rev = snap["item"]["rev"].as_u64().unwrap();
        assert!(art_for(&st, rev).is_some() && art_for(&st, rev + 1).is_none());
    }

    #[test]
    fn local_skips_refuse_a_track_the_widget_no_longer_shows() {
        use crate::media::{self, Caps, Meta, Modes, Observed, Playback, Thumb};
        let mut m = media::State::new();
        let o = Observed {
            app_id: "Spotify.exe".into(), ordinal: 0, meta: Meta { title: "B".into(), ..Default::default() }, playback: Playback::Playing,
            timeline: None, caps: Caps { play_pause: true, next: true, ..Default::default() }, modes: Modes::default(), thumb: Thumb::Missing,
        };
        media::merge(&mut m, vec![o], None, 0);
        let (id, rev) = (m.sessions[0].id.clone(), m.sessions[0].rev);
        let mut st = connected();
        st.rate_limited_until = Some(now_ms() + 60 * SEC);
        st.local = Some(Local {
            session_id: id, rev, title: "B".into(), artist: String::new(), album: String::new(), playing: true, position_ms: 0,
            duration_ms: 0, updated_at: 0, caps: (true, true, false), art: None, lyrics: Lyrics::None,
        });
        let run = |body: Value| media::resolve(&m, &local_command(&st, &body).unwrap(), 0).map(|t| t.action);
        assert_eq!(run(json!({ "cmd": "next", "rev": LOCAL_REV + rev })), Ok(media::Action::Next));
        assert_eq!(run(json!({ "cmd": "next", "rev": LOCAL_REV + rev - 1 })), Err((409, "track_changed")));
        assert_eq!(run(json!({ "cmd": "next", "rev": 7 })), Err((409, "track_changed")), "a Web API rev is not this track");
        assert_eq!(run(json!({ "cmd": "next" })), Ok(media::Action::Next), "no rev: as before");
    }

    #[test]
    fn commands_are_an_allowlist() {
        let st = connected();
        let r = |v: Value| resolve(&st, &v);
        assert_eq!(r(json!({ "cmd": "playPause" })).unwrap().path, "/me/player/pause");
        assert_eq!(r(json!({ "cmd": "next", "rev": 6 })).unwrap_err(), (409, "track_changed"));
        assert_eq!(r(json!({ "cmd": "next", "rev": 7 })).unwrap().method, "POST");
        assert_eq!(r(json!({ "cmd": "seek", "rev": 7, "value": 999 })).unwrap().path, "/me/player/seek?position_ms=200000");
        assert_eq!(r(json!({ "cmd": "repeat", "value": "track" })).unwrap_err(), (422, "unsupported"));
        assert_eq!(r(json!({ "cmd": "shuffle", "value": "yes" })).unwrap_err(), (400, "bad_request"));
        assert_eq!(r(json!({ "cmd": "volume", "value": 140 })).unwrap().path, "/me/player/volume?volume_percent=100");
        assert_eq!(r(json!({ "cmd": "transfer", "deviceId": "../../me" })).unwrap_err(), (404, "device_gone"));
        assert_eq!(r(json!({ "cmd": "transfer", "deviceId": "d1" })).unwrap().body.unwrap(), r#"{"device_ids":["d1"],"play":true}"#);
        assert_eq!(r(json!({ "cmd": "delete" })).unwrap_err(), (400, "unknown_command"));
        let mut q = connected();
        q.queue = vec![Upcoming { title: "A".into(), artists: "X".into(), art_url: None }, Upcoming { title: "B".into(), artists: "Y".into(), art_url: None }];
        q.queue_rev = 4;
        let skip = |v: Value| resolve(&q, &v);
        assert_eq!(skip(json!({ "cmd": "skipTo", "rev": 7, "q": 4, "value": 1 })).unwrap().times, 2);
        // Skipping over tracks runs muted and restores the device volume; a single skip is not muted.
        assert_eq!(skip(json!({ "cmd": "skipTo", "rev": 7, "q": 4, "value": 1 })).unwrap().muted_from, Some(40));
        assert_eq!(skip(json!({ "cmd": "skipTo", "rev": 7, "q": 4, "value": 0 })).unwrap().muted_from, None);
        assert_eq!(skip(json!({ "cmd": "skipTo", "rev": 7, "q": 3, "value": 1 })).unwrap_err(), (409, "queue_changed"));
        assert_eq!(skip(json!({ "cmd": "skipTo", "rev": 7, "q": 4, "value": 2 })).unwrap_err(), (400, "bad_request"));
        assert_eq!(skip(json!({ "cmd": "skipTo", "rev": 6, "q": 4, "value": 0 })).unwrap_err(), (409, "track_changed"));
        let mut off = connected();
        off.status = Status::NeedsLogin;
        assert_eq!(resolve(&off, &json!({ "cmd": "playPause" })).unwrap_err(), (409, "not_connected"));
    }

    #[test]
    fn snapshot_never_carries_secrets_and_art_follows_rev() {
        let mut st = connected();
        st.client_id = Some("0f3c9a1d7e5b4c2a8d6e0b1f9a7c3f2a".into());
        st.tokens = Some(auth::Tokens { access: "secret-access".into(), refresh: "secret-refresh".into(), expires_at: 0 });
        st.art = Some(Art { rev: 6, mime: "image/jpeg", bytes: Arc::new(vec![1]) });
        let text = snapshot(&st).to_string();
        assert!(!text.contains("secret") && !text.contains("0f3c9a1d"));
        assert_eq!(snapshot(&st)["item"]["art"], Value::Null, "art of an older revision is not offered");
        assert!(art_for(&st, 6).is_none());
        assert_eq!(page(&st)["clientIdTail"], "3f2a");
    }

    #[test]
    fn queue_is_shared_only_under_the_track_it_belongs_to() {
        {
            let mut st = lock();
            *st = connected();
            st.player.as_mut().unwrap().item.as_mut().unwrap().title = "Best Song Ever".into();
            st.queue = vec![Upcoming { title: "Sienna".into(), artists: "The Marias".into(), art_url: None }];
            st.queue_rev = 3;
        }
        let q = queue_for(" best song ever ").expect("queue for the playing track");
        assert_eq!(q["rev"], 3);
        assert_eq!(q["items"][0]["title"], "Sienna");
        assert!(queue_for("Another Song").is_none());
        lock().status = Status::NeedsLogin;
        assert!(queue_for("Best Song Ever").is_none());
        *lock() = State::default();
    }

    #[test]
    fn lrc_parsing() {
        let lines = parse_lrc("[00:12.50] Second\n[00:01.00]First\nno stamp\n[01:02.3] Third\n[00:05.00]");
        assert_eq!(lines.iter().map(|l| l.time_ms).collect::<Vec<_>>(), vec![1000, 5000, 12500, 62300]);
        assert_eq!(lines[0].text, "First");
        assert_eq!(lines[1].text, "");
        // A huge minute count from LRCLIB is dropped, not wrapped or panicking.
        assert!(parse_lrc("[99999999999999999:00.00] x").is_empty());
    }
}
