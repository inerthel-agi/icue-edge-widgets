//! Which of our iCUE widgets are installed, placed on a screen and connected. Read-only: iCUE's own
//! files are scanned for widget ids (`<typeId>com.stealthsrc.…</typeId>`), never modified.
//! XENEON EDGE layouts live in `CUE5\dashlcd\storage`; pump LCD screens in the profiles.
use crate::http::{self, Feed, Poll};
use crate::util::now_ms;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// One of our widgets: id suffix after `com.stealthsrc.`, name, screen, icon file in web/icons, colour,
/// a short description, and what proves it is connected (None: it does not use the companion).
struct Widget {
    id: &'static str,
    name: &'static str,
    screen: &'static str,
    icon: &'static str,
    color: &'static str,
    desc: &'static str,
    link: Link,
}

const EDGE: &str = "XENEON EDGE";
const PUMP: &str = "Pump LCD";
const fn w(id: &'static str, name: &'static str, screen: &'static str, icon: &'static str, color: &'static str, desc: &'static str, link: Link) -> Widget {
    Widget { id, name, screen, icon, color, desc, link }
}
const OURS: &[Widget] = &[
    w("claudeusage", "Claude Usage", EDGE, "claude", "#e0a98c", "Limits, tokens and conversation of Claude Code", Link::Stream(Feed::Usage)),
    w("codexusage", "Codex Usage", EDGE, "openai", "#9cc8ec", "Limits, tokens and conversation of Codex", Link::Stream(Feed::Usage)),
    w("aicost", "AI Cost", EDGE, "ai-cost", "#a8d5ba", "Estimated cost of today's Claude and Codex tokens", Link::Poll(Poll::Usage)),
    w("screentime", "Screen Time", EDGE, "screen-time", "#a8d5ba", "Time per application today, kept on this PC", Link::Poll(Poll::ScreenTime)),
    w("nowplaying", "Now Playing", EDGE, "now-playing", "#a8d5ba", "What plays on Windows, with lyrics and up next", Link::Stream(Feed::Media)),
    w("spotify", "Spotify", EDGE, "spotify", "#1ed760", "Spotify player, synced lyrics and queue", Link::Stream(Feed::Spotify)),
    w("audiomixer", "Audio Mixer", EDGE, "audio-mixer", "#a8d5ba", "Volume and mute of each app playing sound", Link::Poll(Poll::Mixer)),
    w("agentactivity", "Agent Activity", EDGE, "agent-activity", "#e0a98c", "What Claude Code is doing right now", Link::Poll(Poll::Agent)),
    w("controldeck", "Control Deck", EDGE, "control-deck", "#a8d5ba", "Touch buttons for a fixed list of PC actions", Link::Poll(Poll::Deck)),
    w("stocks", "Stocks", EDGE, "stocks", "#ffa028", "Quotes in a market-terminal look", Link::Poll(Poll::Stocks)),
    w("networkpulse", "Network Pulse", EDGE, "network-pulse", "#7cc8ff", "Download, upload and ping", Link::Poll(Poll::Net)),
    w("systempulse", "System Pulse", EDGE, "system-pulse", "#a8d5ba", "CPU, GPU and memory load from iCUE sensors", Link::None),
    w("rigmonitor", "Rig Monitor", EDGE, "rig-monitor", "#a8d5ba", "CPU, GPU, memory and cooling history with peaks", Link::None),
    w("rigpet", "Rig Pet", EDGE, "rig-pet", "#ffb84d", "A small creature that feels your PC's heat", Link::None),
    w("flipclock", "Flip Clock", EDGE, "flip-clock", "#f7f8fb", "Flip, Nixie or fluorescent clock", Link::None),
    w("rainwindow", "Rain Window", EDGE, "rain-window", "#7cc8ff", "A window on the real weather outside", Link::None),
    w("gamesession", "Game Session", EDGE, "game-session", "#ff3d2e", "The game you play, frame rate and a debrief", Link::Poll(Poll::Game)),
    w("freegames", "Free Games", EDGE, "free-games", "#e2412f", "Free Epic games and Steam prices you watch", Link::Poll(Poll::Deals)),
    w("gridpulse", "Grid Pulse", EDGE, "grid-pulse", "#3dff7a", "France's power mix and CO2, live", Link::None),
    w("patchradar", "Patch Radar", EDGE, "patch-radar", "#ff6a4a", "Steam announcements of your games", Link::Poll(Poll::Patches)),
    w("ciradar", "CI Radar", EDGE, "ci-radar", "#f2c46d", "GitHub Actions lamps and review queue", Link::None),
    w("energycost", "Energy Cost", EDGE, "energy-cost", "#a8d5ba", "What the PC costs in electricity", Link::None),
    w("weathernow", "Weather Now", EDGE, "weather-now", "#ffb84d", "Current weather and forecast", Link::None),
    w("dailybrief", "Daily Brief", EDGE, "daily-brief", "#00c8ff", "Date, weather and agenda at a glance", Link::None),
    w("worldclock", "World Clock", EDGE, "world-clock", "#f7f8fb", "Several time zones", Link::None),
    w("focustimer", "Focus Timer", EDGE, "focus-timer", "#ff6b6b", "Pomodoro focus timer", Link::None),
    w("countdowns", "Countdowns", EDGE, "countdowns", "#ffb84d", "Days left until your dates", Link::None),
    w("habitrings", "Habit Rings", EDGE, "habit-rings", "#1db954", "Daily habit rings", Link::None),
    w("githubrepomonitor", "GitHub Repo Monitor", EDGE, "github-repo-monitor", "#a678ff", "Status of a GitHub repository", Link::None),
    w("isshorizon", "ISS Horizon", EDGE, "iss-horizon", "#00c8ff", "Where the International Space Station is", Link::None),
    w("windowsmediapump", "Windows Media Pump", PUMP, "windows-media-pump", "#1db954", "Cover and progress, sent through files", Link::Relay),
    w("coolingsensorpump", "Cooling Sensor Pump", PUMP, "cooling-sensor-pump", "#00c8ff", "Pump, CPU or GPU sensor", Link::None),
    w("racinggaugepump", "Racing Gauge Pump", PUMP, "racing-gauge-pump", "#00c8ff", "Animated racing gauge for a cooling sensor", Link::None),
    w("fpsgaugepump", "FPS Gauge Pump", PUMP, "fps-gauge-pump", "#7cf29a", "Animated FPS gauge, average and low", Link::None),
    w("pumpfaces", "Pump Faces", PUMP, "pump-faces", "#ff9a3c", "Coolant tank, aquarium, vinyl and more", Link::Relay),
];

#[derive(Clone, Copy)]
enum Link {
    Stream(Feed),
    /// Polled every 15 to 30 s instead of a stream.
    Poll(Poll),
    /// The pump renderer cannot open a connection; it reads the files the relay writes.
    Relay,
    /// Works without the companion: only installed and placed can be known.
    None,
}

/// Where a widget's package lives under `dist/icuewidgets`: (folder, file stem).
pub fn package_name(id: &str) -> Option<(&'static str, &'static str)> {
    let w = OURS.iter().find(|w| w.id == id)?;
    let stem = match w.id {
        "claudeusage" => "claude-usage",
        "codexusage" => "codex-usage",
        _ => w.icon,
    };
    Some((if w.screen == PUMP { "corsair-watercooling" } else { "xeneon-edge" }, stem))
}

const PACKAGES: &str = "https://raw.githubusercontent.com/inerthel-agi/icue-edge-widgets/main/dist/icuewidgets";

/// The widget's `.icuewidget` file, ready for iCUE to open. A build of this repository next to the
/// companion (a developer checkout) wins; otherwise the package is downloaded from the repository's main
/// branch into `%TEMP%\icue-edge-companion\packages` (see `util::handoff_dir`). Only our own ids are accepted.
pub fn package_file(id: &str) -> Result<PathBuf, String> {
    let (folder, stem) = package_name(id).ok_or("unknown widget")?;
    if let Some(local) = local_dist().map(|d| d.join(folder).join(format!("{stem}.icuewidget"))).filter(|p| p.is_file()) {
        return Ok(local);
    }
    let r = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(30)).build()
        .get(&format!("{PACKAGES}/{folder}/{stem}.icuewidget")).set("User-Agent", "icue-edge-companion").call().map_err(|e| e.to_string())?;
    let bytes = crate::util::read_limited(r.into_reader(), 32 * 1024 * 1024).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err("the download is not a widget package".into());
    }
    let dir = crate::util::handoff_dir("packages");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::util::ensure_no_links(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{stem}.icuewidget"));
    crate::util::atomic_write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// `dist/icuewidgets` of a build of this repository next to the companion (a developer checkout), if any.
fn local_dist() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().skip(1).take(6).map(|d| d.join("dist").join("icuewidgets")).find(|p| p.join("index.json").is_file())
}

/// Latest fingerprint per widget id, from `index.json` (written by the packaging script). The local build
/// wins; otherwise the repository's copy, fetched in the background at most once an hour.
static LATEST: std::sync::Mutex<(u64, Option<Value>)> = std::sync::Mutex::new((0, None));
fn latest_index() -> Option<Value> {
    if let Some(dir) = local_dist() {
        let text = std::fs::read_to_string(dir.join("index.json")).ok()?;
        return serde_json::from_str(&text).ok();
    }
    let mut g = LATEST.lock().unwrap_or_else(|e| e.into_inner());
    if g.0 + 3_600_000 < now_ms() {
        g.0 = now_ms();
        std::thread::spawn(|| {
            let got = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build().get(&format!("{PACKAGES}/index.json"))
                .set("User-Agent", "icue-edge-companion").call().ok()
                .and_then(|r| crate::util::read_limited(r.into_reader(), 256 * 1024).ok())
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            if got.is_some() {
                LATEST.lock().unwrap_or_else(|e| e.into_inner()).1 = got;
            }
        });
    }
    g.1.clone()
}

/// Every file of a widget folder as ('/'-separated relative path, full path), except what is not part of the
/// package: the companion's own `live/` relay folder and `resources/build.txt`.
fn package_files(dir: &Path) -> Vec<(String, PathBuf)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
        let Ok(read) = std::fs::read_dir(dir) else { return };
        for e in read.flatten() {
            let p = e.path();
            let Ok(t) = e.file_type() else { continue };
            let rel = p.strip_prefix(base).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            if t.is_dir() && !t.is_symlink() {
                if rel != "live" {
                    walk(base, &p, out);
                }
            } else if t.is_file() && rel != "resources/build.txt" {
                out.push((rel, p));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// The fingerprint of the files actually installed, computed as the packaging script does: lines
/// "path:SHA256" in ordinal path order joined by "\n", SHA-256 of that, first 16 hex digits.
pub fn folder_fingerprint(dir: &Path) -> Option<String> {
    let mut lines = Vec::new();
    for (rel, path) in package_files(dir) {
        let hash = crate::util::sha256(&std::fs::read(path).ok()?)?;
        lines.push(format!("{rel}:{}", hash.iter().map(|b| format!("{b:02X}")).collect::<String>()));
    }
    let total = crate::util::sha256(lines.join("\n").as_bytes())?;
    Some(total.iter().take(8).map(|b| format!("{b:02x}")).collect())
}

/// Installed fingerprints, recomputed only when a file of the folder changes (count or latest write).
static INSTALLED: std::sync::Mutex<Vec<(String, (usize, u64), Option<String>)>> = std::sync::Mutex::new(Vec::new());
fn installed_build(id: &str, dir: &Path) -> Option<String> {
    let files = package_files(dir);
    let stamp = (files.len(), files.iter().filter_map(|(_, p)| p.metadata().ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).max().unwrap_or(0));
    let mut cache = INSTALLED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, s, fp)) = cache.iter().find(|(i, ..)| i == id) {
        if *s == stamp {
            return fp.clone();
        }
    }
    let fp = folder_fingerprint(dir);
    cache.retain(|(i, ..)| i != id);
    cache.push((id.to_string(), stamp, fp.clone()));
    fp
}

/// "current", "outdated" (a newer package exists, or the installed copy predates fingerprints),
/// "missing", or "unknown" when no index could be read.
pub fn update_state(installed: bool, build: Option<&str>, latest: Option<&str>) -> &'static str {
    match (installed, build, latest) {
        (false, ..) => "missing",
        (true, _, None) => "unknown",
        (true, Some(b), Some(l)) if b == l => "current",
        (true, ..) => "outdated",
    }
}

/// Where iCUE keeps an installed widget: `html_widgets/com/vendor/name` for the id `com.vendor.name`.
pub fn installed_dir(id: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = id.split('.').collect();
    if parts.len() < 2 || parts.len() > 6 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        return None;
    }
    let mut dir = cue_dir()?.join("html_widgets");
    for p in parts {
        dir.push(p);
    }
    Some(dir)
}

fn cue_dir() -> Option<PathBuf> {
    Some(Path::new(&std::env::var_os("APPDATA")?).join(r"Corsair\CUE5"))
}

/// Our widget ids (suffix after `com.stealthsrc.`) mentioned in a text.
pub fn ids_in(text: &str) -> Vec<String> {
    const TAG: &str = "<typeId>com.stealthsrc.";
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(TAG) {
        rest = &rest[i + TAG.len()..];
        let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        if !id.is_empty() && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

fn ids_in_file(path: &Path) -> Vec<String> {
    std::fs::read(path).map(|b| ids_in(&String::from_utf8_lossy(&b))).unwrap_or_default()
}

/// Text between `<name>` and `</name>` (first one), and the index just past the closing tag.
fn tag<'a>(s: &'a str, name: &str) -> Option<(&'a str, usize)> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let i = s.find(&open)? + open.len();
    let j = s[i..].find(&close)? + i;
    Some((s[i..j].trim(), j + close.len()))
}

/// The XENEON EDGE page iCUE shows (`activeScreenId`, else the first page), from `dashlcd\storage`.
/// Each widget has a slot on the 3 × 2 grid, column by column (slot = column × 2 + row), and a size
/// in cells: 1 S, 2 M (one column), 4 L (two columns), 6 XL. Read-only, like the rest of this file.
// ponytail: reads the first XENEON EDGE only and assumes the horizontal grid; vertical needs its own grid.
pub fn edge_layout(text: &str) -> Value {
    // Each page has one `<widgets>` block and one `<screenId>` (iCUE writes the block first): paired by order.
    let ids: Vec<&str> = text.match_indices("<screenId>").filter_map(|(i, _)| tag(&text[i..], "screenId").map(|(v, _)| v)).collect();
    let mut blocks = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("<widgets") {
        let after = &rest[i..];
        let open = after.find('>').map_or(after.len(), |k| k + 1);
        if after[..open].ends_with("/>") {
            blocks.push("");
            rest = &after[open..];
            continue;
        }
        let close = after.find("</widgets>").unwrap_or(after.len());
        blocks.push(&after[open.min(close)..close]);
        rest = &after[close..];
    }
    let active = tag(text, "activeScreenId").map(|(v, _)| v);
    let page = active.and_then(|a| ids.iter().position(|v| *v == a)).filter(|&k| k < blocks.len()).unwrap_or(0);
    let mut widgets = Vec::new();
    if let Some(mut rest) = blocks.get(page).copied() {
        while let Some((slot, end)) = tag(rest, "slotIndex") {
            rest = &rest[end..];
            let Some((size, end)) = tag(rest, "size") else { break };
            rest = &rest[end..];
            let ty = tag(rest, "typeId").map(|(v, _)| v).unwrap_or("");
            let (Ok(slot), Ok(size)) = (slot.parse::<u8>(), size.parse::<u8>()) else { continue };
            if slot < 6 && matches!(size, 1 | 2 | 4 | 6) {
                let ours = ty.strip_prefix("com.stealthsrc.").filter(|id| OURS.iter().any(|w| w.id == *id));
                widgets.push(json!({ "slot": slot, "size": size, "id": ours }));
            }
        }
    }
    json!({ "pages": blocks.len(), "page": page, "widgets": widgets })
}

pub fn edge_layout_now() -> Value {
    let text = cue_dir().and_then(|c| std::fs::read(c.join(r"dashlcd\storage")).ok()).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    edge_layout(&text)
}

pub fn inventory() -> Value {
    let Some(cue) = cue_dir() else { return json!([]) };
    let on_edge = ids_in_file(&cue.join(r"dashlcd\storage"));
    let on_pump: Vec<String> = std::fs::read_dir(cue.join("profiles"))
        .map(|d| d.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "cueprofiledata")).flat_map(|e| ids_in_file(&e.path())).collect())
        .unwrap_or_default();
    let relay_fresh = crate::media::relay::written_at().is_some_and(|t| t + 10_000 > now_ms());
    let index = latest_index();
    OURS.iter()
        .map(|w| {
            let dir = cue.join(r"html_widgets\com\stealthsrc").join(w.id);
            let installed = dir.join("manifest.json").is_file();
            let build = if installed { installed_build(w.id, &dir) } else { None };
            let latest = index.as_ref().and_then(|i| i.pointer(&format!("/widgets/{}/build", w.id))).and_then(Value::as_str);
            let update = update_state(installed, build.as_deref(), latest);
            let placed = if w.screen == PUMP { on_pump.iter().any(|x| x == w.id) } else { on_edge.iter().any(|x| x == w.id) };
            let live = placed
                && match w.link {
                    Link::Stream(feed) => http::feed_streams(feed) > 0,
                    Link::Poll(poll) => http::polled_recently(poll),
                    Link::Relay => relay_fresh,
                    Link::None => false,
                };
            json!({
                "id": w.id, "name": w.name, "screen": w.screen, "icon": w.icon, "color": w.color, "desc": w.desc,
                "companion": !matches!(w.link, Link::None), "installed": installed, "placed": placed, "live": live, "update": update,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same shape as iCUE's `dashlcd\storage`: four pages (the last one empty), the second one shown.
    #[test]
    fn edge_layout_reads_the_shown_page() {
        let page = |id: &str, ws: &str| format!("<value><widgets size=\"dynamic\">{ws}</widgets><screenId>{id}</screenId><name>x</name></value>");
        let w = |slot: u8, size: u8, ty: &str| format!("<value0><id>a</id><slotIndex>{slot}</slotIndex><size>{size}</size><attachment><base><typeId>{ty}</typeId></base></attachment></value0>");
        let text = format!("<dashLCDScreens>{}{}{}<value><widgets size=\"dynamic\"/><screenId>{{D}}</screenId></value></dashLCDScreens><activeScreenId>{{B}}</activeScreenId>",
            page("{A}", &w(3, 1, "com.corsair.digitalclock1")),
            page("{B}", &(w(0, 4, "com.stealthsrc.nowplaying") + &w(4, 2, "com.stealthsrc.rigpet"))),
            page("{C}", &w(0, 6, "com.stealthsrc.nowplaying")));
        let l = edge_layout(&text);
        assert_eq!(l["pages"], 4);
        assert_eq!(l["page"], 1);
        assert_eq!(l["widgets"], json!([{ "slot": 0, "size": 4, "id": "nowplaying" }, { "slot": 4, "size": 2, "id": "rigpet" }]));
        // Someone else's widget keeps its place but has no id; a missing or unknown active page falls back to the first.
        let first = edge_layout(&text.replace("{B}</activeScreenId>", "{Z}</activeScreenId>"));
        assert_eq!(first["widgets"], json!([{ "slot": 3, "size": 1, "id": null }]));
        assert_eq!(edge_layout(&text.replace("{B}</activeScreenId>", "{D}</activeScreenId>"))["widgets"], json!([]));
        assert_eq!(edge_layout("")["widgets"], json!([]));
    }

    /// The value the packaging script gives this folder (checked once with its PowerShell function).
    #[test]
    fn folder_fingerprint_matches_the_packaging_script() {
        let dir = std::env::temp_dir().join(format!("fp-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(dir.join("resources")).unwrap();
        std::fs::create_dir_all(dir.join("live")).unwrap();
        std::fs::write(dir.join("index.html"), "<h1>x</h1>").unwrap();
        std::fs::write(dir.join("resources").join("icon.svg"), "<svg/>").unwrap();
        std::fs::write(dir.join("resources").join("build.txt"), "ignored").unwrap();
        std::fs::write(dir.join("live").join("state.js"), "ignored").unwrap();
        assert_eq!(folder_fingerprint(&dir).as_deref(), Some(EXPECTED_FP));
        std::fs::remove_dir_all(&dir).unwrap();
    }
    const EXPECTED_FP: &str = "1187e2f298b6fef4";

    #[test]
    fn update_state_compares_fingerprints() {
        assert_eq!(update_state(false, None, Some("a")), "missing");
        assert_eq!(update_state(true, Some("a"), Some("a")), "current");
        assert_eq!(update_state(true, Some("a"), Some("b")), "outdated");
        assert_eq!(update_state(true, None, Some("b")), "outdated");   // installed before fingerprints existed
        assert_eq!(update_state(true, Some("a"), None), "unknown");
    }

    #[test]
    fn every_widget_has_a_package_name() {
        assert_eq!(package_name("claudeusage"), Some(("xeneon-edge", "claude-usage")));
        assert_eq!(package_name("pumpfaces"), Some(("corsair-watercooling", "pump-faces")));
        assert_eq!(package_name("../../evil"), None);
        for w in OURS {
            let (_, stem) = package_name(w.id).unwrap();
            assert!(stem.chars().all(|c| c.is_ascii_lowercase() || c == '-'), "{stem}");
        }
    }

    #[test]
    fn finds_our_ids_once_and_ignores_others() {
        let text = "<typeId>com.corsair.digitalclock1</typeId><typeId>com.stealthsrc.spotify</typeId>\n<typeId>com.stealthsrc.claudeusage</typeId><typeId>com.stealthsrc.spotify</typeId>";
        assert_eq!(ids_in(text), ["spotify", "claudeusage"]);
    }

    #[test]
    fn every_widget_has_an_icon_in_the_window_files() {
        let web = Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/icons");
        for w in OURS {
            assert!(web.join(format!("{}.svg", w.icon)).is_file(), "missing web/icons/{}.svg", w.icon);
        }
    }
}
