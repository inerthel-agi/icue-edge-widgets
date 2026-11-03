//! Codex collector.
//! Tokens: `event_msg/token_count` → `payload.info.total_token_usage` is cumulative per session.
//! Verified on local files: total_tokens = input_tokens + output_tokens, so cached_input ⊂ input
//! and reasoning_output ⊂ output. Only growth over the session's high-water mark is counted,
//! which absorbs repeated events, resumed sessions and replayed history.
//! Quotas: `payload.rate_limits` from the same events; `codex app-server` only as a fallback.
//! Process spawning and parsing adapted from codex-rpc (MIT, © Inerthel).
use crate::usage::store::{self, hour_of, lock, update, Quota, QuotaSet, Session, Shared, Tok, ACTIVE_MS};
use crate::tail::Tail;
use crate::util::{civil_from_days, home_dir, now_ms, parse_iso_ms, pseudonym, DAY, MIN, SEC};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const LOCAL_SRC: &str = "Local Codex events (rate_limits)";
const SERVER_SRC: &str = "codex app-server · account/rateLimits/read";
const MAX_APP_SERVER_BYTES: usize = 1024 * 1024;

#[cfg(windows)]
struct ProcessJob(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ProcessJob {
    fn assign(child: &std::process::Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        };
        let assigned = configured.and_then(|_| unsafe { AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())) });
        if assigned.is_err() {
            let _ = unsafe { CloseHandle(job) };
            return None;
        }
        Some(Self(job))
    }
}

/// Resumes a process started with CREATE_SUSPENDED (std keeps no handle to its main thread).
#[cfg(windows)]
fn resume(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32};
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }) else { return false };
    let mut e = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
    let mut resumed = false;
    let mut more = unsafe { Thread32First(snap, &mut e) }.is_ok();
    while more {
        if e.th32OwnerProcessID == pid {
            if let Ok(thread) = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, e.th32ThreadID) } {
                resumed |= unsafe { ResumeThread(thread) } != u32::MAX;
                let _ = unsafe { CloseHandle(thread) };
            }
        }
        more = unsafe { Thread32Next(snap, &mut e) }.is_ok();
    }
    let _ = unsafe { CloseHandle(snap) };
    resumed
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}

fn read_app_server_answer(out: impl std::io::Read) -> Option<Value> {
    let mut reader = BufReader::new(out);
    let mut read = 0usize;
    loop {
        let mut line = Vec::new();
        let n = reader.by_ref().take((MAX_APP_SERVER_BYTES + 1 - read) as u64).read_until(b'\n', &mut line).ok()?;
        if n == 0 || read + n > MAX_APP_SERVER_BYTES {
            return None;
        }
        read += n;
        if let Ok(v) = serde_json::from_slice::<Value>(&line) {
            if v.get("id").is_some_and(|id| id.as_u64() == Some(1) || id.as_str() == Some("1")) {
                return Some(v);
            }
        }
    }
}

fn sessions_root() -> PathBuf {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home_dir().join(".codex")).join("sessions")
}

pub fn window_label(minutes: Option<u64>) -> String {
    match minutes {
        Some(300) => "5-hour limit".into(),
        Some(10080) => "Weekly limit".into(),
        Some(m) if m % 1440 == 0 => format!("{}-day limit", m / 1440),
        Some(m) if m % 60 == 0 => format!("{}-hour limit", m / 60),
        Some(m) => format!("{m}-minute limit"),
        None => "Limit".into(),
    }
}

fn client_label(originator: &str) -> String {
    let o = originator.to_ascii_lowercase();
    if o.contains("vscode") || o.contains("ide") || o.contains("jetbrains") {
        "IDE".into()
    } else if o.contains("desktop") || o.contains("app") {
        "Desktop".into()
    } else if o.contains("cli") || o.contains("exec") || o.is_empty() {
        "CLI".into()
    } else {
        originator.chars().take(24).collect()
    }
}

fn tok(v: &Value) -> Tok {
    let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    Tok {
        input: n("input_tokens"),
        output: n("output_tokens"),
        cache_read: n("cached_input_tokens"),
        cache_write: n("cache_write_input_tokens"),
        reasoning: n("reasoning_output_tokens"),
    }
}

fn parse_limit(v: &Value, id: &str, ms_multiplier: u64, camel: bool) -> Option<Quota> {
    let (used, win, reset) = if camel { ("usedPercent", "windowDurationMins", "resetsAt") } else { ("used_percent", "window_minutes", "resets_at") };
    let window = v.get(win).and_then(Value::as_f64).map(|m| m.round().max(0.0) as u64);
    Some(Quota {
        id: id.into(),
        label: window_label(window),
        used: v.get(used)?.as_f64()?.clamp(0.0, 100.0),
        window_minutes: window,
        resets_at: v.get(reset).and_then(Value::as_u64).map(|s| s * ms_multiplier),
    })
}

fn parse_rate_limits(rl: &Value, camel: bool) -> Option<(Vec<Quota>, Option<Value>)> {
    let limit_id = rl.get(if camel { "limitId" } else { "limit_id" }).and_then(Value::as_str);
    if limit_id.is_some_and(|id| id != "codex") {
        return None;
    }
    let quotas: Vec<Quota> = ["primary", "secondary"]
        .iter()
        .filter_map(|k| rl.get(*k).filter(|v| !v.is_null()).and_then(|v| parse_limit(v, k, 1000, camel)))
        .collect();
    let credits = rl.get("credits").filter(|c| {
        c.get("has_credits").or_else(|| c.get("hasCredits")).and_then(Value::as_bool).unwrap_or(false)
            || c.get("unlimited").and_then(Value::as_bool).unwrap_or(false)
    });
    let credits = credits.map(|c| {
        serde_json::json!({
            "balance": c.get("balance").or_else(|| c.get("remaining")).cloned(),
            "unlimited": c.get("unlimited").and_then(Value::as_bool).unwrap_or(false),
        })
    });
    (!quotas.is_empty()).then_some((quotas, credits))
}

/// Records a quota observation; detects resets from the reported values only.
fn apply_quotas(st: &mut store::Store, quotas: Vec<Quota>, credits: Option<Value>, at: u64, src: &str) {
    let saved = &mut st.saved.codex;
    if at < saved.quota.observed_at {
        return;
    }
    for q in &quotas {
        if let Some(old) = saved.quota.quotas.iter().find(|o| o.id == q.id) {
            let later_reset = matches!((old.resets_at, q.resets_at), (Some(a), Some(b)) if b > a + MIN);
            if later_reset && q.used < old.used {
                st.codex.event(at, format!("{} reset (reported value: {}%)", q.label, q.used.round()));
            }
        }
    }
    saved.set_quota(QuotaSet { quotas, observed_at: at, src: src.into(), credits });
}

struct Parsed {
    session_meta: Option<(String, String, u64)>,
    model: Option<String>,
    total: Option<(Tok, u64)>,
    context: Option<(u64, Option<u64>)>,
    rate_limits: Option<(Vec<Quota>, Option<Value>)>,
    ts: u64,
}

fn parse_line(line: &str) -> Option<Parsed> {
    // Cheap filter: most lines are conversation items we never parse.
    if !(line.contains("\"token_count\"") || line.contains("\"session_meta\"") || line.contains("\"turn_context\"")) {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let ts = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(0);
    let payload = v.get("payload")?;
    let mut p = Parsed { session_meta: None, model: None, total: None, context: None, rate_limits: None, ts };
    match (v.get("type").and_then(Value::as_str), payload.get("type").and_then(Value::as_str)) {
        (Some("session_meta"), _) => {
            let id = payload.get("id").or_else(|| payload.get("session_id")).and_then(Value::as_str)?;
            let originator = payload.get("originator").and_then(Value::as_str).unwrap_or("");
            let started = payload.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(ts);
            p.session_meta = Some((id.to_string(), client_label(originator), started));
        }
        (Some("turn_context"), _) => p.model = payload.get("model").and_then(Value::as_str).map(str::to_string),
        (Some("event_msg"), Some("token_count")) => {
            if let Some(info) = payload.get("info").filter(|i| !i.is_null()) {
                if let Some(total) = info.get("total_token_usage") {
                    p.total = Some((tok(total), ts));
                }
                let last = info.get("last_token_usage").and_then(|l| l.get("total_tokens")).and_then(Value::as_u64);
                let window = info.get("model_context_window").and_then(Value::as_u64);
                p.context = last.map(|l| (l, window));
            }
            p.rate_limits = payload.get("rate_limits").filter(|r| !r.is_null()).and_then(|r| parse_rate_limits(r, false));
        }
        _ => return None,
    }
    Some(p)
}

/// Reads the first line of a file resumed from a saved offset (session_meta carries the session id).
fn first_line(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(std::io::Read::take(file, 4 * 1024 * 1024)).read_line(&mut line).ok().filter(|n| *n > 0)?;
    Some(line)
}

fn apply(shared: &Shared, path_key: &str, parsed: Vec<Parsed>) {
    update(shared, |st| {
        let salt = st.saved.salt.clone();
        let now = now_ms();
        for p in parsed {
            let ctx = st.saved.codex.files.entry(path_key.to_string()).or_default();
            ctx.last_seen = now;
            if let Some((id, client, started)) = p.session_meta {
                ctx.session = id.clone();
                ctx.client = client.clone();
                let s = st.saved.codex.sessions.entry(id.clone()).or_insert_with(|| Session { id: pseudonym("x", &salt, &id), ..Default::default() });
                s.client = client;
                if s.started == 0 || started < s.started {
                    s.started = started;
                }
                continue;
            }
            let sid = ctx.session.clone();
            if sid.is_empty() {
                continue;
            }
            let client = ctx.client.clone();
            let s = st.saved.codex.sessions.entry(sid.clone()).or_insert_with(|| Session { id: pseudonym("x", &salt, &sid), client, started: p.ts, ..Default::default() });
            s.last_event = s.last_event.max(p.ts);
            if let Some(model) = p.model {
                if !s.model.is_empty() && s.model != model {
                    let text = format!("Model changed: {} → {} (session {})", s.model, model, s.id);
                    s.model = model;
                    st.codex.event(p.ts, text);
                } else {
                    s.model = model;
                }
            }
            let s = st.saved.codex.sessions.get_mut(&sid).unwrap();
            if let Some((total, ts)) = p.total {
                let growth = total.growth_over(&s.tokens);
                s.tokens = s.tokens.max(&total);
                if !growth.is_zero() {
                    st.saved.codex.hours.entry(hour_of(ts)).or_default().add(&growth);
                }
            }
            let s = st.saved.codex.sessions.get_mut(&sid).unwrap();
            if let Some((used, cap)) = p.context {
                if p.ts >= s.context_at {
                    s.context_used = Some(used);
                    s.context_cap = cap;
                    s.context_at = p.ts;
                }
            }
            if let Some((quotas, credits)) = p.rate_limits {
                apply_quotas(st, quotas, credits, p.ts, LOCAL_SRC);
            }
        }
    });
}

/// Candidate rollout files: today's date folders (±1 day for time zones), or a
/// bounded full walk every 10 minutes to catch sessions resumed in older folders.
fn discover(root: &Path, full: bool, now: u64) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if full {
        dirs.push(root.to_path_buf());
    } else {
        let today = (now / DAY) as i64;
        for d in today - 2..=today + 1 {
            let (y, m, dd) = civil_from_days(d);
            dirs.push(root.join(format!("{y:04}")).join(format!("{m:02}")).join(format!("{dd:02}")));
        }
    }
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, u8)> = dirs.into_iter().map(|d| (d, 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                if full && depth < 3 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let recent = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64 + 2 * DAY > now).unwrap_or(false);
            if name.starts_with("rollout-") && name.ends_with(".jsonl") && recent {
                out.push(path);
            }
        }
    }
    out
}

pub fn run(shared: Shared) {
    let root = sessions_root();
    let mut tails: HashMap<String, Tail> = HashMap::new();
    let (mut last_discover, mut last_full) = (0u64, 0u64);
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let now = now_ms();
        let detected = root.is_dir();
        {
            let mut st = lock(&shared);
            if st.codex.detected != detected {
                st.codex.detected = detected;
                // Widgets and the window must see this at once, not at the next unrelated update.
            st.dirty = true;
            st.version += 1;
            shared.changed.notify_all();
            }
            if st.paused || !detected {
                continue;
            }
        }
        if now >= last_discover + 10 * SEC {
            let full = now >= last_full + 10 * MIN;
            for path in discover(&root, full, now) {
                let key = path.to_string_lossy().to_string();
                if tails.contains_key(&key) {
                    continue;
                }
                let saved = lock(&shared).saved.codex.files.get(&key).cloned();
                let offset = saved.as_ref().map(|f| f.offset).unwrap_or(0);
                if offset > 0 && saved.as_ref().is_some_and(|f| f.session.is_empty()) {
                    if let Some(p) = first_line(&path).as_deref().and_then(parse_line) {
                        apply(&shared, &key, vec![p]);
                    }
                }
                tails.insert(key, Tail::new(path, offset));
            }
            tails.retain(|_, t| {
                std::fs::metadata(&t.path).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64 + 2 * DAY > now).unwrap_or(false)
            });
            last_discover = now;
            if full {
                last_full = now;
            }
        }
        let mut error = None;
        for (key, tail) in tails.iter_mut() {
            if !tail.due(now) {
                continue;
            }
            let before = tail.offset;
            // Catch up in 1 MiB chunks; bounded per tick so one huge file cannot starve the others.
            for _ in 0..32 {
                match tail.read_lines() {
                    Ok(lines) if !lines.is_empty() => {
                        let parsed: Vec<Parsed> = lines.iter().filter_map(|l| parse_line(l)).collect();
                        drop(lines);
                        apply(&shared, key, parsed);
                        let offset = tail.offset;
                        update(&shared, |st| st.saved.codex.files.entry(key.clone()).or_default().offset = offset);
                    }
                    Ok(_) => break,
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::PermissionDenied {
                            error = Some("Access denied to a session file".to_string());
                        }
                        break;
                    }
                }
            }
            tail.schedule(now, tail.offset != before);
        }
        let mut st = lock(&shared);
        if st.codex.read_error != error {
            st.codex.read_error = error;
            // Widgets and the window must see this at once, not at the next unrelated update.
            st.dirty = true;
            st.version += 1;
            shared.changed.notify_all();
        }
    }
}

// ---------- quota fallback through `codex app-server` ----------

fn codex_command_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        let npm = PathBuf::from(app_data).join("npm");
        let (arch, target) = if cfg!(target_arch = "aarch64") { ("arm64", "aarch64-pc-windows-msvc") } else { ("x64", "x86_64-pc-windows-msvc") };
        let native = npm.join("node_modules/@openai/codex/node_modules/@openai").join(format!("codex-win32-{arch}")).join("vendor").join(target).join("codex/codex.exe");
        candidates.push(if native.is_file() { native } else { npm.join("codex.cmd") });
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(pf).join("nodejs").join("codex.cmd"));
    }
    candidates.retain(|p| p.is_file());
    candidates
}

fn read_app_server() -> Result<(Vec<Quota>, Option<Value>), String> {
    const REQUESTS: &[u8] = b"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"icue-edge-companion\",\"version\":\"0\"}}}\n{\"jsonrpc\":\"2.0\",\"method\":\"initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"account/rateLimits/read\",\"params\":null}\n";
    let candidates = codex_command_candidates();
    if candidates.is_empty() {
        return Err("codex command not found".into());
    }
    for command in candidates {
        let mut cmd = std::process::Command::new(&command);
        cmd.arg("app-server").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW | CREATE_SUSPENDED: nothing runs before the job holds the process,
            // so a codex.cmd grandchild cannot start outside it.
            cmd.creation_flags(0x08000000 | 0x00000004);
        }
        let Ok(mut child) = cmd.spawn() else { continue };
        // No job (the companion's own job forbids nesting): run as before, only the direct child is killed.
        #[cfg(windows)]
        let job = ProcessJob::assign(&child);
        #[cfg(windows)]
        if !resume(child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            continue;
        }
        // Keep stdin open until the answer arrives: closing it may stop the server early.
        let mut stdin = child.stdin.take();
        if let Some(pipe) = stdin.as_mut() {
            let _ = pipe.write_all(REQUESTS);
            let _ = pipe.flush();
        }
        let stdout = child.stdout.take();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let Some(out) = stdout else { return };
            if let Some(v) = read_app_server_answer(out) {
                let _ = tx.send(v);
            }
        });
        let answer = rx.recv_timeout(Duration::from_secs(5));
        drop(stdin.take());
        #[cfg(windows)]
        drop(job);
        let _ = child.kill();
        let _ = child.wait();
        let Ok(msg) = answer else { continue };
        let result = msg.get("result").ok_or("app-server response has no result")?;
        let limits = result.get("rateLimitsByLimitId").and_then(|m| m.get("codex")).or_else(|| result.get("rateLimits")).ok_or("app-server response has no limits")?;
        return parse_rate_limits(limits, true).ok_or_else(|| "No quota window reported".into());
    }
    Err("codex app-server did not respond".into())
}

/// Polls `app-server` only when no recent local observation exists:
/// ≥ 60 s while Codex is active, 15 min when idle, exponential backoff on failure.
pub fn run_quota(shared: Shared) {
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let now = now_ms();
        let due = {
            let mut st = lock(&shared);
            let active = st.saved.codex.sessions.values().any(|s| s.last_event + ACTIVE_MS > now);
            let fresh_local = st.saved.codex.quota.src == LOCAL_SRC && st.saved.codex.quota.observed_at + 5 * MIN > now;
            let interval = if active { MIN } else { 15 * MIN };
            // A manual refresh skips the schedule, not an error backoff (same rule as Claude).
            let forced = std::mem::take(&mut st.force_refresh_codex) && st.codex.quota_backoff == 0;
            let due = st.codex.detected && !st.paused && (forced || (now >= st.codex.next_quota_try && !fresh_local));
            if due {
                st.codex.next_quota_try = now + interval;
                st.codex.refreshing = true;
            }
            due
        };
        if !due {
            continue;
        }
        let result = read_app_server();
        update(&shared, |st| {
            st.codex.refreshing = false;
            match result {
                Ok((quotas, credits)) => {
                    st.codex.quota_error = None;
                    st.codex.quota_backoff = 0;
                    apply_quotas(st, quotas, credits, now_ms(), SERVER_SRC);
                }
                Err(reason) => {
                    let backoff = (st.codex.quota_backoff.max(MIN) * 2).min(30 * MIN);
                    st.codex.quota_backoff = backoff;
                    st.codex.next_quota_try = now + backoff;
                    // Local events may still carry quotas; only report the failure when they are stale too.
                    let local_fresh = st.saved.codex.quota.observed_at + 30 * MIN > now;
                    st.codex.quota_error = (!local_fresh).then(|| ("stale".to_string(), format!("Quotas: {reason}"), now));
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const META: &str = r#"{"timestamp":"2026-09-27T10:00:00.000Z","type":"session_meta","payload":{"id":"sess-1","originator":"codex_cli_rs","timestamp":"2026-09-27T10:00:00.000Z"}}"#;
    fn tc(ts: &str, input: u64, cached: u64, output: u64, used: f64, resets: u64) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"cache_write_input_tokens":0,"output_tokens":{output},"reasoning_output_tokens":1,"total_tokens":{}}},"last_token_usage":{{"total_tokens":500}},"model_context_window":1000}},"rate_limits":{{"limit_id":"codex","primary":{{"used_percent":{used},"window_minutes":300,"resets_at":{resets}}},"secondary":null,"credits":{{"has_credits":false,"unlimited":false,"balance":"0"}}}}}}}}"#,
            input + output
        )
    }

    fn run_lines(shared: &Shared, lines: &[String]) {
        apply(shared, "file-a", lines.iter().filter_map(|l| parse_line(l)).collect());
    }

    #[test]
    fn cumulative_counter_counts_growth_once() {
        let shared = store::tests::load_for_test();
        let lines = vec![
            META.to_string(),
            tc("2026-09-27T10:05:00Z", 100, 80, 10, 5.0, 1790600000),
            tc("2026-09-27T10:05:00Z", 100, 80, 10, 5.0, 1790600000), // repeated event
            tc("2026-09-27T11:10:00Z", 300, 200, 30, 9.0, 1790600000),
        ];
        run_lines(&shared, &lines);
        // A resumed file replays the old history: nothing is recounted.
        run_lines(&shared, &lines);
        let st = lock(&shared);
        let total: Tok = st.saved.codex.hours.values().fold(Tok::default(), |mut a, t| { a.add(t); a });
        assert_eq!((total.input, total.cache_read, total.output), (300, 200, 30));
        assert_eq!(st.saved.codex.hours.len(), 2, "growth attributed to each event's own hour");
        assert_eq!(st.saved.codex.quota.quotas[0].used, 9.0);
        assert_eq!(st.saved.codex.quota.quotas[0].label, "5-hour limit");
        let s = st.saved.codex.sessions.get("sess-1").unwrap();
        assert_eq!((s.client.as_str(), s.context_used, s.context_cap), ("CLI", Some(500), Some(1000)));
    }

    #[test]
    fn counter_decrease_is_not_usage_and_reset_is_reported() {
        let shared = store::tests::load_for_test();
        run_lines(&shared, &[META.to_string(), tc("2026-09-27T10:05:00Z", 500, 0, 50, 80.0, 1790600000)]);
        run_lines(&shared, &[tc("2026-09-27T12:05:00Z", 100, 0, 5, 1.0, 1790700000)]);
        let st = lock(&shared);
        let total: u64 = st.saved.codex.hours.values().map(|t| t.input).sum();
        assert_eq!(total, 500);
        assert!(st.codex.events.iter().any(|(_, t)| t.contains("reset (")));
    }

    #[test]
    fn app_server_shape_parses() {
        let v: Value = serde_json::from_str(r#"{"limitId":"codex","primary":{"usedPercent":23,"windowDurationMins":300,"resetsAt":1790600000},"secondary":{"usedPercent":48,"windowDurationMins":10080,"resetsAt":1790900000}}"#).unwrap();
        let (q, _) = parse_rate_limits(&v, true).unwrap();
        assert_eq!(q.len(), 2);
        assert_eq!(q[1].label, "Weekly limit");
        assert_eq!(q[0].resets_at, Some(1790600000000));
    }

    #[test]
    fn other_limit_ids_are_ignored() {
        let v: Value = serde_json::from_str(r#"{"limit_id":"other","primary":{"used_percent":1}}"#).unwrap();
        assert!(parse_rate_limits(&v, false).is_none());
    }

    #[test]
    fn app_server_reader_rejects_an_oversized_line() {
        assert!(read_app_server_answer(&vec![b'x'; MAX_APP_SERVER_BYTES + 1][..]).is_none());
        let answer = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"rateLimits\":{}}}\n";
        assert_eq!(read_app_server_answer(&answer[..]).unwrap()["id"], 1);
    }

    #[cfg(windows)]
    #[test]
    fn closing_process_job_terminates_child() {
        let mut child = std::process::Command::new(crate::util::system_exe("ping.exe"))
            .args(["-t", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let job = ProcessJob::assign(&child).unwrap();
        drop(job);
        for _ in 0..50 {
            if child.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = child.kill();
        panic!("job close did not terminate child");
    }

    #[cfg(windows)]
    #[test]
    fn suspended_start_puts_grandchildren_in_the_job() {
        use std::os::windows::process::CommandExt;
        // Same shape as codex.cmd: cmd.exe starting a long-running program.
        let mut child = std::process::Command::new(crate::util::system_exe("cmd.exe"))
            .args(["/d", "/c", "ping -t 127.0.0.1 >nul"])
            .creation_flags(0x08000000 | 0x00000004)
            .spawn()
            .unwrap();
        let job = ProcessJob::assign(&child).unwrap();
        assert!(resume(child.id()));
        let grandchild = || crate::usage::apps::entries().into_iter().find(|e| e.1 == child.id() && e.2 == "ping.exe").map(|e| e.0);
        let mut pid = None;
        for _ in 0..200 {
            pid = grandchild();
            if pid.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let pid = pid.expect("ping.exe never started: the process was not resumed");
        drop(job);
        let _ = child.wait();
        for _ in 0..100 {
            if !crate::usage::apps::entries().iter().any(|e| e.0 == pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("grandchild survived the job");
    }
}
