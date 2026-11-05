// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use icue_edge_companion::usage::store::{lock, update, Shared};
use icue_edge_companion::usage::{self, claude, codex, store};
use icue_edge_companion::{http, media, spotify, util};

const APP_NAME: &str = "iCUE Edge Companion";
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
/// Where Task Manager keeps the enabled/disabled switch of each Run entry (first byte: 02 on, 03 off).
/// Some Task Manager builds list only entries that have a value here.
const APPROVED_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const APPROVED_ON: &str = "020000000000000000000000";
const MAIN: &str = "main";
const TRAY: &str = "tray";
const TRAY_SIZE: (f64, f64) = (340.0, 540.0);

fn hidden(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

// ---------- windows: created on demand, destroyed when closed or unfocused ----------

/// Window work never runs inside a Win32 message callback (tray click, single-instance
/// message): WebView2 creation there deadlocks, because a message sent by another process
/// forbids the COM calls WebView2 needs. Tauri supports creating windows from any thread.
fn later(app: &AppHandle, job: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    std::thread::spawn(move || job(&app));
}

fn open_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(TRAY) {
        let _ = w.destroy();
    }
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    // No system frame: the page draws its own window buttons and drag strip.
    let _ = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title(APP_NAME)
        .inner_size(1080.0, 720.0)
        .min_inner_size(696.0, 416.0)
        .decorations(false)
        // Matches the default OLED theme so the window never flashes white while loading.
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .build();
}

/// Card-style tray menu anchored above the cursor; it disappears as soon as it loses focus.
fn open_tray_popup(app: &AppHandle, at: PhysicalPosition<f64>) {
    if let Some(w) = app.get_webview_window(TRAY) {
        let _ = w.destroy();
        return;
    }
    let Ok(w) = WebviewWindowBuilder::new(app, TRAY, WebviewUrl::App("tray.html".into()))
        .title(APP_NAME)
        .inner_size(TRAY_SIZE.0, TRAY_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
    else {
        return;
    };
    let size = w.outer_size().unwrap_or_default();
    let (mut x, mut y) = (at.x as i32 - size.width as i32, at.y as i32 - size.height as i32);
    if let Ok(Some(m)) = w.current_monitor() {
        let (mx, my) = (m.position().x, m.position().y);
        let (mw, mh) = (m.size().width as i32, m.size().height as i32);
        x = x.clamp(mx, mx + mw - size.width as i32);
        // Taskbar at the top: open below the cursor instead.
        if y < my {
            y = (at.y as i32).min(my + mh - size.height as i32);
        }
    }
    let _ = w.set_position(PhysicalPosition::new(x, y));
    // Windows hands focus back to the taskbar right after the click that opened the card.
    // During a short grace period a blur only takes focus back; after it, a blur closes the card.
    // Both actions run outside the window's own event callback, on a fresh lookup of the window,
    // so a card that is already gone is never touched again.
    let shown_at = std::time::Instant::now();
    let handle = app.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::Focused(false) = e {
            let refocus = shown_at.elapsed() < Duration::from_millis(1200);
            let app = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(if refocus { 60 } else { 30 }));
                if let Some(card) = app.get_webview_window(TRAY) {
                    let _ = if refocus { card.set_focus() } else { card.destroy() };
                }
            });
        }
    });
    let _ = w.show();
    let _ = w.set_focus();
}

// ---------- commands (Tauri IPC for the window and the tray card; never exposed over HTTP) ----------

// All commands are async: Tauri runs them off the main thread, so a slow process launch
// (reg.exe) or a window creation can never freeze the event loop.

fn shared_of(app: &AppHandle) -> Shared {
    Arc::clone(&app.state::<Shared>())
}

#[tauri::command]
async fn usage_state(app: AppHandle) -> serde_json::Value {
    store::snapshot(&lock(&shared_of(&app)))
}

#[tauri::command]
async fn usage_refresh(app: AppHandle) -> bool {
    http::request_refresh(&shared_of(&app))
}

/// Everything the Overview, Widgets and Settings pages need.
#[tauri::command]
async fn app_info(app: AppHandle) -> serde_json::Value {
    let autostart = autostart_enabled();
    let shared = shared_of(&app);
    let st = lock(&shared);
    json!({
        "version": app.package_info().version.to_string(),
        "autostart": autostart,
        "renewClaudeToken": st.saved.renew_claude_token,
        "serverError": st.server_error,
        "port": http::PORT,
        "pumpRelay": media::relay::status(),
        "widgets": icue_edge_companion::widgets::inventory(),
        "edgeLayout": icue_edge_companion::widgets::edge_layout_now(),
    })
}

/// The media snapshot for the Overview; the artwork travels as a data URL (the window never uses the HTTP server),
/// and only when it differs from `known`, the artwork key the window already holds.
#[tauri::command]
async fn media_state(known: Option<String>) -> serde_json::Value {
    let (mut snap, art) = {
        let st = media::lock();
        let snap = media::snapshot(&st);
        let art = snap.pointer("/session/art").and_then(|a| media::art_for(&st, a["sessionId"].as_str()?, a["rev"].as_u64()?));
        (snap, art)
    };
    if let Some(a) = snap.pointer_mut("/session/art") {
        let key = format!("{}:{}", a["sessionId"].as_str().unwrap_or(""), a["rev"]);
        if known.as_deref() == Some(key.as_str()) && art.is_some() {
            *a = json!({ "key": key });
            return snap;
        }
        *a = match art {
            Some((mime, bytes)) => {
                // Standard padded base64 from the base64url encoder already used for PKCE.
                let b = spotify::auth::b64url(&bytes).replace('-', "+").replace('_', "/");
                json!({ "key": key, "url": format!("data:{mime};base64,{b}{}", "=".repeat((4 - b.len() % 4) % 4)) })
            }
            None => serde_json::Value::Null,
        };
    }
    snap
}

/// Play / pause, previous and next from the Overview's Now Playing card; validated like a widget's command.
#[tauri::command]
async fn media_command(body: serde_json::Value) -> Result<bool, String> {
    let target = media::resolve(&media::lock(), &body, icue_edge_companion::util::now_ms()).map_err(|(_, e)| e.to_string())?;
    media::execute(&target)
}

/// The Screen Time page: today's figures, without switching collection on.
#[tauri::command]
async fn screentime_state() -> serde_json::Value {
    icue_edge_companion::screentime::snapshot_now()
}

/// The Screen Time page's Start button: the same switch the widget's first request flips.
#[tauri::command]
async fn screentime_enable() -> serde_json::Value {
    icue_edge_companion::screentime::enable();
    icue_edge_companion::screentime::snapshot_now()
}

#[tauri::command]
async fn set_paused(app: AppHandle, paused: bool) {
    update(&shared_of(&app), |st| st.paused = paused);
}

/// Turning it on retries the limits at once, so an expired sign-in is renewed right away.
#[tauri::command]
async fn set_renew_claude_token(app: AppHandle, enabled: bool) {
    let shared = shared_of(&app);
    update(&shared, |st| {
        st.saved.renew_claude_token = enabled;
        if enabled {
            st.claude.next_quota_try = 0;
            st.claude.quota_backoff = 0;
        }
    });
    let _ = store::save(&shared);
}

#[tauri::command]
async fn set_autostart(enabled: bool) -> bool {
    write_autostart(enabled)
}

fn write_autostart(enabled: bool) -> bool {
    let reg = |args: &[&str]| hidden(std::process::Command::new(util::system_exe("reg.exe")).args(args)).output().is_ok_and(|o| o.status.success());
    let ok = if enabled {
        let Ok(exe) = std::env::current_exe() else { return false };
        // The approved value also re-enables an entry switched off in Task Manager.
        reg(&["add", RUN_KEY, "/v", APP_NAME, "/t", "REG_SZ", "/d", &format!("\"{}\"", exe.display()), "/f"])
            && reg(&["add", APPROVED_KEY, "/v", APP_NAME, "/t", "REG_BINARY", "/d", APPROVED_ON, "/f"])
    } else {
        let _ = reg(&["delete", APPROVED_KEY, "/v", APP_NAME, "/f"]);
        reg(&["delete", RUN_KEY, "/v", APP_NAME, "/f"])
    };
    ok && autostart_enabled() == enabled
}

/// Clears hourly history and events. Offsets, dedup keys and Codex per-session
/// high-water marks stay, so nothing already read is counted again.
#[tauri::command]
async fn clear_history(app: AppHandle) {
    let shared = shared_of(&app);
    update(&shared, |st| {
        st.saved.claude.hours.clear();
        st.saved.codex.hours.clear();
        st.claude.events.clear();
        st.codex.events.clear();
    });
    let _ = store::save(&shared);
}

// ---------- Spotify page (the tokens never reach the page) ----------

#[tauri::command]
async fn spotify_page() -> serde_json::Value {
    spotify::page(&spotify::lock())
}

/// Starts the PKCE sign-in and opens the Spotify authorization page in the default browser.
#[tauri::command]
async fn spotify_connect(client_id: String) -> Result<(), String> {
    // An empty id means "connect again with the saved Client ID".
    let id = match client_id.trim() {
        "" => spotify::lock().client_id.clone().unwrap_or_default(),
        typed => typed.to_string(),
    };
    let url = spotify::auth::begin(&id).map_err(String::from)?;
    // Only the accounts.spotify.com URL built above is ever opened.
    hidden(&mut std::process::Command::new(util::system_exe("rundll32.exe"))).args(["url.dll,FileProtocolHandler", &url]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Installs or updates one of our widgets: the package goes to iCUE through its file association, as a
/// double-click would, so iCUE itself asks to confirm and installs it.
#[tauri::command]
async fn install_widget(id: String) -> Result<(), String> {
    let path = tauri::async_runtime::spawn_blocking(move || icue_edge_companion::widgets::package_file(&id)).await.map_err(|e| e.to_string())??;
    hidden(&mut std::process::Command::new(util::system_exe("rundll32.exe"))).arg("url.dll,FileProtocolHandler").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Brings iCUE to the front (it keeps a single instance), so a pump widget can be sent while the pump's
/// screen is open: iCUE ignores pump widgets opened from the XENEON EDGE page.
#[tauri::command]
fn open_icue() -> Result<(), String> {
    let exe = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from(r"C:\Program Files"))
        .join(r"Corsair\Corsair iCUE5 Software\iCUE.exe");
    if !exe.is_file() {
        return Err("iCUE was not found".into());
    }
    std::process::Command::new(exe).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Shows one of our packages selected in File Explorer, for the Import button of iCUE's pump screen.
#[tauri::command]
async fn show_package(id: String) -> Result<(), String> {
    let path = tauri::async_runtime::spawn_blocking(move || icue_edge_companion::widgets::package_file(&id)).await.map_err(|e| e.to_string())??;
    let explorer = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows")).join("explorer.exe");
    let mut cmd = std::process::Command::new(explorer);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The path is ours (package_file only knows our ids); quoted for spaces.
        cmd.raw_arg(format!("/select,\"{}\"", path.display()));
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The community widget list for the Community page (installed ones marked).
#[tauri::command]
async fn community() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(icue_edge_companion::community::page).await.unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

/// Installs a listed community widget: checked download, then iCUE opens it and asks to confirm.
#[tauri::command]
async fn community_install(key: String) -> Result<(), String> {
    let path = tauri::async_runtime::spawn_blocking(move || icue_edge_companion::community::package(&key)).await.map_err(|e| e.to_string())??;
    hidden(&mut std::process::Command::new(util::system_exe("rundll32.exe"))).arg("url.dll,FileProtocolHandler").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens a listed community widget's source on GitHub (the address comes from the list, not from the page).
#[tauri::command]
async fn community_source(key: String) -> Result<(), String> {
    let url = tauri::async_runtime::spawn_blocking(move || icue_edge_companion::community::source_url(&key)).await.map_err(|e| e.to_string())??;
    hidden(&mut std::process::Command::new(util::system_exe("rundll32.exe"))).args(["url.dll,FileProtocolHandler", &url]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens a listed Elgato Marketplace widget's page: free ones are taken there with an Elgato account, paid ones bought.
#[tauri::command]
async fn marketplace_open(id: String) -> Result<(), String> {
    let url = tauri::async_runtime::spawn_blocking(move || icue_edge_companion::community::marketplace_url(&id)).await.map_err(|e| e.to_string())??;
    hidden(&mut std::process::Command::new(util::system_exe("rundll32.exe"))).args(["url.dll,FileProtocolHandler", &url]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The repository's CHANGELOG.md, built into the companion: the window's Changelog page shows it.
#[tauri::command]
fn changelog() -> &'static str {
    include_str!("../../../CHANGELOG.md")
}

/// Opens one of the About links in the default browser. The page names a link; it never supplies a URL.
#[tauri::command]
async fn open_link(link: String) -> Result<(), String> {
    let url = match link.as_str() {
        "repo" => "https://github.com/inerthel-agi/icue-edge-widgets/",
        "profile" => "https://github.com/inerthel-agi",
        "packages" => "https://github.com/inerthel-agi/icue-edge-widgets/tree/main/dist/icuewidgets",
        "marketplace" => "https://marketplace.elgato.com/icue",
        "marketplace-widgets" => "https://marketplace.elgato.com/icue/widgets",
        "marketplace-library" => "https://marketplace.elgato.com/account/products",
        _ => return Err("unknown link".into()),
    };
    hidden(&mut std::process::Command::new(util::system_exe("rundll32.exe"))).args(["url.dll,FileProtocolHandler", url]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn spotify_cancel() {
    spotify::auth::cancel();
}

#[tauri::command]
async fn spotify_disconnect() {
    spotify::disconnect();
}

#[tauri::command]
async fn open_main(app: AppHandle) {
    open_window(&app);
}

#[tauri::command]
async fn quit_app(app: AppHandle) {
    let _ = store::save(&shared_of(&app));
    app.exit(0);
}

/// On when the Run entry exists and Task Manager has not switched it off.
fn autostart_enabled() -> bool {
    let query = |key: &str| hidden(std::process::Command::new(util::system_exe("reg.exe")).args(["query", key, "/v", APP_NAME])).output().ok().filter(|o| o.status.success());
    query(RUN_KEY).is_some() && !query(APPROVED_KEY).is_some_and(|o| approved_off(&String::from_utf8_lossy(&o.stdout)))
}

/// `reg query` line `    iCUE Edge Companion    REG_BINARY    0300â€¦`: an odd first byte means disabled.
fn approved_off(out: &str) -> bool {
    out.split_whitespace().skip_while(|w| *w != "REG_BINARY").nth(1).and_then(|hex| u8::from_str_radix(hex.get(..2)?, 16).ok()).is_some_and(|b| b & 1 == 1)
}

#[cfg(test)]
mod tests {
    #[test]
    fn task_manager_switch_is_read() {
        assert!(super::approved_off("\r\nHKEY_CURRENT_USER\\...\\Run\r\n    iCUE Edge Companion    REG_BINARY    030000000000000000000000\r\n"));
        assert!(!super::approved_off("    iCUE Edge Companion    REG_BINARY    020000000000000000000000"));
        assert!(!super::approved_off(""));
    }
}

// ---------- tray icon ----------

fn tooltip(shared: &Shared) -> String {
    let st = lock(shared);
    if let Some(e) = &st.server_error {
        return format!("{APP_NAME}\n{e}");
    }
    let snap = store::snapshot(&st);
    let line = |pid: &str| {
        let p = &snap["providers"][pid];
        let top = p["quotas"].as_array().and_then(|q| q.iter().filter_map(|q| q["used"]["v"].as_f64()).reduce(f64::max));
        match top {
            // Codex is shown as what is left, like the Codex app.
            Some(v) if pid == "codex" => format!("{}: {}% left on the closest limit", p["name"].as_str().unwrap_or(pid), (100.0 - v).round()),
            Some(v) => format!("{}: {}% of the closest limit", p["name"].as_str().unwrap_or(pid), v.round()),
            None => format!("{}: {}", p["name"].as_str().unwrap_or(pid), p["status"]["label"].as_str().unwrap_or("?")),
        }
    };
    format!("{APP_NAME}\n{}\n{}", line("claude"), line("codex"))
}

fn build_tray(app: &AppHandle, shared: Shared) -> tauri::Result<()> {
    let tray = TrayIconBuilder::with_id("main")
        .tooltip(APP_NAME)
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, button_state: MouseButtonState::Up, position, .. } = event {
                match button {
                    MouseButton::Left => later(tray.app_handle(), open_window),
                    MouseButton::Right => later(tray.app_handle(), move |app| open_tray_popup(app, position)),
                    _ => {}
                }
            }
        })
        .build(app)?;
    std::thread::spawn(move || loop {
        let _ = tray.set_tooltip(Some(&tooltip(&shared)));
        std::thread::sleep(Duration::from_secs(10));
    });
    Ok(())
}

/// Pushes each store change to open windows only; nothing is rendered when none is open.
fn forward_to_windows(app: AppHandle, shared: Shared) {
    let mut seen = 0u64;
    loop {
        let snap = {
            let mut st = lock(&shared);
            if st.version == seen {
                st = shared.changed.wait_timeout(st, Duration::from_secs(5)).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
            }
            if st.version == seen {
                continue;
            }
            seen = st.version;
            store::snapshot(&st)
        }; // store lock released here, before any call into Tauri
        if !app.webview_windows().is_empty() {
            let _ = app.emit("usage-state", snap);
        }
    }
}

/// Spotify page data to open windows, on each change of the Spotify state.
fn forward_spotify(app: AppHandle) {
    let mut seen = 0u64;
    loop {
        let page = {
            let mut st = spotify::lock();
            if st.version == seen {
                st = spotify::HUB.changed.wait_timeout(st, Duration::from_secs(5)).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
            }
            if st.version == seen {
                continue;
            }
            seen = st.version;
            spotify::page(&st)
        };
        if !app.webview_windows().is_empty() {
            let _ = app.emit("spotify-state", page);
        }
    }
}

fn main() {
    // Bearer-token access to the HTTP server is for scripts/latency-test.py only; iCUE never needs it.
    http::TOKEN_ENABLED.store(std::env::args().any(|a| a == "--allow-token"), std::sync::atomic::Ordering::Relaxed);
    let shared = store::load();
    let for_exit = Arc::clone(&shared);

    let app = tauri::Builder::default()
        // A second launch opens the window; `--tray` opens the tray card at the cursor instead.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--tray") {
                later(app, |app| open_tray_popup(app, app.cursor_position().unwrap_or_default()));
            } else {
                later(app, open_window);
            }
        }))
        .manage(Arc::clone(&shared))
        .invoke_handler(tauri::generate_handler![
            usage_state,
            usage_refresh,
            app_info,
            media_state,
            set_paused,
            set_autostart,
            set_renew_claude_token,
            screentime_state,
            media_command,
            screentime_enable,
            clear_history,
            open_main,
            install_widget,
            open_icue,
            changelog,
            community,
            community_install,
            community_source,
            marketplace_open,
            show_package,
            open_link,
            quit_app,
            spotify_page,
            spotify_connect,
            spotify_cancel,
            spotify_disconnect
        ])
        .setup(move |app| {
            for (name, job) in [
                ("codex", codex::run as fn(Shared)),
                ("codex-quota", codex::run_quota),
                ("claude", claude::run),
                ("claude-quota", claude::run_quota),
                ("http", http::run),
                ("apps", usage::apps::run),
            ] {
                let s = Arc::clone(&shared);
                std::thread::Builder::new().name(name.into()).spawn(move || job(s))?;
            }
            std::thread::Builder::new().name("media".into()).spawn(media::run)?;
            std::thread::Builder::new().name("screentime".into()).spawn(icue_edge_companion::screentime::run)?;
            std::thread::Builder::new().name("game".into()).spawn(icue_edge_companion::game::run)?;
            std::thread::Builder::new().name("media-relay".into()).spawn(media::relay::run)?;
            std::thread::Builder::new().name("media-lyrics".into()).spawn(media::run_lyrics)?;
            std::thread::Builder::new().name("media-viz".into()).spawn(media::viz::run)?;
            std::thread::Builder::new().name("spotify".into()).spawn(spotify::api::run)?;
            let spotify_app = app.handle().clone();
            std::thread::spawn(move || forward_spotify(spotify_app));
            // Saved once at start (the widget token must exist on disk), then every 2 minutes.
            // Offsets and dedup keys are saved together, so a crash between saves only re-reads, never recounts.
            let saver = Arc::clone(&shared);
            std::thread::spawn(move || loop {
                let _ = store::save(&saver);
                std::thread::sleep(Duration::from_millis(2 * util::MIN));
            });
            let (handle, s) = (app.handle().clone(), Arc::clone(&shared));
            std::thread::spawn(move || forward_to_windows(handle, s));
            build_tray(app.handle(), Arc::clone(&shared))?;
            // A moved or replaced exe would leave autostart launching the old one: point it at this exe.
            std::thread::spawn(|| {
                if autostart_enabled() {
                    let _ = write_autostart(true);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start iCUE Edge Companion");

    app.run(move |_app, event| match event {
        // Closing every window keeps the companion in the tray until "Quit".
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        RunEvent::Exit => {
            let _ = store::save(&for_exit);
        }
        _ => {}
    });
}
