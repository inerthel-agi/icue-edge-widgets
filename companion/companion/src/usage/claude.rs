//! Claude collector.
//! Tokens: Claude Code JSONL, `type == "assistant"` lines with `message.usage`.
//! Verified on local files: one API message is written on several lines (147 lines, 68 ids),
//! so usage is keyed by `message.id|requestId` and only growth over what was already counted
//! is added. `input_tokens` excludes cache: cache read / cache creation are separate categories.
//! Quotas: internal `GET /api/oauth/usage` with the OAuth token Claude Code stores in
//! `~/.claude/.credentials.json` (adapted from claude-rpc, MIT, © Inerthel). The token stays
//! in this process: never logged, stored or sent to the page.
use crate::usage::store::{hour_of, lock, update, Quota, QuotaSet, Session, Shared, Tok, ACTIVE_MS};
use crate::tail::Tail;
use crate::util::{home_dir, now_ms, parse_iso_ms, pseudonym, read_limited, DAY, MIN, SEC};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

const OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_USAGE_BETA: &str = "oauth-2025-04-20";
const QUOTA_SRC: &str = "Anthropic · /api/oauth/usage (internal interface)";

fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home_dir().join(".claude"))
}

fn client_label(entrypoint: &str) -> String {
    let e = entrypoint.to_ascii_lowercase();
    if e.contains("desktop") {
        "Desktop".into()
    } else if e.contains("vscode") || e.contains("jetbrains") || e.contains("ide") {
        "IDE".into()
    } else if e.starts_with("sdk") {
        "SDK".into()
    } else if e == "cli" || e.is_empty() {
        "CLI".into()
    } else {
        entrypoint.chars().take(24).collect()
    }
}

struct Usage {
    key: String,
    session: String,
    client: String,
    model: String,
    sidechain: bool,
    tok: Tok,
    ts: u64,
}

fn parse_line(line: &str) -> Option<Usage> {
    if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let msg = v.get("message")?;
    let usage = msg.get("usage")?;
    let model = msg.get("model").and_then(Value::as_str).unwrap_or("");
    if model == "<synthetic>" {
        return None;
    }
    let id = msg.get("id").and_then(Value::as_str)?;
    let request = v.get("requestId").and_then(Value::as_str).unwrap_or("");
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    Some(Usage {
        key: format!("{id}|{request}"),
        session: v.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string(),
        client: client_label(v.get("entrypoint").and_then(Value::as_str).unwrap_or("")),
        model: model.to_string(),
        sidechain: v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false),
        tok: Tok {
            input: n("input_tokens"),
            output: n("output_tokens"),
            cache_read: n("cache_read_input_tokens"),
            cache_write: n("cache_creation_input_tokens"),
            reasoning: usage.pointer("/output_tokens_details/thinking_tokens").and_then(Value::as_u64).unwrap_or(0),
        },
        ts: v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(0),
    })
}

/// One tool call from a Claude Code log line, reduced to what the Agent Activity widget shows: the tool,
/// and a short target (a file's name, the command's own description), never the prompt or file contents.
#[derive(Debug, PartialEq)]
pub struct Activity {
    pub at: u64,
    pub tool: String,
    pub target: String,
}

pub fn parse_activity(line: &str) -> Vec<Activity> {
    if !line.contains("\"tool_use\"") || !line.contains("\"assistant\"") {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    if v.get("type").and_then(Value::as_str) != Some("assistant") || v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return Vec::new();
    }
    let at = v.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(0);
    let short = |s: &str| -> String { s.chars().take(60).collect() };
    let base = |p: &str| short(p.rsplit(['/', '\\']).next().unwrap_or(p));
    v.pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|c| {
            let tool = c.get("name").and_then(Value::as_str)?.to_string();
            let input = c.get("input").cloned().unwrap_or(Value::Null);
            let s = |k: &str| input.get(k).and_then(Value::as_str);
            let target = match tool.as_str() {
                "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => s("file_path").or(s("notebook_path")).map(base),
                "Bash" | "PowerShell" | "Task" | "Agent" => s("description").map(short),
                "WebFetch" => s("url").and_then(|u| u.split('/').nth(2)).map(short),
                "Skill" => s("skill").map(short),
                "Glob" | "Grep" => s("path").map(base),
                _ => None,
            }
            .unwrap_or_default();
            Some(Activity { at, tool, target })
        })
        .collect()
}

/// What the tool is doing, in a few words.
pub fn verb(tool: &str) -> String {
    match tool {
        "Read" => "Reading".into(),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "Editing".into(),
        "Bash" | "PowerShell" => "Running".into(),
        "Grep" | "Glob" => "Searching".into(),
        "WebFetch" | "WebSearch" => "Browsing".into(),
        "Task" | "Agent" => "Delegating".into(),
        "TodoWrite" => "Planning".into(),
        "Skill" => "Using a skill".into(),
        t if t.starts_with("mcp__") => "Using a connector".into(),
        t => format!("Using {t}"),
    }
}

fn apply_activity(shared: &Shared, acts: Vec<Activity>) {
    if acts.is_empty() {
        return;
    }
    update(shared, |st| {
        for a in acts {
            st.claude.activity.push_back((a.at, a.tool, a.target));
        }
        while st.claude.activity.len() > 300 {
            st.claude.activity.pop_front();
        }
    });
}

/// The `agent/1` snapshot for the Agent Activity widget.
pub fn agent_snapshot(st: &crate::usage::store::Store, now: u64) -> Value {
    let rt = &st.claude;
    let midnight = now - now % DAY; // UTC day start: good enough for a "today" counter
    let last = rt.activity.back();
    let session = st.saved.claude.sessions.values().filter(|s| s.client != "SDK").max_by_key(|s| s.last_event);
    let active = session.is_some_and(|s| s.last_event + 2 * MIN > now);
    let tokens5: u64 = rt.recent_tokens.iter().filter(|(t, _)| *t + 5 * MIN > now).map(|(_, n)| n).sum();
    serde_json::json!({
        "schema": "agent/1",
        "provider": "claude",
        "name": "Claude Code",
        "detected": rt.detected,
        "active": active,
        "since": session.filter(|_| active).map(|s| s.started),
        "lastEventAt": session.map(|s| s.last_event),
        "model": session.map(|s| s.model.clone()),
        "step": last.filter(|(t, ..)| t + 10 * MIN > now).map(|(t, tool, target)| serde_json::json!({ "at": t, "tool": tool, "verb": verb(tool), "target": target })),
        "recent": rt.activity.iter().rev().filter(|(t, ..)| t + 30 * MIN > now).take(10).map(|(t, tool, target)| serde_json::json!({ "at": t, "tool": tool, "target": target })).collect::<Vec<_>>(),
        "toolsToday": rt.activity.iter().filter(|(t, ..)| *t >= midnight).count(),
        "tokensPerMin": tokens5 / 5,
        "attention": attention(session.map_or(0, |s| s.last_event), now),
    })
}

/// Written by a Claude Code `Notification` hook (see the companion README): the last notification Claude
/// Code raised. Read on each request; tiny, and absent unless the user installed the hook.
pub const HOOK_FILE: &str = "claude-hook.json";
const ATTENTION_FOR: u64 = 30 * MIN;

fn attention(last_event: u64, now: u64) -> Option<Value> {
    let path = crate::util::app_dir().join(HOOK_FILE);
    let at = std::fs::metadata(&path).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
    let file = std::fs::File::open(&path).ok()?;
    let v: Value = serde_json::from_slice(&read_limited(file, 64 * 1024).ok()?).ok()?;
    attention_from(&v, at, last_event, now)
}

/// What Claude Code waits for, from a Notification hook's input written at `at`. None once Claude Code
/// moved on (a newer log event), after 30 min, or for notifications that ask nothing.
pub fn attention_from(v: &Value, at: u64, last_event: u64, now: u64) -> Option<Value> {
    if v["hook_event_name"] != "Notification" || at + ATTENTION_FOR < now || last_event > at {
        return None;
    }
    let message: String = v["message"].as_str().unwrap_or("").chars().take(200).collect();
    let kind = match v["notification_type"].as_str() {
        Some("permission_prompt") => "permission",
        Some("idle_prompt") => "reply",
        Some("elicitation_dialog") => "question",
        Some(_) => return None,
        None if message.to_lowercase().contains("permission") => "permission",
        None => "reply",
    };
    // Only the project folder's name, not the full path.
    let project = v["cwd"].as_str().and_then(|c| c.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next()).unwrap_or("").chars().take(60).collect::<String>();
    Some(serde_json::json!({ "kind": kind, "message": message, "project": project, "since": at }))
}

fn apply(shared: &Shared, path_key: &str, usages: Vec<Usage>, offset: u64) {
    update(shared, |st| {
        let now = now_ms();
        while st.claude.recent_tokens.front().is_some_and(|(t, _)| t + 15 * MIN < now) {
            st.claude.recent_tokens.pop_front();
        }
        let salt = st.saved.salt.clone();
        let file = st.saved.claude.files.entry(path_key.to_string()).or_default();
        file.offset = offset;
        file.last_seen = now;
        for u in usages {
            let counted = st.saved.claude.counted.entry(u.key).or_insert((Tok::default(), now));
            let growth = u.tok.growth_over(&counted.0);
            counted.0 = counted.0.max(&u.tok);
            counted.1 = now;
            if !growth.is_zero() {
                st.saved.claude.hours.entry(hour_of(u.ts)).or_default().add(&growth);
                if u.ts + 15 * MIN > now {
                    st.claude.recent_tokens.push_back((u.ts, growth.input + growth.output + growth.cache_read + growth.cache_write));
                }
            }
            if u.session.is_empty() {
                continue;
            }
            let sid = u.session.clone();
            let s = st.saved.claude.sessions.entry(sid.clone()).or_insert_with(|| Session { id: pseudonym("c", &salt, &sid), started: u.ts, ..Default::default() });
            s.tokens.add(&growth);
            s.last_event = s.last_event.max(u.ts);
            s.client = u.client;
            if !u.sidechain {
                if !s.model.is_empty() && s.model != u.model && u.ts >= s.context_at {
                    let text = format!("Model changed: {} → {} (session {})", s.model, u.model, s.id);
                    st.claude.event(u.ts, text);
                }
                let s = st.saved.claude.sessions.get_mut(&sid).unwrap();
                if u.ts >= s.context_at {
                    s.model = u.model;
                    // Estimate: what the last request carried as context. Capacity is not in the log.
                    s.context_used = Some(u.tok.input + u.tok.cache_read + u.tok.cache_write);
                    s.context_cap = None;
                    s.context_at = u.ts;
                }
            }
        }
    });
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Files touched in the last 48 h. Between full walks, only directories modified
/// in that window are entered (a new session file updates its directory's mtime).
fn discover(root: &Path, full: bool, now: u64) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            let recent = modified_ms(&meta) + 2 * DAY > now;
            let path = e.path();
            if meta.is_dir() {
                if depth < 3 && (full || recent) {
                    stack.push((path, depth + 1));
                }
            } else if recent && path.extension().is_some_and(|x| x == "jsonl") {
                out.push(path);
            }
        }
    }
    out
}

pub fn run(shared: Shared) {
    let root = claude_dir().join("projects");
    let mut tails: HashMap<String, Tail> = HashMap::new();
    let (mut last_discover, mut last_full) = (0u64, 0u64);
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let now = now_ms();
        let detected = root.is_dir();
        {
            let mut st = lock(&shared);
            if st.claude.detected != detected {
                st.claude.detected = detected;
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
                if !tails.contains_key(&key) {
                    let offset = lock(&shared).saved.claude.files.get(&key).map(|f| f.offset).unwrap_or(0);
                    tails.insert(key, Tail::new(path, offset));
                }
            }
            tails.retain(|_, t| std::fs::metadata(&t.path).map(|m| modified_ms(&m) + 2 * DAY > now).unwrap_or(false));
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
                        let usages = lines.iter().filter_map(|l| parse_line(l)).collect();
                        apply_activity(&shared, lines.iter().flat_map(|l| parse_activity(l)).filter(|a| a.at + DAY > now).collect());
                        drop(lines);
                        apply(&shared, key, usages, tail.offset);
                    }
                    Ok(_) => break,
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::PermissionDenied {
                            error = Some("Access denied to a Claude log".to_string());
                        }
                        break;
                    }
                }
            }
            tail.schedule(now, tail.offset != before);
        }
        let mut st = lock(&shared);
        if st.claude.read_error != error {
            st.claude.read_error = error;
            // Widgets and the window must see this at once, not at the next unrelated update.
            st.dirty = true;
            st.version += 1;
            shared.changed.notify_all();
        }
    }
}

// ---------- quotas ----------

enum FetchError {
    NoToken(&'static str),
    Expired,
    RenewFailed,
    Denied,
    RateLimited(u64),
    Network,
    Parse,
}

fn credentials_path() -> PathBuf {
    claude_dir().join(".credentials.json")
}

fn read_credentials() -> Result<Value, FetchError> {
    let raw = read_limited(std::fs::File::open(credentials_path()).map_err(|_| FetchError::NoToken("Claude token not found"))?, 1024 * 1024)
        .map_err(|_| FetchError::NoToken("Credentials file unreadable"))?;
    let raw = std::str::from_utf8(&raw).map_err(|_| FetchError::NoToken("Credentials file unreadable"))?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}')).map_err(|_| FetchError::NoToken("Credentials file unreadable"))
}

fn read_oauth_access_token() -> Result<String, FetchError> {
    let value = read_credentials()?;
    let oauth = value.get("claudeAiOauth").ok_or(FetchError::NoToken("No Claude Code sign-in"))?;
    let token = oauth.get("accessToken").and_then(Value::as_str).ok_or(FetchError::NoToken("No Claude Code sign-in"))?;
    if oauth.get("expiresAt").and_then(Value::as_u64).is_some_and(|exp| exp < now_ms()) {
        return Err(FetchError::Expired);
    }
    Ok(token.to_string())
}

// Claude Code's own OAuth client and token endpoint (as in claude-rpc): the token belongs to it.
const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// Claude Code renews its ~8 h token only while the CLI runs, so a day in Desktop leaves it expired.
/// Renews it the way Claude Code does and writes it back: a used refresh token stops working,
/// so Claude Code must get the new one. Only called once the token has expired or was refused.
fn renew_token() -> Result<String, FetchError> {
    let oauth = read_credentials()?.get("claudeAiOauth").cloned().ok_or(FetchError::NoToken("No Claude Code sign-in"))?;
    let used = oauth.get("refreshToken").and_then(Value::as_str).ok_or(FetchError::NoToken("No Claude Code sign-in"))?.to_string();
    let mut body = serde_json::json!({ "grant_type": "refresh_token", "refresh_token": used, "client_id": OAUTH_CLIENT_ID });
    let scopes: Vec<&str> = oauth.get("scopes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if !scopes.is_empty() {
        body["scope"] = scopes.join(" ").into();
    }
    let response = match ureq::post(OAUTH_TOKEN_URL).timeout(Duration::from_secs(10)).set("User-Agent", "icue-edge-companion").send_json(body) {
        Ok(r) => r,
        Err(ureq::Error::Status(429, _)) => return Err(FetchError::RateLimited(10 * MIN)),
        Err(ureq::Error::Status(..)) => return Err(FetchError::RenewFailed),
        Err(_) => return Err(FetchError::Network),
    };
    let response: Value = serde_json::from_slice(&read_limited(response.into_reader(), 64 * 1024).map_err(|_| FetchError::RenewFailed)?).map_err(|_| FetchError::RenewFailed)?;
    // Re-read right before writing: Claude Code may have renewed it meanwhile.
    let mut credentials = read_credentials()?;
    let token = apply_renewed(&mut credentials, &response, &used, now_ms()).ok_or(FetchError::RenewFailed)?;
    let bytes = serde_json::to_vec(&credentials).map_err(|_| FetchError::RenewFailed)?;
    crate::util::atomic_write(&credentials_path(), &bytes).map_err(|_| FetchError::RenewFailed)?;
    Ok(token)
}

/// Stores a renewal in the credentials, keeping every other field.
/// Skipped when the stored refresh token changed since the request was sent.
fn apply_renewed(credentials: &mut Value, response: &Value, used: &str, now: u64) -> Option<String> {
    let access = response.get("access_token")?.as_str()?;
    let expires_in = response.get("expires_in")?.as_u64()?;
    let oauth = credentials.get_mut("claudeAiOauth")?.as_object_mut()?;
    if oauth.get("refreshToken").and_then(Value::as_str) != Some(used) {
        return None;
    }
    let refresh = response.get("refresh_token").and_then(Value::as_str).unwrap_or(used);
    oauth.insert("accessToken".into(), access.into());
    oauth.insert("refreshToken".into(), refresh.into());
    oauth.insert("expiresAt".into(), (now + expires_in * 1000).into());
    Some(access.to_string())
}

fn percent(bucket: &Value) -> Option<f64> {
    if let Some(v) = bucket.get("utilization").and_then(Value::as_f64) {
        return Some(v.clamp(0.0, 100.0));
    }
    ["percent_used", "used_percent", "percent"].iter().find_map(|k| bucket.get(*k).and_then(Value::as_f64)).map(|v| v.clamp(0.0, 100.0))
}

fn bucket_label(key: &str) -> String {
    match key {
        "five_hour" => "5-hour limit".into(),
        "seven_day" => "Weekly limit · all models".into(),
        "seven_day_opus" => "Weekly limit · Opus".into(),
        "seven_day_sonnet" => "Weekly limit · Sonnet".into(),
        "seven_day_oauth_apps" => "Weekly limit · OAuth apps".into(),
        other => other.replace('_', " "),
    }
}

/// Keeps only windows the response actually reports (null buckets are skipped).
pub fn parse_usage(body: &Value) -> (Vec<Quota>, Option<Value>) {
    let mut quotas = Vec::new();
    if let Some(map) = body.as_object() {
        for (key, bucket) in map {
            if !(key.starts_with("five_hour") || key.starts_with("seven_day")) || !bucket.is_object() {
                continue;
            }
            let Some(used) = percent(bucket) else { continue };
            quotas.push(Quota {
                id: key.clone(),
                label: bucket_label(key),
                used,
                window_minutes: None,
                resets_at: bucket.get("resets_at").and_then(Value::as_str).and_then(parse_iso_ms),
            });
        }
    }
    for limit in body.get("limits").and_then(Value::as_array).into_iter().flatten() {
        if limit.get("kind").and_then(Value::as_str) != Some("weekly_scoped") {
            continue;
        }
        let Some(name) = limit.pointer("/scope/model/display_name").and_then(Value::as_str) else { continue };
        let label = format!("Weekly limit · {name}");
        if quotas.iter().any(|q| q.label.eq_ignore_ascii_case(&label)) {
            continue;
        }
        let Some(used) = percent(limit) else { continue };
        quotas.push(Quota {
            id: format!("weekly_scoped_{}", name.to_ascii_lowercase()),
            label,
            used,
            window_minutes: None,
            resets_at: limit.get("resets_at").and_then(Value::as_str).and_then(parse_iso_ms),
        });
    }
    let order = |q: &Quota| if q.id == "five_hour" { 0 } else if q.id == "seven_day" { 1 } else { 2 };
    quotas.sort_by_key(order);
    let credits = body.get("extra_usage").filter(|e| e.is_object() && e.get("is_enabled").and_then(Value::as_bool).unwrap_or(false)).map(|e| {
        serde_json::json!({
            "used": e.get("used_credits"), "limit": e.get("monthly_limit"),
            "currency": e.get("currency").and_then(Value::as_str).filter(|c| c.len() == 3),
            "unit": "minor",
        })
    });
    (quotas, credits)
}

fn fetch(renew: bool) -> Result<(Vec<Quota>, Option<Value>), FetchError> {
    let token = match read_oauth_access_token() {
        Err(FetchError::Expired) if renew => renew_token()?,
        other => other?,
    };
    let call = |token: &str| {
        ureq::get(OAUTH_USAGE_URL)
            .timeout(Duration::from_secs(8))
            .set("Authorization", &format!("Bearer {token}"))
            .set("anthropic-beta", OAUTH_USAGE_BETA)
            .set("User-Agent", "icue-edge-companion")
            .call()
    };
    let response = match call(&token) {
        // A token revoked before its expiry: renew once, then retry.
        Err(ureq::Error::Status(401, _)) if renew => call(&renew_token()?),
        other => other,
    };
    let body = match response {
        Ok(r) => String::from_utf8(read_limited(r.into_reader(), 2 * 1024 * 1024).map_err(|_| FetchError::Parse)?).map_err(|_| FetchError::Parse)?,
        Err(ureq::Error::Status(429, r)) => {
            let retry = r.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok()).map(|s| s * 1000).unwrap_or(5 * MIN);
            return Err(FetchError::RateLimited(retry.clamp(MIN, 60 * MIN)));
        }
        Err(ureq::Error::Status(401 | 403, _)) => return Err(FetchError::Denied),
        Err(_) => return Err(FetchError::Network),
    };
    let value: Value = serde_json::from_str(&body).map_err(|_| FetchError::Parse)?;
    let parsed = parse_usage(&value);
    if parsed.0.is_empty() {
        return Err(FetchError::Parse);
    }
    Ok(parsed)
}

/// 60 s while Claude is active, 10 min when idle; 429 honours Retry-After (default 5 min).
pub fn run_quota(shared: Shared) {
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let now = now_ms();
        let (due, renew) = {
            let mut st = lock(&shared);
            let active = st.saved.claude.sessions.values().any(|s| s.last_event + ACTIVE_MS > now);
            let forced = std::mem::take(&mut st.force_refresh_claude) && st.claude.quota_backoff == 0;
            let due = !st.paused && (forced || now >= st.claude.next_quota_try);
            if due {
                st.claude.next_quota_try = now + if active { MIN } else { 10 * MIN };
                st.claude.refreshing = true;
            }
            (due, st.saved.renew_claude_token)
        };
        if !due {
            continue;
        }
        let result = fetch(renew);
        update(&shared, |st| {
            st.claude.refreshing = false;
            let now = now_ms();
            match result {
                Ok((quotas, credits)) => {
                    let old = std::mem::take(&mut st.saved.claude.quota.quotas);
                    for q in &quotas {
                        if let Some(o) = old.iter().find(|o| o.id == q.id) {
                            if matches!((o.resets_at, q.resets_at), (Some(a), Some(b)) if b > a + MIN) && q.used < o.used {
                                st.claude.event(now, format!("{} reset (reported value: {}%)", q.label, q.used.round()));
                            }
                        }
                    }
                    st.saved.claude.set_quota(QuotaSet { quotas, observed_at: now, src: QUOTA_SRC.into(), credits });
                    st.claude.quota_error = None;
                    st.claude.quota_backoff = 0;
                }
                Err(e) => {
                    let (state, reason, wait) = match e {
                        FetchError::NoToken(msg) => ("error", format!("Quotas: {msg}"), 5 * MIN),
                        FetchError::Expired => ("error", "Claude sign-in expired: run `claude` in a terminal once, or turn on sign-in renewal in Settings".into(), 5 * MIN),
                        FetchError::RenewFailed => ("error", "Could not renew the Claude sign-in: run `claude` in a terminal once".into(), 30 * MIN),
                        FetchError::Denied => ("error", "Quotas: access denied (401/403). Sign in again in Claude Code.".into(), 15 * MIN),
                        FetchError::RateLimited(ms) => ("stale", format!("Rate limited by the source: retrying in {} min", ms.div_ceil(MIN)), ms),
                        FetchError::Network => ("stale", "Quotas: source unreachable".into(), 2 * MIN),
                        FetchError::Parse => ("stale", "Quotas: unrecognized response".into(), 10 * MIN),
                    };
                    st.claude.quota_backoff = wait;
                    st.claude.next_quota_try = now + wait;
                    st.claude.quota_error = Some((state.into(), reason, now));
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::store;

    #[test]
    fn hook_notification_becomes_attention_until_claude_moves_on() {
        let n = |t: Option<&str>, msg: &str| serde_json::json!({ "hook_event_name": "Notification", "notification_type": t, "message": msg, "cwd": r"D:\Users\me\GitHub\my-app\" });
        let a = attention_from(&n(Some("permission_prompt"), "Claude needs your permission to use Bash"), 1_000, 900, 2_000).unwrap();
        assert_eq!((a["kind"].as_str(), a["project"].as_str()), (Some("permission"), Some("my-app")));
        assert_eq!(attention_from(&n(Some("idle_prompt"), "Claude is waiting for your input"), 1_000, 0, 2_000).unwrap()["kind"], "reply");
        assert!(attention_from(&n(Some("permission_prompt"), "x"), 1_000, 1_500, 2_000).is_none());   // Claude moved on
        assert!(attention_from(&n(Some("permission_prompt"), "x"), 1_000, 0, 1_000 + 31 * MIN).is_none());   // too old
        assert!(attention_from(&n(Some("auth_success"), "x"), 1_000, 0, 2_000).is_none());
        let mut legacy = n(None, "Claude needs your permission to use Edit");
        legacy.as_object_mut().unwrap().remove("notification_type");
        assert_eq!(attention_from(&legacy, 1_000, 0, 2_000).unwrap()["kind"], "permission");
        assert!(attention_from(&serde_json::json!({ "hook_event_name": "Stop" }), 1_000, 0, 2_000).is_none());
    }

    fn line(id: &str, req: &str, input: u64, output: u64, read: u64, write: u64, ts: &str, model: &str) -> String {
        format!(
            r#"{{"type":"assistant","sessionId":"s-1","entrypoint":"cli","isSidechain":false,"requestId":"{req}","timestamp":"{ts}","message":{{"id":"{id}","model":"{model}","content":[{{"type":"text","text":"secret prompt text"}}],"usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":{read},"cache_creation_input_tokens":{write}}}}}}}"#
        )
    }

    fn feed(shared: &Shared, lines: &[String]) {
        apply(shared, "f", lines.iter().filter_map(|l| parse_line(l)).collect(), 0);
    }

    #[test]
    fn repeated_lines_count_once_and_streaming_updates_add_growth() {
        let shared = store::tests::load_for_test();
        feed(&shared, &[
            line("m1", "r1", 2, 10, 1000, 50, "2026-09-27T10:00:00Z", "opus"),
            line("m1", "r1", 2, 10, 1000, 50, "2026-09-27T10:00:01Z", "opus"),
            line("m1", "r1", 2, 169, 1000, 50, "2026-09-27T10:00:02Z", "opus"),
            line("m2", "r2", 3, 20, 2000, 0, "2026-09-27T10:01:00Z", "opus"),
        ]);
        // Restart replaying the same file: nothing new.
        feed(&shared, &[line("m1", "r1", 2, 169, 1000, 50, "2026-09-27T10:00:02Z", "opus")]);
        let st = lock(&shared);
        let t: Tok = st.saved.claude.hours.values().fold(Tok::default(), |mut a, t| { a.add(t); a });
        assert_eq!((t.input, t.output, t.cache_read, t.cache_write), (5, 189, 3000, 50));
        let s = st.saved.claude.sessions.get("s-1").unwrap();
        assert_eq!(s.context_used, Some(3 + 2000));
        assert_eq!(s.context_cap, None);
        assert_eq!(s.client, "CLI");
    }

    #[test]
    fn tool_calls_keep_only_a_short_target() {
        let line = r#"{"type":"assistant","isSidechain":false,"timestamp":"2026-11-03T10:00:00Z","message":{"content":[{"type":"text","text":"secret plan"},{"type":"tool_use","name":"Edit","input":{"file_path":"C:\\Users\\me\\project\\widget.css","old_string":"secret","new_string":"x"}},{"type":"tool_use","name":"Bash","input":{"command":"curl -H 'token: abc' x","description":"Run the tests"}}],"usage":{}}}"#;
        let acts = parse_activity(line);
        assert_eq!(acts.len(), 2);
        assert_eq!((acts[0].tool.as_str(), acts[0].target.as_str()), ("Edit", "widget.css"));
        assert_eq!((acts[1].tool.as_str(), acts[1].target.as_str()), ("Bash", "Run the tests"));
        let all = format!("{acts:?}");
        assert!(!all.contains("secret") && !all.contains("token") && !all.contains("Users"));
        assert_eq!(verb("Edit"), "Editing");
    }

    #[test]
    fn model_change_is_an_event() {
        let shared = store::tests::load_for_test();
        feed(&shared, &[line("m1", "r1", 1, 1, 0, 0, "2026-09-27T10:00:00Z", "sonnet"), line("m2", "r2", 1, 1, 0, 0, "2026-09-27T10:05:00Z", "opus")]);
        assert!(lock(&shared).claude.events.iter().any(|(_, t)| t.contains("sonnet → opus")));
    }

    #[test]
    fn oauth_usage_keeps_reported_windows_only() {
        let body: Value = serde_json::from_str(r#"{"five_hour":{"utilization":42,"resets_at":"2026-09-27T14:45:00Z"},"seven_day":{"utilization":61,"resets_at":"2026-09-30T16:32:00Z"},"seven_day_opus":null,"limits":[{"kind":"weekly_scoped","percent":18,"scope":{"model":{"display_name":"Fable"}}}],"extra_usage":null}"#).unwrap();
        let (q, credits) = parse_usage(&body);
        let labels: Vec<_> = q.iter().map(|q| q.label.as_str()).collect();
        assert_eq!(labels, ["5-hour limit", "Weekly limit · all models", "Weekly limit · Fable"]);
        assert_eq!(q[0].used, 42.0);
        assert!(credits.is_none());
    }

    #[test]
    fn renewal_keeps_other_fields_and_skips_a_token_changed_meanwhile() {
        let stored = serde_json::json!({ "claudeAiOauth": { "accessToken": "old", "refreshToken": "r1", "expiresAt": 1, "scopes": ["user:inference"], "subscriptionType": "max" }, "other": true });
        let response = serde_json::json!({ "access_token": "new", "refresh_token": "r2", "expires_in": 28800 });
        let mut c = stored.clone();
        assert_eq!(apply_renewed(&mut c, &response, "r1", 1000).as_deref(), Some("new"));
        let o = &c["claudeAiOauth"];
        assert_eq!((o["accessToken"].as_str(), o["refreshToken"].as_str(), o["expiresAt"].as_u64()), (Some("new"), Some("r2"), Some(1000 + 28_800_000)));
        assert_eq!((o["subscriptionType"].as_str(), c["other"].as_bool()), (Some("max"), Some(true)));
        // Claude Code renewed it first: its newer token is kept.
        let mut c = stored.clone();
        assert!(apply_renewed(&mut c, &response, "r0", 1000).is_none());
        assert_eq!(c, stored);
        // No new refresh token in the response: the used one stays.
        let mut c = stored;
        apply_renewed(&mut c, &serde_json::json!({ "access_token": "new", "expires_in": 60 }), "r1", 0);
        assert_eq!(c["claudeAiOauth"]["refreshToken"].as_str(), Some("r1"));
    }

    #[test]
    fn snapshot_has_no_conversation_text() {
        let shared = store::tests::load_for_test();
        feed(&shared, &[line("m1", "r1", 1, 1, 0, 0, "2026-09-27T10:00:00Z", "opus")]);
        let text = store::snapshot(&lock(&shared)).to_string();
        assert!(!text.contains("secret prompt text"));
        assert!(!text.contains("s-1\""));
    }
}
