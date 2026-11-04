//! Game Session: which game has the foreground and since when, for the Game Session widget.
//! A game is an executable installed under a store's game library (Steam, Epic, Xbox, Riot, EA, Ubisoft,
//! GOG, Battle.net). Only the foreground window is looked at, every 2 s, and only while the widget asks.
//! A session survives alt-tabbing: it ends after 2 min without the game in front.
use crate::util::now_ms;
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

const TICK: Duration = Duration::from_secs(2);
const END_AFTER_MS: u64 = 120_000;

/// Library folders, lowercase with a trailing separator: the game's name is the folder right after.
const LIBRARIES: &[&str] = &[
    r"\steamapps\common\",
    r"\epic games\",
    r"\xboxgames\",
    r"\riot games\",
    r"\ea games\",
    r"\ubisoft game launcher\games\",
    r"\gog galaxy\games\",
    r"\battle.net\",
];

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub name: String,
    pub started_at: u64,
    pub last_seen: u64,
    pub ended_at: Option<u64>,
}

#[derive(Default)]
pub struct State {
    pub current: Option<Session>,
    pub last: Option<Session>,
    pub foreground: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn lock() -> MutexGuard<'static, Option<State>> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// The game's name from its executable's path, or None when it is not in a game library.
pub fn game_name(path: &str) -> Option<String> {
    let lower = path.to_ascii_lowercase().replace('/', "\\");
    for lib in LIBRARIES {
        if let Some(i) = lower.find(lib) {
            let rest = &path[i + lib.len()..];
            let name = rest.split(['\\', '/']).next().unwrap_or("").trim();
            // Store launchers sit in the same trees: they are not games.
            let stem = std::path::Path::new(path).file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            if name.is_empty() || matches!(stem.as_str(), "epicgameslauncher" | "battle.net" | "riotclientservices" | "riotclientux" | "eadesktop" | "upc" | "galaxyclient") {
                return None;
            }
            return Some(name.to_string());
        }
    }
    None
}

/// One tick: `fg` is the foreground game's name, if any.
pub fn step(st: &mut State, fg: Option<&str>, now: u64) {
    st.foreground = fg.is_some();
    match (fg, st.current.as_mut()) {
        (Some(name), Some(cur)) if cur.name == name => cur.last_seen = now,
        (Some(name), _) => {
            if let Some(mut old) = st.current.take() {
                old.ended_at = Some(old.last_seen);
                st.last = Some(old);
            }
            st.current = Some(Session { name: name.to_string(), started_at: now, last_seen: now, ended_at: None });
        }
        (None, Some(cur)) if now.saturating_sub(cur.last_seen) > END_AFTER_MS => {
            let mut old = st.current.take().unwrap();
            old.ended_at = Some(old.last_seen);
            st.last = Some(old);
        }
        (None, _) => {}
    }
}

fn session_json(s: &Session) -> Value {
    json!({ "name": s.name, "startedAt": s.started_at, "lastSeen": s.last_seen, "endedAt": s.ended_at })
}

/// The `game/1` snapshot.
pub fn snapshot() -> Value {
    let g = lock();
    let st = g.as_ref();
    json!({
        "schema": "game/1",
        "game": st.and_then(|s| s.current.as_ref()).map(session_json),
        "foreground": st.is_some_and(|s| s.foreground),
        "last": st.and_then(|s| s.last.as_ref()).map(session_json),
    })
}

#[cfg(windows)]
fn foreground_path() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }
    crate::util::exe_path(pid)
}

#[cfg(not(windows))]
fn foreground_path() -> Option<String> {
    None
}

/// Background watcher; looks only while the widget polled in the last 90 s.
pub fn run() {
    loop {
        std::thread::sleep(TICK);
        if !crate::http::polled_recently(crate::http::Poll::Game) {
            continue;
        }
        let fg = foreground_path().and_then(|p| game_name(&p));
        let mut g = lock();
        step(g.get_or_insert_with(State::default), fg.as_deref(), now_ms());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_games_from_their_library_folder() {
        assert_eq!(game_name(r"D:\SteamLibrary\steamapps\common\Grand Theft Auto V\GTA5.exe").as_deref(), Some("Grand Theft Auto V"));
        assert_eq!(game_name(r"C:\Program Files\Epic Games\Fortnite\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe").as_deref(), Some("Fortnite"));
        assert_eq!(game_name(r"C:\XboxGames\Forza Horizon 5\Content\ForzaHorizon5.exe").as_deref(), Some("Forza Horizon 5"));
        assert_eq!(game_name(r"C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"), None);
        assert_eq!(game_name(r"C:\Program Files\Microsoft VS Code\Code.exe"), None);
    }

    #[test]
    fn a_session_survives_alt_tab_and_ends_after_two_minutes() {
        let mut st = State::default();
        step(&mut st, Some("GTA V"), 0);
        step(&mut st, None, 60_000);   // alt-tab for a minute
        step(&mut st, Some("GTA V"), 61_000);
        assert_eq!(st.current.as_ref().unwrap().started_at, 0);
        step(&mut st, None, 61_000 + END_AFTER_MS + 1);
        assert!(st.current.is_none());
        assert_eq!(st.last.as_ref().unwrap().ended_at, Some(61_000));
        step(&mut st, Some("Forza"), 500_000);
        step(&mut st, Some("GTA V"), 502_000);   // another game: the first one ends at once
        assert_eq!(st.last.as_ref().unwrap().name, "Forza");
    }
}
