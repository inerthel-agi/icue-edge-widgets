//! File relay for the pump LCD widget. iCUE renders pump widgets in `QmlRenderer.exe`, which
//! never reaches the loopback server, so the media snapshot and its artwork are written next to
//! the installed `Windows Media Pump` widget, which loads them as local files (`live/`).
//! Nothing is written unless that widget is installed; the folder is never created otherwise.
use super::{art_for, lock, snapshot, HUB};
use crate::util::{atomic_write, ensure_no_links, now_ms, remove_stale_tmp};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static WRITTEN_AT: AtomicU64 = AtomicU64::new(0);

/// Last successful write, if any.
pub fn written_at() -> Option<u64> {
    Some(WRITTEN_AT.load(Ordering::Relaxed)).filter(|&t| t != 0)
}

/// For the window: is the pump widget installed, and when did the relay last write.
pub fn status() -> Value {
    json!({ "installed": live_dir().is_some(), "writtenAt": written_at() })
}

const WIDGET_DIR: &str = r"Corsair\CUE5\html_widgets\com\stealthsrc\windowsmediapump";
/// The widget treats a relay older than 8 s as gone, so an unchanged state is rewritten this often.
const EVERY: Duration = Duration::from_secs(2);

fn live_dir() -> Option<PathBuf> {
    let dir = Path::new(&std::env::var_os("APPDATA")?).join(WIDGET_DIR);
    dir.join("manifest.json").is_file().then(|| dir.join("live"))
}

fn ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "webp",
    }
}

/// Writes `state.js` (a call to `pumpRelay`) and the artwork of the shown revision; older artwork is removed.
pub fn publish_to(dir: &Path, mut snap: Value, art: Option<(&str, &[u8])>) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    ensure_no_links(dir)?;
    let mut keep = None;
    let clean = |v: &Value| v.as_str().unwrap_or("").chars().filter(char::is_ascii_alphanumeric).collect::<String>();
    let instance = clean(&snap["source"]["instance"]);
    if let (Some((mime, bytes)), Some(a)) = (art, snap.pointer_mut("/session/art")) {
        let name = format!("art-{}-{}-{}.{}", instance, clean(&a["sessionId"]), a["rev"], ext(mime));
        if !dir.join(&name).is_file() {
            atomic_write(&dir.join(&name), bytes)?;
        }
        a["url"] = Value::String(format!("live/{name}"));
        keep = Some(name);
    }
    for entry in fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("art-") && Some(&name) != keep.as_ref() {
            let _ = fs::remove_file(entry.path());
        }
    }
    remove_stale_tmp(dir);
    let json = snap.to_string().replace('<', "\\u003c").replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
    atomic_write(&dir.join("state.js"), format!("window.pumpRelay && window.pumpRelay({json});\n").as_bytes())
}

/// Background writer; runs for the life of the process.
pub fn run() {
    loop {
        drop(HUB.changed.wait_timeout(lock(), EVERY));
        let Some(dir) = live_dir() else { continue };
        let (snap, art) = {
            let st = lock();
            let snap = snapshot(&st);
            let art = snap.pointer("/session/art").and_then(|a| art_for(&st, a["sessionId"].as_str()?, a["rev"].as_u64()?));
            (snap, art)
        };
        if publish_to(&dir, snap, art.as_ref().map(|(m, b)| (*m, b.as_slice()))).is_ok() {
            WRITTEN_AT.store(now_ms(), Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_state_and_only_the_current_artwork() {
        let dir = std::env::temp_dir().join(format!("pump-relay-{}", crate::util::random_hex(4)));
        let snap = |rev: u64| json!({ "schema": "media/1", "source": { "instance": "ab12" }, "session": { "art": { "url": "/api/media/art", "sessionId": "m-1", "rev": rev } } });
        publish_to(&dir, snap(1), Some(("image/png", b"one"))).unwrap();
        publish_to(&dir, snap(2), Some(("image/jpeg", b"two"))).unwrap();
        let state = fs::read_to_string(dir.join("state.js")).unwrap();
        assert!(state.starts_with("window.pumpRelay && window.pumpRelay({"), "{state}");
        assert!(state.contains(r#""url":"live/art-ab12-m1-2.jpg""#), "{state}");
        let arts: Vec<String> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("art-")).collect();
        assert_eq!(arts, ["art-ab12-m1-2.jpg"]);
        assert_eq!(fs::read(dir.join("art-ab12-m1-2.jpg")).unwrap(), b"two");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn state_script_escapes_html_and_javascript_separators() {
        let dir = std::env::temp_dir().join(format!("pump-relay-{}", crate::util::random_hex(4)));
        publish_to(&dir, json!({ "title": "</script>\u{2028}\u{2029}" }), None).unwrap();
        let state = fs::read_to_string(dir.join("state.js")).unwrap();
        assert!(!state.contains("</script>") && !state.contains('\u{2028}') && !state.contains('\u{2029}'), "{state}");
        assert!(state.contains("\\u003c/script>\\u2028\\u2029"), "{state}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
