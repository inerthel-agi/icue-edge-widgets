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
    w("rigpet", "Rig Pet", EDGE, "rig-pet", "#ffb84d", "A small creature that feels your PC's heat", Link::None),
    w("flipclock", "Flip Clock", EDGE, "flip-clock", "#f7f8fb", "Flip, Nixie or fluorescent clock", Link::None),
    w("rainwindow", "Rain Window", EDGE, "rain-window", "#7cc8ff", "A window on the real weather outside", Link::None),
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
    w("fpsgaugepump", "FPS Gauge Pump", PUMP, "fps-gauge-pump", "#7cf29a", "Animated FPS gauge with frame generation", Link::None),
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

pub fn inventory() -> Value {
    let Some(cue) = cue_dir() else { return json!([]) };
    let on_edge = ids_in_file(&cue.join(r"dashlcd\storage"));
    let on_pump: Vec<String> = std::fs::read_dir(cue.join("profiles"))
        .map(|d| d.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "cueprofiledata")).flat_map(|e| ids_in_file(&e.path())).collect())
        .unwrap_or_default();
    let relay_fresh = crate::media::relay::written_at().is_some_and(|t| t + 10_000 > now_ms());
    OURS.iter()
        .map(|w| {
            let installed = cue.join(r"html_widgets\com\stealthsrc").join(w.id).join("manifest.json").is_file();
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
                "companion": !matches!(w.link, Link::None), "installed": installed, "placed": placed, "live": live,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
