//! Screen time: how long each application has had the foreground, per day.
//!
//! Only the application name (the executable's file name) and seconds are kept, never a window title, a path or
//! anything typed. Nothing is collected until the Screen Time widget first asks for its data; the totals stay in
//! `%LOCALAPPDATA%\icue-edge-companion\screentime.json` on this PC, 35 days at most. Time with no keyboard or mouse input
//! for two minutes, and the lock screen, do not count. Each application's icon is kept beside them as a small PNG,
//! keyed by the same name (the path it is read from is not kept), in `screentime-icons.json`.
use crate::util::{app_dir, atomic_write, civil_from_days, days_from_civil, now_ms, SEC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

const TICK: Duration = Duration::from_secs(2);
const IDLE_MS: u64 = 120 * SEC;
const KEEP_DAYS: usize = 35;
const SAVE_EVERY_MS: u64 = 60 * SEC;
const TOP_APPS: usize = 8;

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Day {
    /// Seconds in the foreground per application name.
    pub apps: BTreeMap<String, u64>,
    /// Seconds per local hour of the day.
    pub hours: Vec<u64>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct State {
    /// Keyed by local day number (days since 1970-01-01).
    pub days: BTreeMap<u64, Day>,
    pub enabled: bool,
    #[serde(skip)]
    last_saved: u64,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
/// Application name -> base64 PNG of its icon ("" when the executable has none, so it is not read again).
static ICONS: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();

fn icons() -> MutexGuard<'static, BTreeMap<String, String>> {
    ICONS
        .get_or_init(|| Mutex::new(std::fs::read(app_dir().join("screentime-icons.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Reads an application's icon the first time it is seen in front.
fn remember_icon(name: &str, exe: &str) {
    if icons().contains_key(name) {
        return;
    }
    let png = crate::appicon::png_for_exe(exe).map(|b| std_b64(&b)).unwrap_or_default();
    let mut all = icons();
    all.insert(name.to_string(), png);
    if let Ok(bytes) = serde_json::to_vec(&*all) {
        let _ = atomic_write(&app_dir().join("screentime-icons.json"), &bytes);
    }
}

/// Standard padded base64, for data: URLs.
pub fn std_b64(bytes: &[u8]) -> String {
    let b = crate::spotify::auth::b64url(bytes).replace('-', "+").replace('_', "/");
    let pad = (4 - b.len() % 4) % 4;
    b + &"=".repeat(pad)
}

pub fn lock() -> MutexGuard<'static, State> {
    STATE.get_or_init(|| Mutex::new(load())).lock().unwrap_or_else(|e| e.into_inner())
}

fn path() -> std::path::PathBuf {
    app_dir().join("screentime.json")
}

fn load() -> State {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(st: &mut State) {
    if let Ok(bytes) = serde_json::to_vec(&*st) {
        let _ = std::fs::create_dir_all(app_dir());
        let _ = atomic_write(&path(), &bytes);
    }
    st.last_saved = now_ms();
}

/// Called when the widget asks for its data: this is what switches collection on.
pub fn enable() {
    let mut st = lock();
    if !st.enabled {
        st.enabled = true;
        save(&mut st);
    }
}

/// Short, readable name for an executable file name.
pub fn display_name(stem: &str) -> String {
    let lower = stem.to_ascii_lowercase();
    let known = match lower.as_str() {
        "code" | "code - insiders" => "VS Code",
        "chrome" => "Chrome",
        "msedge" => "Edge",
        "firefox" => "Firefox",
        "brave" => "Brave",
        "windowsterminal" | "wt" => "Terminal",
        "devenv" => "Visual Studio",
        "explorer" => "Explorer",
        "spotify" => "Spotify",
        "discord" => "Discord",
        "steam" | "steamwebhelper" => "Steam",
        "winword" => "Word",
        "excel" => "Excel",
        "powerpnt" => "PowerPoint",
        "claude" => "Claude",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_string();
    }
    let mut c = stem.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// Work, Web, Media (players and games) or Other.
pub fn category(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "vs code" | "terminal" | "visual studio" | "word" | "excel" | "powerpoint" | "claude" | "notepad" | "obsidian" | "figma" | "slack" | "teams" | "idea64" | "pycharm64" | "explorer" => "work",
        "chrome" | "edge" | "firefox" | "brave" | "opera" | "vivaldi" | "arc" => "web",
        "spotify" | "vlc" | "mpv" | "steam" | "discord" | "epicgameslauncher" | "battle.net" | "netflix" | "youtube" => "media",
        _ => "other",
    }
}

/// Local day number and hour, from the Windows local time.
#[cfg(windows)]
fn local_day_hour() -> (u64, usize) {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    (days_from_civil(t.wYear as i64, t.wMonth as u32, t.wDay as u32).max(0) as u64, t.wHour as usize % 24)
}

#[cfg(not(windows))]
fn local_day_hour() -> (u64, usize) {
    let secs = now_ms() / 1000;
    (secs / 86_400, (secs / 3600 % 24) as usize)
}

/// The foreground application's executable: (file stem, full path). The path is used once, to read its icon.
#[cfg(windows)]
fn foreground_exe() -> Option<(String, String)> {
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
    let path = crate::util::exe_path(pid)?;
    let stem = std::path::Path::new(&path).file_stem()?.to_string_lossy().to_string();
    Some((stem, path))
}

#[cfg(not(windows))]
fn foreground_exe() -> Option<(String, String)> {
    None
}

/// Milliseconds since the last keyboard or mouse input.
#[cfg(windows)]
fn idle_ms() -> u64 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        unsafe { GetTickCount() }.wrapping_sub(info.dwTime) as u64
    } else {
        0
    }
}

#[cfg(not(windows))]
fn idle_ms() -> u64 {
    0
}

/// Adds `secs` to one application on the given day and hour; old days are dropped.
pub fn record(st: &mut State, day: u64, hour: usize, name: &str, secs: u64) {
    let d = st.days.entry(day).or_default();
    if d.hours.len() != 24 {
        d.hours.resize(24, 0);
    }
    *d.apps.entry(name.to_string()).or_default() += secs;
    d.hours[hour % 24] += secs;
    while st.days.len() > KEEP_DAYS {
        let first = *st.days.keys().next().unwrap();
        st.days.remove(&first);
    }
}

pub fn run() {
    let mut last = std::time::Instant::now();
    loop {
        std::thread::sleep(TICK);
        let elapsed = last.elapsed().as_secs().min(5);
        last = std::time::Instant::now();
        if !lock().enabled {
            continue;
        }
        let (name, exe) = match foreground_exe() {
            Some((s, exe)) if !matches!(s.to_ascii_lowercase().as_str(), "lockapp" | "logonui" | "searchhost" | "startmenuexperiencehost" | "idle") => (display_name(&s), exe),
            _ => continue,
        };
        remember_icon(&name, &exe);
        let mut st = lock();
        if idle_ms() >= IDLE_MS {
            continue;
        }
        let (day, hour) = local_day_hour();
        record(&mut st, day, hour, &name, elapsed);
        if now_ms().saturating_sub(st.last_saved) > SAVE_EVERY_MS {
            save(&mut st);
        }
    }
}

fn total(d: Option<&Day>) -> u64 {
    d.map_or(0, |d| d.apps.values().sum())
}

/// The `screentime/1` snapshot: today's apps, categories and hours, plus yesterday's total and the week.
pub fn snapshot(st: &State, today: u64) -> Value {
    let day = st.days.get(&today);
    let mut apps: Vec<(&String, &u64)> = day.map(|d| d.apps.iter().collect()).unwrap_or_default();
    apps.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let mut cats: BTreeMap<&str, u64> = BTreeMap::new();
    for (n, s) in &apps {
        *cats.entry(category(n)).or_default() += **s;
    }
    let week: Vec<Value> = (0..7u64)
        .rev()
        .filter_map(|i| today.checked_sub(i))
        .map(|d| {
            let (y, m, dd) = civil_from_days(d as i64);
            json!({ "date": format!("{y:04}-{m:02}-{dd:02}"), "secs": total(st.days.get(&d)) })
        })
        .collect();
    let top: Vec<Value> = {
        let icons = icons();
        apps.iter()
            .take(TOP_APPS)
            .map(|(n, s)| {
                let icon = icons.get(*n).filter(|b| !b.is_empty()).map(|b| format!("data:image/png;base64,{b}"));
                json!({ "name": n, "secs": s, "cat": category(n), "icon": icon })
            })
            .collect()
    };
    json!({
        "schema": "screentime/1",
        "generatedAt": now_ms(),
        "enabled": st.enabled,
        "todaySecs": total(day),
        "yesterdaySecs": total(today.checked_sub(1).and_then(|y| st.days.get(&y))),
        "apps": top,
        "categories": cats,
        "hours": day.map(|d| d.hours.clone()).filter(|h| h.len() == 24).unwrap_or_else(|| vec![0; 24]),
        "week": week,
    })
}

pub fn snapshot_now() -> Value {
    snapshot(&lock(), local_day_hour().0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_categories() {
        assert_eq!(display_name("Code"), "VS Code");
        assert_eq!(display_name("obs64"), "Obs64");
        assert_eq!(category("VS Code"), "work");
        assert_eq!(category("Chrome"), "web");
        assert_eq!(category("Spotify"), "media");
        assert_eq!(category("Whatever"), "other");
    }

    #[test]
    fn records_sums_and_forgets_old_days() {
        let mut st = State::default();
        record(&mut st, 20_000, 9, "VS Code", 50);
        record(&mut st, 20_000, 9, "VS Code", 10);
        record(&mut st, 20_000, 14, "Chrome", 30);
        record(&mut st, 19_999, 10, "Chrome", 600);
        let s = snapshot(&st, 20_000);
        assert_eq!(s["todaySecs"], 90);
        assert_eq!(s["yesterdaySecs"], 600);
        assert_eq!(s["apps"][0]["name"], "VS Code");
        assert_eq!(s["categories"]["web"], 30);
        assert_eq!(s["hours"][9], 60);
        assert_eq!(s["hours"].as_array().unwrap().len(), 24);
        for d in 0..60u64 {
            record(&mut st, 10_000 + d, 0, "X", 1);
        }
        assert!(st.days.len() <= KEEP_DAYS);
    }
}
