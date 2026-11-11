//! Feature: what is playing on Windows (media sessions → Now Playing widget).
//! One snapshot (`media/1`) describes one session at one metadata revision: the title, the
//! artwork and the commands shown together always share the same session id and `rev`, so an
//! old cover or a command aimed at the previous track is never mixed with the new one.
use crate::util::{now_ms, pseudonym, random_hex, SEC};
use crate::spotify::Lyrics;
use serde_json::{json, Value};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};

#[cfg(windows)]
mod gsmtc;
#[cfg(windows)]
pub mod volume;
pub mod viz;
pub mod relay;

/// A thumbnail identical to the previous track's may simply not be updated yet by the player.
pub const ART_SETTLE_MS: u64 = 3 * SEC;
/// Players can update a thumbnail late without changing the title; it is re-read this often.
const ART_RECHECK_MS: u64 = 10 * SEC;
pub const MAX_ART_BYTES: usize = 4 * 1024 * 1024;
/// Widgets treat data older than 10 s as stale, so an unchanged state is still re-sent.
const HEARTBEAT_MS: u64 = 5 * SEC;
const STALE_MS: u64 = 10 * SEC;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Playback {
    #[default]
    Unknown,
    Playing,
    Paused,
    Stopped,
}

impl Playback {
    fn word(self) -> &'static str {
        match self {
            Playback::Unknown => "unknown",
            Playback::Playing => "playing",
            Playback::Paused => "paused",
            Playback::Stopped => "stopped",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Caps {
    pub play_pause: bool,
    pub next: bool,
    pub prev: bool,
    pub seek: bool,
    pub shuffle: bool,
    pub repeat: bool,
}

/// Shuffle and repeat as the player reports them (None: not reported). Repeat: 0 off, 1 track, 2 list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Modes {
    pub shuffle: Option<bool>,
    pub repeat: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Meta {
    pub title: String,
    pub artist: String,
    pub album: String,
}

/// Position as reported at `updated_at` (ms since epoch); widgets extrapolate while playing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Timeline {
    pub position_ms: u64,
    pub duration_ms: Option<u64>,
    pub updated_at: u64,
    pub start_ticks: i64,
}

pub enum Thumb {
    /// Not read this round (nothing suggests it changed).
    Unchanged,
    Missing,
    Image(Vec<u8>),
}

pub struct Observed {
    pub app_id: String,
    pub ordinal: u32,
    pub meta: Meta,
    pub playback: Playback,
    pub timeline: Option<Timeline>,
    pub caps: Caps,
    pub modes: Modes,
    pub thumb: Thumb,
}

#[derive(Clone)]
pub struct Art {
    pub rev: u64,
    pub hash: u64,
    pub mime: &'static str,
    pub bytes: Arc<Vec<u8>>,
}

#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub app_id: String,
    pub ordinal: u32,
    pub meta: Meta,
    pub rev: u64,
    pub playback: Playback,
    pub timeline: Option<Timeline>,
    pub caps: Caps,
    pub modes: Modes,
    pub art: Option<Art>,
    pub art_pending: bool,
    /// None until looked up; reset with every new revision of the track.
    pub lyrics: Option<Lyrics>,
    changed_at: u64,
    art_checked_at: u64,
    prev_art_hash: Option<u64>,
    prev_album: String,
}

#[derive(Default)]
pub struct State {
    pub version: u64,
    pub instance: String,
    pub sessions: Vec<Session>,
    pub current: Option<String>,
    pub manual: Option<String>,
    pub missing_name: Option<String>,
    pub last_seen: u64,
    pub error: Option<String>,
    /// System output volume 0..=100 and mute, when Windows reports them.
    pub volume: Option<(u8, bool)>,
    /// When the sleep timer pauses playback (ms since epoch).
    pub sleep_at: Option<u64>,
    published_at: u64,
    next_rev: u64,
}

pub struct Hub {
    pub state: Mutex<State>,
    pub changed: Condvar,
}

pub static HUB: LazyLock<Hub> = LazyLock::new(|| Hub { state: Mutex::new(State::new()), changed: Condvar::new() });

pub fn lock() -> MutexGuard<'static, State> {
    HUB.state.lock().unwrap_or_else(|e| e.into_inner())
}

impl State {
    pub fn new() -> Self {
        State { instance: random_hex(4), next_rev: 1, ..Default::default() }
    }

    fn publish(&mut self, now: u64) {
        self.version += 1;
        self.published_at = now;
        HUB.changed.notify_all();
    }

    fn find(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.id == id)
    }
}

/// Id of the n-th session a player publishes; salted per companion run.
pub fn session_id(instance: &str, app_id: &str, ordinal: u32) -> String {
    pseudonym("m", instance, &format!("{app_id}#{ordinal}"))
}

/// Readable player name from its AppUserModelId ("Spotify.exe", "Brave.BM6…", "Microsoft.ZuneMusic_…!App").
pub fn app_name(app_id: &str) -> String {
    const KNOWN: [(&str, &str); 8] = [
        ("308046B0AF4A39CB", "Firefox"),
        // Firefox-based browsers publish a hash of their install path instead of a name.
        ("F0DC299D809B9700", "Zen Browser"),
        ("SpotifyAB", "Spotify"),
        ("ZuneMusic", "Media Player"),
        ("ZuneVideo", "Films & TV"),
        ("msedge", "Edge"),
        ("chrome", "Chrome"),
        ("vlc", "VLC"),
    ];
    let base = app_id.split('!').next().unwrap_or(app_id);
    let base = base.split('_').next().unwrap_or(base);
    let base = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".EXE")).unwrap_or(base);
    let parts: Vec<&str> = base.split('.').filter(|p| !p.is_empty()).collect();
    let name = match parts.as_slice() {
        [first, second, ..] if first.eq_ignore_ascii_case("microsoft") => second,
        [first, ..] => first,
        [] => "Media app",
    };
    if let Some((_, known)) = KNOWN.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)) {
        return known.to_string();
    }
    let mut chars = name.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// Image type from its first bytes; anything else is refused.
pub fn sniff(b: &[u8]) -> Option<&'static str> {
    match b {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'B', b'M', ..] => Some("image/bmp"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

/// Whether the watcher should read this session's thumbnail this round.
pub fn wants_thumb(st: &State, app_id: &str, ordinal: u32, meta: &Meta, now: u64) -> bool {
    match st.find(&session_id(&st.instance, app_id, ordinal)) {
        None => true,
        Some(s) => s.meta != *meta || s.art_pending || now < s.changed_at + ART_SETTLE_MS || now >= s.art_checked_at + ART_RECHECK_MS,
    }
}

/// Folds one polling round into the state. Returns whether anything a widget shows changed.
pub fn merge(st: &mut State, observed: Vec<Observed>, current_app: Option<String>, now: u64) -> bool {
    let mut changed = false;
    let mut next = Vec::with_capacity(observed.len());
    for o in observed {
        let id = session_id(&st.instance, &o.app_id, o.ordinal);
        let prev = st.find(&id).cloned();
        let is_new = prev.is_none();
        let mut s = prev.unwrap_or_else(|| Session {
            id,
            app_id: o.app_id.clone(),
            ordinal: o.ordinal,
            meta: Meta::default(),
            rev: 0,
            playback: Playback::Unknown,
            timeline: None,
            caps: Caps::default(),
            modes: Modes::default(),
            art: None,
            art_pending: false,
            lyrics: None,
            changed_at: now,
            art_checked_at: 0,
            prev_art_hash: None,
            prev_album: String::new(),
        });
        if is_new || s.meta != o.meta {
            s.prev_art_hash = s.art.as_ref().map(|a| a.hash);
            s.prev_album = std::mem::take(&mut s.meta.album);
            s.meta = o.meta;
            s.rev = st.next_rev;
            st.next_rev += 1;
            s.art = None;
            s.art_pending = true;
            s.lyrics = None;
            s.changed_at = now;
            changed = true;
        }
        if s.playback != o.playback || s.timeline != o.timeline || s.caps != o.caps || s.modes != o.modes {
            s.playback = o.playback;
            s.timeline = o.timeline;
            s.caps = o.caps;
            s.modes = o.modes;
            changed = true;
        }
        let settling = now < s.changed_at + ART_SETTLE_MS;
        match o.thumb {
            Thumb::Unchanged => {}
            Thumb::Missing => {
                s.art_checked_at = now;
                // A player may publish its thumbnail a moment after the title.
                if s.art.is_some() || s.art_pending != settling {
                    changed = true;
                }
                s.art = None;
                s.art_pending = settling;
            }
            Thumb::Image(bytes) => {
                s.art_checked_at = now;
                let hash = fnv(&bytes);
                if !s.art.as_ref().is_some_and(|a| a.hash == hash) {
                    let same_album = !s.meta.album.is_empty() && s.meta.album == s.prev_album;
                    let maybe_previous = s.prev_art_hash == Some(hash) && !same_album && settling;
                    match sniff(&bytes) {
                        _ if maybe_previous => s.art_pending = true,
                        Some(mime) if bytes.len() <= MAX_ART_BYTES => {
                            s.art = Some(Art { rev: s.rev, hash, mime, bytes: Arc::new(bytes) });
                            s.art_pending = false;
                            changed = true;
                        }
                        _ => {
                            changed |= s.art.is_some() || s.art_pending;
                            s.art = None;
                            s.art_pending = false;
                        }
                    }
                } else if s.art_pending {
                    s.art_pending = false;
                    changed = true;
                }
            }
        }
        next.push(s);
    }
    if st.sessions.len() != next.len() || st.sessions.iter().zip(&next).any(|(a, b)| a.id != b.id) {
        changed = true;
    }
    if let Some(m) = st.manual.clone() {
        let back = next.iter().any(|s| s.id == m);
        if st.missing_name.is_none() && !back {
            // Always Some: a None here (session already cleared) would re-trigger on every poll.
            st.missing_name = Some(st.find(&m).map_or_else(|| "Player".into(), |s| app_name(&s.app_id)));
            changed = true;
        } else if back && st.missing_name.take().is_some() {
            changed = true;
        }
    }
    st.sessions = next;
    let current = current_app.map(|a| session_id(&st.instance, &a, 0));
    if st.current != current {
        st.current = current;
        changed = true;
    }
    changed
}

/// Records a polling round and wakes the widget streams when needed.
pub fn apply(observed: Vec<Observed>, current_app: Option<String>, now: u64) {
    let mut st = lock();
    let mut changed = merge(&mut st, observed, current_app, now);
    changed |= st.error.take().is_some();
    st.last_seen = now;
    // The Spotify app's session (the playing one if there are several) feeds the Spotify widget too.
    let spotify = st.sessions.iter().filter(|s| app_name(&s.app_id) == "Spotify").max_by_key(|s| s.playback == Playback::Playing);
    crate::spotify::set_local(
        spotify.map(|s| crate::spotify::Local {
            session_id: s.id.clone(),
            rev: s.rev,
            title: s.meta.title.clone(),
            artist: s.meta.artist.clone(),
            album: s.meta.album.clone(),
            playing: s.playback == Playback::Playing,
            position_ms: s.timeline.map_or(0, |t| t.position_ms),
            duration_ms: s.timeline.and_then(|t| t.duration_ms).unwrap_or(0),
            updated_at: s.timeline.map_or(now, |t| t.updated_at),
            caps: (s.caps.play_pause, s.caps.next, s.caps.prev),
            art: s.art.as_ref().map(|a| (a.mime, Arc::clone(&a.bytes))),
            lyrics: s.lyrics.clone().unwrap_or_default(),
        }),
        now,
    );
    if changed || now >= st.published_at + HEARTBEAT_MS {
        st.publish(now);
    }
}

pub fn set_error(message: String) {
    let mut st = lock();
    if st.error.as_deref() != Some(message.as_str()) {
        st.error = Some(message);
        st.sessions.clear();
        st.publish(now_ms());
    }
}

/// What to ask LRCLIB for a track, or None when a match would be a guess: the artist and a
/// plausible length are needed (a browser tab titled after a video has neither).
fn lyric_query(meta: &Meta, duration_ms: Option<u64>) -> Option<(String, String, u64)> {
    let secs = duration_ms? / 1000;
    let artist = meta.artist.trim().trim_end_matches(" - Topic").trim();
    (!meta.title.trim().is_empty() && !artist.is_empty() && (30..=1200).contains(&secs)).then(|| (meta.title.trim().to_string(), artist.to_string(), secs))
}

/// Looks up synced lyrics (LRCLIB) for the session on screen, once per track revision.
pub fn run_lyrics() {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let job = {
            let mut st = lock();
            let target = pick(&st)
                .filter(|s| s.lyrics.is_none())
                .and_then(|s| lyric_query(&s.meta, s.timeline.and_then(|t| t.duration_ms)).map(|q| (s.id.clone(), s.rev, s.meta.album.clone(), q)));
            if let Some((id, ..)) = &target {
                if let Some(s) = st.sessions.iter_mut().find(|s| s.id == *id) {
                    s.lyrics = Some(Lyrics::Loading);
                }
                st.publish(now_ms());
            }
            target
        };
        let Some((id, rev, album, (title, artist, secs))) = job else { continue };
        let current = || lock().sessions.iter().any(|s| s.id == id && s.rev == rev);
        let found = crate::spotify::api::lyrics_for(&title, &artist, &album, secs, &current);
        let mut st = lock();
        // A newer revision of the track started meanwhile: this answer is for the old one.
        if let Some(s) = st.sessions.iter_mut().find(|s| s.id == id && s.rev == rev) {
            s.lyrics = Some(found);
            st.publish(now_ms());
        }
    }
}

/// The session shown: the picked one, else a playing one (Windows' current first), else any.
pub fn pick(st: &State) -> Option<&Session> {
    if let Some(id) = &st.manual {
        return st.find(id);
    }
    let current = st.current.as_deref().and_then(|c| st.find(c));
    current
        .filter(|s| s.playback == Playback::Playing)
        .or_else(|| st.sessions.iter().find(|s| s.playback == Playback::Playing))
        .or(current)
        .or_else(|| st.sessions.first())
}

fn session_json(s: &Session) -> Value {
    json!({
        "id": s.id,
        "rev": s.rev,
        "app": { "name": app_name(&s.app_id) },
        "title": s.meta.title,
        "artist": s.meta.artist,
        "album": s.meta.album,
        "playback": s.playback.word(),
        "timeline": s.timeline.map(|t| json!({
            "position": t.position_ms as f64 / 1000.0,
            "duration": t.duration_ms.map(|d| d as f64 / 1000.0),
            "updatedAt": t.updated_at,
        })),
        "caps": { "playPause": s.caps.play_pause, "next": s.caps.next, "prev": s.caps.prev, "seek": s.caps.seek, "shuffle": s.caps.shuffle, "repeat": s.caps.repeat },
        "modes": { "shuffle": s.modes.shuffle, "repeat": s.modes.repeat },
        "art": s.art.as_ref().map(|a| json!({ "url": format!("/api/media/art?s={}&r={}", s.id, a.rev), "sessionId": s.id, "rev": a.rev })),
        "lyrics": s.lyrics.as_ref().map(crate::spotify::lyrics_json),
        "artState": if s.art.is_some() { "ready" } else if s.art_pending { "pending" } else { "none" },
    })
}

pub fn snapshot(st: &State) -> Value {
    let shown = pick(st);
    json!({
        "schema": "media/1",
        "v": 1,
        "source": { "kind": "companion", "connected": true, "instance": st.instance, "lastSeen": st.last_seen },
        "error": st.error,
        "selection": {
            "mode": if st.manual.is_some() { "manual" } else { "auto" },
            "sessionId": st.manual.clone().or_else(|| shown.map(|s| s.id.clone())),
            "missing": st.manual.is_some() && shown.is_none(),
            "missingName": st.missing_name,
        },
        "sessions": st.sessions.iter().map(|s| json!({
            "id": s.id, "app": { "name": app_name(&s.app_id) }, "title": s.meta.title, "playback": s.playback.word(),
        })).collect::<Vec<_>>(),
        "session": shown.map(session_json),
        // Spotify only: its queue comes from the Spotify API, which Windows media sessions do not expose.
        "queue": shown.filter(|s| app_name(&s.app_id) == "Spotify").and_then(|s| crate::spotify::queue_for(&s.meta.title)),
        "system": st.volume.map(|(level, muted)| json!({ "volume": level, "muted": muted, "sleepUntil": st.sleep_at })),
    })
}

/// Records the system volume read by the media thread; publishes when it changed.
pub fn set_volume(volume: Option<(u8, bool)>, now: u64) {
    let mut st = lock();
    if st.volume != volume {
        st.volume = volume;
        st.publish(now);
    }
}

/// The paused-playback target when the sleep timer is due (the timer is spent either way).
pub fn due_sleep(now: u64) -> Option<Target> {
    let mut st = lock();
    if !st.sleep_at.is_some_and(|t| now >= t) {
        return None;
    }
    st.sleep_at = None;
    st.publish(now);
    // A manually picked session may be paused while another one plays.
    pick(&st)
        .filter(|s| s.playback == Playback::Playing)
        .or_else(|| st.sessions.iter().find(|s| s.playback == Playback::Playing))
        .map(|s| Target { app_id: s.app_id.clone(), ordinal: s.ordinal, action: Action::Toggle, start_ticks: s.timeline.map_or(0, |t| t.start_ticks) })
}

/// Commands that concern the computer, not one player: volume, mute, sleep timer.
pub fn system_command(body: &Value, now: u64) -> Result<(), (u16, &'static str)> {
    match body["cmd"].as_str() {
        Some("volume") => {
            let v = body["value"].as_f64().filter(|v| v.is_finite()).ok_or((400, "bad_request"))?;
            set_system_volume(Some(v.round().clamp(0.0, 100.0) as u8), None, now)
        }
        Some("mute") => set_system_volume(None, Some(body["value"].as_bool().ok_or((400, "bad_request"))?), now),
        Some("sleep") => {
            // Minutes; 0 cancels. A day at most.
            let m = body["value"].as_f64().filter(|v| v.is_finite() && *v >= 0.0).ok_or((400, "bad_request"))?.min(1440.0);
            let mut st = lock();
            st.sleep_at = (m > 0.0).then(|| now + (m * 60_000.0) as u64);
            st.publish(now);
            Ok(())
        }
        _ => Err((400, "unknown_command")),
    }
}

fn set_system_volume(level: Option<u8>, muted: Option<bool>, now: u64) -> Result<(), (u16, &'static str)> {
    #[cfg(windows)]
    {
        let done = level.map_or(Ok(()), volume::set_level).and(muted.map_or(Ok(()), volume::set_mute));
        done.map_err(|_| (503, "audio_unavailable"))?;
        set_volume(volume::read(), now);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (level, muted, now);
        Err((503, "audio_unavailable"))
    }
}

/// Artwork bytes, only for the revision they were read for.
pub fn art_for(st: &State, id: &str, rev: u64) -> Option<(&'static str, Arc<Vec<u8>>)> {
    st.find(id)?.art.as_ref().filter(|a| a.rev == rev).map(|a| (a.mime, Arc::clone(&a.bytes)))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    Toggle,
    Next,
    Prev,
    SeekMs(u64),
    Shuffle(bool),
    Repeat(u8),
}

#[derive(Debug, PartialEq)]
pub struct Target {
    pub app_id: String,
    pub ordinal: u32,
    pub action: Action,
    pub start_ticks: i64,
}

/// Validates a widget command against the current state; errors are (HTTP status, code).
pub fn resolve(st: &State, body: &Value, now: u64) -> Result<Target, (u16, &'static str)> {
    let cmd = body["cmd"].as_str().ok_or((400, "bad_request"))?;
    let id = body["sessionId"].as_str().ok_or((400, "bad_request"))?;
    if now > st.last_seen + STALE_MS {
        return Err((503, "stale"));
    }
    let s = st.find(id).ok_or((404, "session_gone"))?;
    let (action, allowed) = match cmd {
        "playPause" => (Action::Toggle, s.caps.play_pause),
        "next" => (Action::Next, s.caps.next),
        "prev" => (Action::Prev, s.caps.prev),
        "seek" => {
            let v = body["value"].as_f64().filter(|v| v.is_finite() && *v >= 0.0).ok_or((400, "bad_request"))?;
            let ms = (v * 1000.0) as u64;
            let limit = s.timeline.and_then(|t| t.duration_ms).unwrap_or(ms);
            (Action::SeekMs(ms.min(limit)), s.caps.seek)
        }
        "shuffle" => (Action::Shuffle(body["value"].as_bool().ok_or((400, "bad_request"))?), s.caps.shuffle),
        "repeat" => (Action::Repeat(body["value"].as_u64().filter(|v| *v <= 2).ok_or((400, "bad_request"))? as u8), s.caps.repeat),
        _ => return Err((400, "unknown_command")),
    };
    if !allowed {
        return Err((422, "unsupported"));
    }
    // Skips and seeks aimed at a track that already changed are refused, never replayed on the new one.
    if !matches!(action, Action::Toggle | Action::Shuffle(_) | Action::Repeat(_)) && body["rev"].as_u64() != Some(s.rev) {
        return Err((409, "track_changed"));
    }
    Ok(Target { app_id: s.app_id.clone(), ordinal: s.ordinal, action, start_ticks: s.timeline.map_or(0, |t| t.start_ticks) })
}

pub fn select(body: &Value) -> Result<(), (u16, &'static str)> {
    let mut st = lock();
    match body["mode"].as_str() {
        Some("auto") => st.manual = None,
        Some("manual") => {
            let id = body["sessionId"].as_str().ok_or((400, "bad_request"))?;
            if st.find(id).is_none() {
                return Err((404, "session_gone"));
            }
            st.manual = Some(id.to_string());
        }
        _ => return Err((400, "bad_request")),
    }
    st.missing_name = None;
    st.publish(now_ms());
    Ok(())
}

/// Background watcher; runs for the life of the process.
pub fn run() {
    #[cfg(windows)]
    gsmtc::run();
}

/// Sends a validated command to the player. Ok(false) when the player declined it.
pub fn execute(target: &Target) -> Result<bool, String> {
    #[cfg(windows)]
    return gsmtc::execute(target).map_err(|e| e.to_string());
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("unsupported platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lyric_query_needs_artist_and_plausible_length() {
        let meta = |t: &str, a: &str| Meta { title: t.into(), artist: a.into(), album: String::new() };
        assert_eq!(lyric_query(&meta("Song", "Band - Topic"), Some(215_400)), Some(("Song".into(), "Band".into(), 215)));
        assert_eq!(lyric_query(&meta("Song", ""), Some(215_000)), None);
        assert_eq!(lyric_query(&meta("Song", "Band"), None), None);
        assert_eq!(lyric_query(&meta("Song", "Band"), Some(10_000)), None);
        assert_eq!(lyric_query(&meta("Video", "Channel"), Some(3 * 3_600_000)), None);
    }

    const PNG_A: &[u8] = &[0x89, b'P', b'N', b'G', 1];
    const PNG_B: &[u8] = &[0x89, b'P', b'N', b'G', 2];

    fn obs(title: &str, album: &str, thumb: Thumb) -> Observed {
        Observed {
            app_id: "Spotify.exe".into(),
            ordinal: 0,
            meta: Meta { title: title.into(), artist: "A".into(), album: album.into() },
            playback: Playback::Playing,
            timeline: None,
            caps: Caps { play_pause: true, next: true, prev: true, seek: true, ..Default::default() },
            modes: Modes::default(),
            thumb,
        }
    }

    fn shown(st: &State) -> &Session {
        pick(st).unwrap()
    }

    #[test]
    fn new_track_gets_new_rev_and_never_keeps_old_art() {
        let mut st = State::new();
        merge(&mut st, vec![obs("One", "X", Thumb::Image(PNG_A.to_vec()))], None, 0);
        let first = shown(&st).rev;
        assert_eq!(shown(&st).art.as_ref().unwrap().rev, first);
        // Title changed, player still returns the old thumbnail: art withheld while it settles.
        merge(&mut st, vec![obs("Two", "Y", Thumb::Image(PNG_A.to_vec()))], None, 500);
        let s = shown(&st);
        assert!(s.rev > first && s.art.is_none() && s.art_pending);
        // The new cover arrives: attached to the new revision.
        merge(&mut st, vec![obs("Two", "Y", Thumb::Image(PNG_B.to_vec()))], None, 900);
        let s = shown(&st);
        assert_eq!(s.art.as_ref().map(|a| a.rev), Some(s.rev));
        assert!(art_for(&st, &s.id, first).is_none(), "art is never served for an old revision");
    }

    #[test]
    fn same_album_or_settled_cover_is_published() {
        let mut st = State::new();
        merge(&mut st, vec![obs("One", "Album", Thumb::Image(PNG_A.to_vec()))], None, 0);
        merge(&mut st, vec![obs("Two", "Album", Thumb::Image(PNG_A.to_vec()))], None, 500);
        assert!(shown(&st).art.is_some(), "same album: same cover is expected");
        merge(&mut st, vec![obs("Three", "Other", Thumb::Image(PNG_A.to_vec()))], None, 1000);
        assert!(shown(&st).art.is_none());
        merge(&mut st, vec![obs("Three", "Other", Thumb::Image(PNG_A.to_vec()))], None, 1000 + ART_SETTLE_MS);
        assert!(shown(&st).art.is_some(), "after the settle delay the image is trusted");
    }

    #[test]
    fn missing_or_unknown_images_are_not_published() {
        let mut st = State::new();
        merge(&mut st, vec![obs("One", "", Thumb::Missing)], None, 0);
        assert!(shown(&st).art_pending);
        merge(&mut st, vec![obs("One", "", Thumb::Missing)], None, ART_SETTLE_MS);
        assert!(!shown(&st).art_pending && shown(&st).art.is_none());
        merge(&mut st, vec![obs("One", "", Thumb::Image(b"<svg/>".to_vec()))], None, ART_SETTLE_MS + 1);
        assert!(shown(&st).art.is_none());
    }

    #[test]
    fn stale_or_unsupported_commands_are_refused() {
        let mut st = State::new();
        let mut o = obs("One", "", Thumb::Missing);
        o.caps.next = false;
        merge(&mut st, vec![o], None, 0);
        st.last_seen = 0;
        let (id, rev) = (shown(&st).id.clone(), shown(&st).rev);
        let cmd = |c: &str, r: u64| json!({ "cmd": c, "sessionId": id, "rev": r, "value": 12.5 });
        assert_eq!(resolve(&st, &cmd("next", rev), 0).unwrap_err(), (422, "unsupported"));
        assert_eq!(resolve(&st, &cmd("seek", rev - 1), 0).unwrap_err(), (409, "track_changed"));
        assert_eq!(resolve(&st, &cmd("seek", rev), 0).unwrap().action, Action::SeekMs(12500));
        assert_eq!(resolve(&st, &cmd("playPause", rev - 1), 0).unwrap().action, Action::Toggle);
        assert_eq!(resolve(&st, &cmd("playPause", rev), STALE_MS + 1).unwrap_err(), (503, "stale"));
        assert_eq!(resolve(&st, &json!({ "cmd": "next", "sessionId": "m-gone", "rev": 1 }), 0).unwrap_err(), (404, "session_gone"));
    }

    #[test]
    fn shuffle_and_repeat_need_support_and_a_valid_value() {
        let mut st = State::new();
        let mut o = obs("One", "", Thumb::Missing);
        o.caps.shuffle = true;
        merge(&mut st, vec![o], None, 0);
        st.last_seen = 0;
        let id = shown(&st).id.clone();
        let cmd = |c: &str, v: Value| json!({ "cmd": c, "sessionId": id, "value": v });
        // Modes are not tied to a track revision: no rev is sent and none is needed.
        assert_eq!(resolve(&st, &cmd("shuffle", json!(true)), 0).unwrap().action, Action::Shuffle(true));
        assert_eq!(resolve(&st, &cmd("shuffle", json!(1)), 0).unwrap_err(), (400, "bad_request"));
        assert_eq!(resolve(&st, &cmd("repeat", json!(1)), 0).unwrap_err(), (422, "unsupported"));
    }

    #[test]
    fn sleep_timer_pauses_what_plays_once() {
        let mut st = State::new();
        merge(&mut st, vec![obs("One", "", Thumb::Missing)], None, 0);
        drop(st);
        {
            let mut g = lock();
            *g = State::new();
            merge(&mut g, vec![obs("One", "", Thumb::Missing)], None, 0);
            g.sleep_at = Some(1_000);
        }
        assert!(due_sleep(999).is_none());
        assert_eq!(due_sleep(1_000).map(|t| t.action), Some(Action::Toggle));
        assert!(due_sleep(2_000).is_none());
        // A paused session picked by hand: the timer pauses the one that plays.
        {
            let mut g = lock();
            let mut paused = obs("Video", "", Thumb::Missing);
            paused.app_id = "Brave.X".into();
            paused.playback = Playback::Paused;
            merge(&mut g, vec![obs("One", "", Thumb::Missing), paused], None, 0);
            g.manual = Some(g.sessions[1].id.clone());
            g.sleep_at = Some(3_000);
        }
        assert_eq!(due_sleep(3_000).map(|t| t.app_id), Some("Spotify.exe".into()));
    }

    #[test]
    fn picked_player_that_closes_is_reported_not_replaced() {
        let mut st = State::new();
        let mut other = obs("Video", "", Thumb::Missing);
        other.app_id = "Brave.X".into();
        other.playback = Playback::Paused;
        merge(&mut st, vec![obs("One", "", Thumb::Missing), other], None, 0);
        st.manual = Some(st.sessions[1].id.clone());
        merge(&mut st, vec![obs("One", "", Thumb::Missing)], None, 100);
        assert!(pick(&st).is_none());
        let snap = snapshot(&st);
        assert_eq!(snap["selection"]["missing"], true);
        assert_eq!(snap["selection"]["missingName"], "Brave");
        let mut back = obs("Video", "", Thumb::Missing);
        back.app_id = "Brave.X".into();
        merge(&mut st, vec![obs("One", "", Thumb::Missing), back], None, 200);
        assert_eq!(snapshot(&st)["selection"]["missingName"], Value::Null);
    }

    #[test]
    fn auto_pick_prefers_a_playing_session() {
        let mut st = State::new();
        let mut paused = obs("Paused", "", Thumb::Missing);
        paused.app_id = "Spotify.exe".into();
        paused.playback = Playback::Paused;
        let mut playing = obs("Playing", "", Thumb::Missing);
        playing.app_id = "Brave.X".into();
        merge(&mut st, vec![paused, playing], Some("Spotify.exe".into()), 0);
        assert_eq!(shown(&st).meta.title, "Playing");
    }

    #[test]
    fn names_and_images() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("Brave.BM6RYC55AFV5J6KCTFYDA224GQ"), "Brave");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(app_name("308046B0AF4A39CB"), "Firefox");
        assert_eq!(app_name("chrome"), "Chrome");
        assert_eq!(app_name("F0DC299D809B9700"), "Zen Browser");
        assert_eq!(app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"<svg"), None);
    }
}
