//! Control Deck widget: a fixed list of PC actions the widget can trigger. Nothing else can be run:
//! the widget sends an action id, never a command, a path or arguments.
use serde_json::{json, Value};

/// (id, label, kind): "toggle" actions report their state, "run" actions just happen.
pub const ACTIONS: &[(&str, &str, &str)] = &[
    ("mic", "Microphone", "toggle"),
    ("mute", "Sound", "toggle"),
    ("playPause", "Play / pause", "run"),
    ("next", "Next track", "run"),
    ("snip", "Screenshot", "run"),
    ("lock", "Lock PC", "run"),
    ("calc", "Calculator", "run"),
    ("explorer", "Files", "run"),
    ("taskmgr", "Task Manager", "run"),
    ("nightlight", "Night light", "run"),
];

/// The `deck/1` snapshot: the actions and, for the toggles, whether they are on (microphone live, sound on).
pub fn snapshot() -> Value {
    #[cfg(windows)]
    let (mic_muted, out_muted) = (win::capture_muted(), crate::media::volume::read().map(|(_, m)| m));
    #[cfg(not(windows))]
    let (mic_muted, out_muted): (Option<bool>, Option<bool>) = (None, None);
    json!({
        "schema": "deck/1",
        "actions": ACTIONS.iter().map(|(id, label, kind)| {
            let on = match *id { "mic" => mic_muted.map(|m| !m), "mute" => out_muted.map(|m| !m), _ => None };
            json!({ "id": id, "label": label, "kind": kind, "on": on })
        }).collect::<Vec<_>>(),
    })
}

/// Runs one action from the list. Unknown ids are refused before anything happens.
pub fn run(id: &str) -> Result<(), (u16, &'static str)> {
    if !ACTIONS.iter().any(|(a, ..)| *a == id) {
        return Err((400, "unknown_action"));
    }
    #[cfg(windows)]
    return win::run(id).map_err(|_| (503, "action_failed"));
    #[cfg(not(windows))]
    Err((503, "action_failed"))
}

#[cfg(windows)]
mod win {
    use crate::util::system_exe;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eCapture, eCommunications, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE};

    fn capture() -> windows::core::Result<IAudioEndpointVolume> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            e.GetDefaultAudioEndpoint(eCapture, eCommunications)?.Activate(CLSCTX_ALL, None)
        }
    }

    pub fn capture_muted() -> Option<bool> {
        capture().ok().and_then(|v| unsafe { v.GetMute().ok() }).map(|b| b.as_bool())
    }

    fn key(vk: VIRTUAL_KEY) {
        unsafe {
            keybd_event(vk.0 as u8, 0, Default::default(), 0);
            keybd_event(vk.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        }
    }

    /// Starts a fixed program or URI, hidden console, never with widget-supplied text.
    fn launch(exe: std::path::PathBuf, arg: Option<&str>) -> std::io::Result<()> {
        let mut c = Command::new(exe);
        if let Some(a) = arg {
            c.arg(a);
        }
        c.creation_flags(0x08000000).spawn().map(|_| ())
    }
    fn open_uri(uri: &'static str) -> std::io::Result<()> {
        let mut c = Command::new(system_exe("rundll32.exe"));
        c.args(["url.dll,FileProtocolHandler", uri]).creation_flags(0x08000000).spawn().map(|_| ())
    }

    pub fn run(id: &str) -> Result<(), String> {
        let err = |e: &dyn std::fmt::Display| e.to_string();
        match id {
            "mic" => {
                let v = capture().map_err(|e| err(&e))?;
                unsafe {
                    let m = v.GetMute().map_err(|e| err(&e))?.as_bool();
                    v.SetMute(!m, std::ptr::null()).map_err(|e| err(&e))
                }
            }
            "mute" => {
                let m = crate::media::volume::read().map(|(_, m)| m).unwrap_or(false);
                crate::media::volume::set_mute(!m).map_err(|e| err(&e))
            }
            "playPause" => Ok(key(VK_MEDIA_PLAY_PAUSE)),
            "next" => Ok(key(VK_MEDIA_NEXT_TRACK)),
            "snip" => open_uri("ms-screenclip:").map_err(|e| err(&e)),
            "lock" => launch(system_exe("rundll32.exe"), Some("user32.dll,LockWorkStation")).map_err(|e| err(&e)),
            "calc" => launch(system_exe("calc.exe"), None).map_err(|e| err(&e)),
            "explorer" => {
                let win = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| r"C:\Windows".into());
                launch(win.join("explorer.exe"), None).map_err(|e| err(&e))
            }
            "taskmgr" => launch(system_exe("Taskmgr.exe"), None).map_err(|e| err(&e)),
            "nightlight" => open_uri("ms-settings:nightlight").map_err(|e| err(&e)),
            _ => Err("unknown".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_actions_run() {
        assert_eq!(run("cmd /c del").unwrap_err(), (400, "unknown_action"));
        assert_eq!(run("").unwrap_err(), (400, "unknown_action"));
        let ids: Vec<_> = snapshot()["actions"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids.len(), ACTIONS.len());
    }
}
