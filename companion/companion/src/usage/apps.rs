//! Which Claude and Codex apps are open right now, from the process list (names and paths only).
//! Logs only show activity; an app left open without a conversation writes nothing.
use std::time::Duration;

use crate::usage::store::{lock, update, Shared};
use crate::util::exe_path;

/// (pid, parent pid, lowercase exe name)
type Entry = (u32, u32, String);

/// Returns (Claude labels, Codex labels), with the same labels as the log clients ("Desktop", "CLI").
fn classify(entries: &[Entry], path: impl Fn(u32) -> Option<String>, me: u32) -> (Vec<&'static str>, Vec<&'static str>) {
    let by_pid: std::collections::HashMap<u32, &Entry> = entries.iter().map(|e| (e.0, e)).collect();
    // Ancestor names, bounded in case of recycled PIDs or cycles.
    let ancestors = |mut pid: u32| {
        let mut out = Vec::new();
        for _ in 0..32 {
            let Some(e) = by_pid.get(&pid) else { break };
            if e.1 == pid || e.1 == 0 {
                break;
            }
            pid = e.1;
            if pid == me {
                out.push("<self>");
            }
            if let Some(p) = by_pid.get(&pid) {
                out.push(p.2.as_str());
            }
        }
        out
    };
    let (mut claude, mut codex) = (Vec::new(), Vec::new());
    let add = |v: &mut Vec<&'static str>, l: &'static str| {
        if !v.contains(&l) {
            v.push(l);
        }
    };
    for (pid, _, name) in entries {
        let up = ancestors(*pid);
        match name.as_str() {
            // Claude Desktop and the native Claude Code CLI share the exe name: tell them apart by install path.
            "claude.exe" if !up.contains(&"claude.exe") => {
                let p = path(*pid).unwrap_or_default().to_ascii_lowercase();
                let app = p.contains("\\windowsapps\\claude_") || p.contains("\\anthropicclaude\\");
                add(&mut claude, if app { "Desktop" } else { "CLI" });
            }
            // The Codex desktop app ships as ChatGPT.exe inside the OpenAI.Codex package.
            "chatgpt.exe" if !up.contains(&"chatgpt.exe") => {
                if path(*pid).unwrap_or_default().to_ascii_lowercase().contains("openai.codex") {
                    add(&mut codex, "Desktop");
                }
            }
            "codex.exe" if !up.iter().any(|a| matches!(*a, "codex.exe" | "chatgpt.exe" | "<self>" | "codex-rich-presence.exe" | "icue-edge-companion.exe")) => {
                // Copies bundled with the desktop app and its background daemon outlive their parent: not a CLI.
                let p = path(*pid).unwrap_or_default().to_ascii_lowercase();
                if !p.contains("\\openai\\codex\\bin\\") && !p.contains("\\app-server-daemon\\") {
                    add(&mut codex, "CLI");
                }
            }
            _ => {}
        }
    }
    (claude, codex)
}

#[cfg(windows)]
pub(crate) fn entries() -> Vec<Entry> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else { return Vec::new() };
    let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut out = Vec::new();
    if unsafe { Process32FirstW(snap, &mut e) }.is_ok() {
        loop {
            let len = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
            out.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..len]).to_ascii_lowercase()));
            if unsafe { Process32NextW(snap, &mut e) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snap) };
    out
}

#[cfg(not(windows))]
pub(crate) fn entries() -> Vec<Entry> {
    Vec::new()
}

/// Scans every 5 s and pushes a new state only when the set of open apps changes.
pub fn run(shared: Shared) {
    loop {
        let (claude, codex) = classify(&entries(), exe_path, std::process::id());
        let changed = {
            let st = lock(&shared);
            st.claude.running != claude || st.codex.running != codex
        };
        if changed {
            update(&shared, |st| {
                st.claude.running = claude;
                st.codex.running = codex;
            });
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_apps_and_skips_helpers() {
        let e = |pid, ppid, n: &str| (pid, ppid, n.to_string());
        let entries = vec![
            e(10, 1, "chatgpt.exe"),   // Codex desktop
            e(11, 10, "chatgpt.exe"),  // its renderer
            e(12, 10, "codex.exe"),    // app-server of the desktop app: not the CLI
            e(20, 1, "claude.exe"),    // Claude Desktop
            e(21, 20, "claude.exe"),   // Claude Code inside Desktop
            e(30, 99, "codex.exe"),    // our own app-server probe
            e(40, 2, "codex-rich-presence.exe"),
            e(41, 40, "codex.exe"),    // codex-rpc probe
        ];
        let path = |pid| match pid {
            10 => Some(r"C:\Program Files\WindowsApps\OpenAI.Codex_1_x64__x\app\ChatGPT.exe".into()),
            20 => Some(r"C:\Program Files\WindowsApps\Claude_2_x64__x\app\Claude.exe".into()),
            _ => None,
        };
        let entries_with_self = [entries.clone(), vec![e(99, 1, "icue-edge-companion.exe")]].concat();
        assert_eq!(classify(&entries_with_self, path, 99), (vec!["Desktop"], vec!["Desktop"]));

        let cli = vec![e(50, 1, "powershell.exe"), e(51, 50, "codex.exe"), e(52, 50, "claude.exe")];
        assert_eq!(classify(&cli, |_| Some(r"C:\Users\u\.local\bin\claude.exe".into()), 99), (vec!["CLI"], vec!["CLI"]));

        // Orphaned daemon of the desktop app is not a CLI.
        let daemon = vec![e(70, 555, "codex.exe")];
        assert_eq!(classify(&daemon, |_| Some(r"C:\Users\u\.codex\packages\app-server-daemon\releases\0.1\bin\codex.exe".into()), 99), (vec![], vec![]));

        // The ChatGPT desktop app (not Codex) is ignored.
        let chat = vec![e(60, 1, "chatgpt.exe")];
        assert_eq!(classify(&chat, |_| Some(r"C:\Program Files\WindowsApps\OpenAI.ChatGPT-Desktop_1\app\ChatGPT.exe".into()), 99), (vec![], vec![]));
    }
}
