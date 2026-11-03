//! Audio Mixer widget: the apps playing sound on the default output (Windows audio sessions), with their
//! volume, mute and live level, and the output device's name and volume. Changes are by app name only.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

/// One app on the mixer: several sessions of the same app (browser tabs, game launcher) are merged.
#[derive(Debug, Clone, PartialEq)]
pub struct App {
    pub name: String,
    pub volume: u8,
    pub muted: bool,
    pub peak: f32,
}

/// Merges sessions by app name: the loudest level, the first volume, muted only if every session is.
pub fn merge(sessions: Vec<App>) -> Vec<App> {
    let mut by: BTreeMap<String, App> = BTreeMap::new();
    for s in sessions {
        by.entry(s.name.clone())
            .and_modify(|a| {
                a.peak = a.peak.max(s.peak);
                a.muted &= s.muted;
            })
            .or_insert(s);
    }
    let mut apps: Vec<App> = by.into_values().collect();
    // The system sounds last; the others by name, so the faders do not jump around while a level moves.
    apps.sort_by_key(|a| (a.name == SYSTEM, a.name.to_lowercase()));
    apps
}

pub const SYSTEM: &str = "System sounds";

static ICONS: OnceLock<Mutex<BTreeMap<String, Option<String>>>> = OnceLock::new();

/// The app's icon as a data URL, read once per app name.
fn icon(name: &str, exe: Option<&str>) -> Option<String> {
    let cache = ICONS.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(name) {
        return hit.clone();
    }
    let url = exe.and_then(crate::appicon::png_for_exe).map(|png| format!("data:image/png;base64,{}", crate::screentime::std_b64(&png)));
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(name.to_string(), url.clone());
    url
}

/// The `mixer/1` snapshot.
pub fn snapshot() -> Value {
    #[cfg(windows)]
    let read = win::read();
    #[cfg(not(windows))]
    let read: Option<(String, u8, bool, Vec<(App, Option<String>)>)> = None;
    let Some((device, volume, muted, sessions)) = read else {
        return json!({ "schema": "mixer/1", "available": false });
    };
    let exes: BTreeMap<String, Option<String>> = sessions.iter().map(|(a, exe)| (a.name.clone(), exe.clone())).collect();
    let apps = merge(sessions.into_iter().map(|(a, _)| a).collect());
    json!({
        "schema": "mixer/1",
        "available": true,
        "device": { "name": device, "volume": volume, "muted": muted },
        "apps": apps.iter().map(|a| json!({
            "name": a.name, "volume": a.volume, "muted": a.muted, "level": (a.peak * 100.0).round() as u8,
            "icon": if a.name == SYSTEM { None } else { icon(&a.name, exes.get(&a.name).and_then(|e| e.as_deref())) },
        })).collect::<Vec<_>>(),
    })
}

/// A command from the widget: `{cmd: "volume" | "mute", app?: name, value}`. Without `app`, the output device.
pub fn command(body: &Value) -> Result<(), (u16, &'static str)> {
    let app = body["app"].as_str();
    let res = match body["cmd"].as_str() {
        Some("volume") => {
            let v = body["value"].as_f64().filter(|v| v.is_finite()).ok_or((400, "bad_request"))?.clamp(0.0, 100.0) as u8;
            match app {
                Some(name) => apply(name, |vol| unsafe { vol.SetMasterVolume(f32::from(v) / 100.0, std::ptr::null()) }),
                None => device_level(v),
            }
        }
        Some("mute") => {
            let m = body["value"].as_bool().ok_or((400, "bad_request"))?;
            match app {
                Some(name) => apply(name, |vol| unsafe { vol.SetMute(m, std::ptr::null()) }),
                None => device_mute(m),
            }
        }
        _ => Err((400, "unknown_command")),
    };
    res
}

#[cfg(windows)]
fn device_level(v: u8) -> Result<(), (u16, &'static str)> {
    crate::media::volume::set_level(v).map_err(|_| (503, "audio_unavailable"))
}
#[cfg(windows)]
fn device_mute(m: bool) -> Result<(), (u16, &'static str)> {
    crate::media::volume::set_mute(m).map_err(|_| (503, "audio_unavailable"))
}
#[cfg(not(windows))]
fn device_level(_: u8) -> Result<(), (u16, &'static str)> {
    Err((503, "audio_unavailable"))
}
#[cfg(not(windows))]
fn device_mute(_: bool) -> Result<(), (u16, &'static str)> {
    Err((503, "audio_unavailable"))
}

#[cfg(windows)]
fn apply(name: &str, f: impl Fn(&windows::Win32::Media::Audio::ISimpleAudioVolume) -> windows::core::Result<()>) -> Result<(), (u16, &'static str)> {
    let n = win::each_session(|app_name, vol| if app_name == name { f(vol).is_ok() } else { false }).map_err(|_| (503, "audio_unavailable"))?;
    if n == 0 { Err((404, "app_gone")) } else { Ok(()) }
}

#[cfg(not(windows))]
fn apply(_: &str, _: impl Fn(&()) -> Result<(), ()>) -> Result<(), (u16, &'static str)> {
    Err((503, "audio_unavailable"))
}

#[cfg(windows)]
mod win {
    use super::{App, SYSTEM};
    use windows::core::{Interface, Result};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

    fn device() -> Result<IMMDevice> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)
        }
    }

    fn app_name(pid: u32, system: bool) -> (String, Option<String>) {
        if system || pid == 0 {
            return (SYSTEM.to_string(), None);
        }
        match crate::util::exe_path(pid) {
            Some(path) => {
                let stem = std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                (crate::screentime::display_name(&stem), Some(path))
            }
            None => (format!("App {pid}"), None),
        }
    }

    /// Calls `f(name, volume)` for every live session; returns how many calls returned true.
    pub fn each_session(mut f: impl FnMut(&str, &ISimpleAudioVolume) -> bool) -> Result<usize> {
        let mut n = 0;
        unsafe {
            let mgr: IAudioSessionManager2 = device()?.Activate(CLSCTX_ALL, None)?;
            let list = mgr.GetSessionEnumerator()?;
            for i in 0..list.GetCount()? {
                let Ok(ctl) = list.GetSession(i) else { continue };
                if ctl.GetState().is_ok_and(|s| s == AudioSessionStateExpired) {
                    continue;
                }
                let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                let (name, _) = app_name(c2.GetProcessId().unwrap_or(0), c2.IsSystemSoundsSession().0 == 0);
                if let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() {
                    if f(&name, &vol) {
                        n += 1;
                    }
                }
            }
        }
        Ok(n)
    }

    /// (device name, device volume, device muted, sessions with their executable path).
    pub fn read() -> Option<(String, u8, bool, Vec<(App, Option<String>)>)> {
        unsafe {
            let dev = device().ok()?;
            let name = dev.OpenPropertyStore(STGM_READ).ok().and_then(|p| p.GetValue(&PKEY_Device_FriendlyName).ok()).map(|v| v.to_string()).unwrap_or_else(|| "Output".into());
            let ep: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None).ok()?;
            let volume = (ep.GetMasterVolumeLevelScalar().ok()? * 100.0).round() as u8;
            let muted = ep.GetMute().ok()?.as_bool();
            let mgr: IAudioSessionManager2 = dev.Activate(CLSCTX_ALL, None).ok()?;
            let list = mgr.GetSessionEnumerator().ok()?;
            let mut out = Vec::new();
            for i in 0..list.GetCount().ok()? {
                let Ok(ctl) = list.GetSession(i) else { continue };
                if ctl.GetState().is_ok_and(|s| s == AudioSessionStateExpired) {
                    continue;
                }
                let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                let (app, exe) = app_name(c2.GetProcessId().unwrap_or(0), c2.IsSystemSoundsSession().0 == 0);
                let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() else { continue };
                let peak = ctl.cast::<IAudioMeterInformation>().ok().and_then(|m| m.GetPeakValue().ok()).unwrap_or(0.0);
                out.push((
                    App { name: app, volume: (vol.GetMasterVolume().unwrap_or(1.0) * 100.0).round() as u8, muted: vol.GetMute().map(|b| b.as_bool()).unwrap_or(false), peak },
                    exe,
                ));
            }
            Some((name, volume, muted, out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_of_one_app_are_merged_and_system_sounds_come_last() {
        let a = |n: &str, v, m, p| App { name: n.into(), volume: v, muted: m, peak: p };
        let apps = merge(vec![a(SYSTEM, 100, false, 0.0), a("Chrome", 80, true, 0.2), a("Discord", 40, false, 0.1), a("Chrome", 60, false, 0.7)]);
        let names: Vec<_> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Chrome", "Discord", SYSTEM]);
        assert_eq!((apps[0].volume, apps[0].muted, apps[0].peak), (80, false, 0.7));
    }

    /// Needs an output device: `cargo test -- --ignored mixer_reads`.
    #[test]
    #[ignore]
    fn mixer_reads_the_sessions() {
        let s = snapshot();
        let mut v = s.clone();
        for a in v["apps"].as_array_mut().into_iter().flatten() {
            a["icon"] = json!(a["icon"].is_string());
        }
        eprintln!("{v}");
        assert_eq!(s["available"], json!(true));
    }

    #[test]
    fn commands_are_checked() {
        assert_eq!(command(&json!({ "cmd": "volume" })).unwrap_err(), (400, "bad_request"));
        assert_eq!(command(&json!({ "cmd": "launch", "value": "calc" })).unwrap_err(), (400, "unknown_command"));
    }
}
