//! Shared state, persistence and the `ai-usage/1` wire snapshot.
use crate::util::{app_dir, atomic_write, now_ms, random_hex, DAY, HOUR, MIN};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

pub const ACTIVE_MS: u64 = 10 * MIN;
const HISTORY_MS: u64 = 90 * DAY;
const WIRE_HOURS_MS: u64 = 48 * HOUR;
pub const HISTORY_STEP: u64 = 10 * MIN;
const QUOTA_HISTORY_MS: u64 = DAY;

#[derive(Clone, Copy, Default, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tok {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
}

impl Tok {
    pub fn add(&mut self, o: &Tok) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.reasoning += o.reasoning;
    }
    /// Per-field growth over `prev`; a decrease never becomes positive usage.
    pub fn growth_over(&self, prev: &Tok) -> Tok {
        Tok {
            input: self.input.saturating_sub(prev.input),
            output: self.output.saturating_sub(prev.output),
            cache_read: self.cache_read.saturating_sub(prev.cache_read),
            cache_write: self.cache_write.saturating_sub(prev.cache_write),
            reasoning: self.reasoning.saturating_sub(prev.reasoning),
        }
    }
    pub fn max(&self, o: &Tok) -> Tok {
        Tok {
            input: self.input.max(o.input),
            output: self.output.max(o.output),
            cache_read: self.cache_read.max(o.cache_read),
            cache_write: self.cache_write.max(o.cache_write),
            reasoning: self.reasoning.max(o.reasoning),
        }
    }
    pub fn is_zero(&self) -> bool {
        *self == Tok::default()
    }
    fn wire(&self) -> Value {
        json!({ "input": self.input, "output": self.output, "cacheRead": self.cache_read, "cacheWrite": self.cache_write, "reasoning": self.reasoning })
    }
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct Quota {
    pub id: String,
    pub label: String,
    pub used: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<u64>,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct QuotaSet {
    pub quotas: Vec<Quota>,
    pub observed_at: u64,
    pub src: String,
    pub credits: Option<Value>,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub client: String,
    pub model: String,
    pub started: u64,
    pub last_event: u64,
    /// Codex: high-water mark of the cumulative counter. Claude: sum of deduplicated messages.
    pub tokens: Tok,
    pub context_used: Option<u64>,
    pub context_cap: Option<u64>,
    pub context_at: u64,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct FileCtx {
    pub offset: u64,
    pub session: String,
    pub client: String,
    pub last_seen: u64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct ProviderSaved {
    pub hours: BTreeMap<u64, Tok>,
    pub quota: QuotaSet,
    pub files: HashMap<String, FileCtx>,
    pub sessions: HashMap<String, Session>,
    /// Claude only: (tokens already counted, last seen) per `message.id|requestId`.
    pub counted: HashMap<String, (Tok, u64)>,
    /// Quota id -> 10-minute bucket start -> highest reported % in that bucket. Kept 24 h.
    #[serde(default)]
    pub quota_history: HashMap<String, BTreeMap<u64, f64>>,
}

impl ProviderSaved {
    /// Stores a new quota reading and adds it to the per-limit history.
    pub fn set_quota(&mut self, q: QuotaSet) {
        let bucket = q.observed_at - q.observed_at % HISTORY_STEP;
        for quota in &q.quotas {
            let v = self.quota_history.entry(quota.id.clone()).or_default().entry(bucket).or_insert(quota.used);
            *v = v.max(quota.used);
        }
        self.quota = q;
    }
}

#[derive(Default, Serialize, Deserialize)]
pub struct Saved {
    pub salt: String,
    pub widget_token: String,
    pub claude: ProviderSaved,
    pub codex: ProviderSaved,
    /// Opt-in: renew an expired Claude Code sign-in and write it back to its credentials file.
    #[serde(default)]
    pub renew_claude_token: bool,
}

#[derive(Default)]
pub struct Runtime {
    pub detected: bool,
    pub read_error: Option<String>,
    /// (state, reason, at): quota source failure kept next to the last good values.
    pub quota_error: Option<(String, String, u64)>,
    pub next_quota_try: u64,
    pub quota_backoff: u64,
    pub refreshing: bool,
    /// Apps open right now ("Desktop", "CLI"), from the process list.
    pub running: Vec<&'static str>,
    pub events: VecDeque<(u64, String)>,
    /// Agent Activity widget: the latest tool calls (time, tool, short target), newest last; Claude only.
    pub activity: VecDeque<(u64, String, String)>,
    /// Tokens counted per message over the last 15 minutes (time, tokens), for tokens per minute.
    pub recent_tokens: VecDeque<(u64, u64)>,
}

impl Runtime {
    pub fn event(&mut self, at: u64, text: String) {
        self.events.push_front((at, text));
        self.events.truncate(20);
    }
}

pub struct Store {
    pub saved: Saved,
    pub claude: Runtime,
    pub codex: Runtime,
    pub paused: bool,
    pub force_refresh_codex: bool,
    pub force_refresh_claude: bool,
    pub last_manual_refresh: u64,
    pub server_error: Option<String>,
    pub dirty: bool,
    pub version: u64,
}

pub struct Inner {
    pub store: Mutex<Store>,
    pub changed: Condvar,
}
pub type Shared = Arc<Inner>;

pub fn lock(shared: &Shared) -> MutexGuard<'_, Store> {
    shared.store.lock().unwrap_or_else(|e| e.into_inner())
}

/// Mutates the store, marks it dirty and wakes every SSE stream.
pub fn update<T>(shared: &Shared, f: impl FnOnce(&mut Store) -> T) -> T {
    let mut st = lock(shared);
    let out = f(&mut st);
    st.version += 1;
    st.dirty = true;
    drop(st);
    shared.changed.notify_all();
    out
}

fn state_path() -> std::path::PathBuf {
    app_dir().join("state.json")
}

pub fn load() -> Shared {
    // One-time move from a pre-rename folder, keeping the widget token.
    for name in ["xeneon-edge-companion", "ai-usage-monitor"] {
        let old = app_dir().with_file_name(name);
        if !app_dir().exists() && old.join("state.json").is_file() {
            let _ = std::fs::rename(&old, app_dir());
        }
    }
    crate::util::remove_stale_tmp(&app_dir());
    let mut saved: Saved = match std::fs::read(state_path()) {
        Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|_| {
            // Unreadable state is kept aside for inspection instead of being overwritten by an empty one.
            let _ = std::fs::rename(state_path(), state_path().with_extension("json.bad"));
            Saved::default()
        }),
        Err(_) => Saved::default(),
    };
    if saved.salt.is_empty() {
        saved.salt = random_hex(16);
    }
    if saved.widget_token.is_empty() {
        saved.widget_token = random_hex(24);
    }
    Arc::new(Inner {
        store: Mutex::new(Store {
            saved,
            claude: Runtime::default(),
            codex: Runtime::default(),
            paused: false,
            force_refresh_codex: false,
            force_refresh_claude: false,
            last_manual_refresh: 0,
            server_error: None,
            dirty: true,
            version: 1,
        }),
        changed: Condvar::new(),
    })
}

/// Bounded retention, then atomic write (tmp + rename).
pub fn save(shared: &Shared) -> std::io::Result<()> {
    save_to(shared, &state_path())
}

fn save_to(shared: &Shared, path: &std::path::Path) -> std::io::Result<()> {
    let bytes = {
        let mut st = lock(shared);
        if !st.dirty {
            return Ok(());
        }
        let now = now_ms();
        let saved = &mut st.saved;
        for p in [&mut saved.claude, &mut saved.codex] {
            p.hours.retain(|h, _| *h + HISTORY_MS > now);
            p.files.retain(|_, f| f.last_seen + 7 * DAY > now);
            p.sessions.retain(|_, s| s.last_event + 30 * DAY > now);
            p.counted.retain(|_, (_, seen)| *seen + 7 * DAY > now);
            for h in p.quota_history.values_mut() {
                h.retain(|b, _| *b + QUOTA_HISTORY_MS > now);
            }
            p.quota_history.retain(|_, h| !h.is_empty());
        }
        st.dirty = false;
        serde_json::to_vec(&st.saved)?
    };
    // The saver thread, Quit, Clear history and exit can all save: one writer at a time on the same tmp file.
    static SAVE: Mutex<()> = Mutex::new(());
    let _one = SAVE.lock().unwrap_or_else(|e| e.into_inner());
    let result = atomic_write(path, &bytes);
    if result.is_err() {
        lock(shared).dirty = true;
    }
    result
}

pub fn hour_of(ts: u64) -> u64 {
    ts - ts % HOUR
}

// ---------- wire snapshot ----------

struct Meta {
    pid: &'static str,
    name: &'static str,
    token_model: &'static str,
    tokens_src: &'static str,
    context_src: &'static str,
    context_kind: &'static str,
}

const CLAUDE: Meta = Meta {
    pid: "claude",
    name: "Claude",
    token_model: "separate-cache",
    tokens_src: "Local Claude Code logs (message.usage)",
    context_src: "Last message: input + cache read + cache write",
    context_kind: "estimate",
};
const CODEX: Meta = Meta {
    pid: "codex",
    name: "Codex",
    token_model: "subset-cache",
    tokens_src: "Local Codex events (token_count)",
    context_src: "Last turn: total_tokens / model_context_window",
    context_kind: "computed",
};

fn quota_state(q: &QuotaSet, err: &Option<(String, String, u64)>, now: u64) -> (&'static str, Option<String>) {
    if let Some((state, reason, _)) = err {
        return (if state == "error" && q.observed_at == 0 { "error" } else { "stale" }, Some(reason.clone()));
    }
    if q.observed_at + 30 * MIN < now {
        return ("stale", Some("Last reading is old".into()));
    }
    ("available", None)
}

fn provider_wire(m: &Meta, saved: &ProviderSaved, rt: &Runtime, paused: bool, now: u64) -> Value {
    let last_event = saved.sessions.values().map(|s| s.last_event).max().unwrap_or(0);
    let open = rt.running.join(" + ");
    let (state, label) = if !rt.detected && open.is_empty() {
        ("unavailable", format!("{} not detected", m.name))
    } else if paused {
        ("idle", "Collection paused".to_string())
    } else if let Some(err) = &rt.read_error {
        ("error", err.clone())
    } else if let Some((s, reason, _)) = &rt.quota_error {
        // With an earlier reading the data is only old ("Check"); "Error" is for when there never was one.
        (if s == "error" && saved.quota.observed_at == 0 { "error" } else { "stale" }, reason.clone())
    } else if last_event + ACTIVE_MS > now {
        ("available", "Collection active".to_string())
    } else if !open.is_empty() {
        ("available", format!("{open} open"))
    } else {
        ("idle", "No active client".to_string())
    };

    let mut sessions: Vec<&Session> = saved.sessions.values().filter(|s| s.last_event + DAY > now).collect();
    sessions.sort_by(|a, b| b.last_event.cmp(&a.last_event));
    // Background SDK agents (memory plugins, hooks) run their own model; the headline shows the one you chat with.
    let with_model = || sessions.iter().filter(|s| !s.model.is_empty());
    let model = with_model().find(|s| s.client != "SDK").or_else(|| with_model().next()).map(|s| json!({ "v": s.model, "at": s.last_event }));
    sessions.truncate(8);

    let mut clients: BTreeMap<&str, (bool, u64)> = BTreeMap::new();
    for s in saved.sessions.values().filter(|s| s.last_event + 2 * DAY > now) {
        let e = clients.entry(s.client.as_str()).or_default();
        e.0 |= s.last_event + ACTIVE_MS > now;
        e.1 = e.1.max(s.last_event);
    }
    for label in &rt.running {
        clients.entry(label).or_default().0 = true;
    }

    // Daily sums (UTC days) of the last 35 days, for the AI Cost widget's month figure.
    let mut daily: BTreeMap<u64, Tok> = BTreeMap::new();
    for (h, t) in saved.hours.range(hour_of(now.saturating_sub(35 * DAY))..) {
        daily.entry(h - h % DAY).or_default().add(t);
    }
    let days: Vec<Value> = daily
        .iter()
        .map(|(d, t)| {
            let mut v = t.wire();
            v["start"] = json!(d);
            v
        })
        .collect();

    let (qstate, qreason) = quota_state(&saved.quota, &rt.quota_error, now);
    let quotas: Vec<Value> = saved
        .quota
        .quotas
        .iter()
        .map(|q| {
            let passed = q.resets_at.is_some_and(|r| r < now);
            let (st, reason) = if passed && qstate == "available" {
                ("stale", Some("Scheduled reset has passed: waiting for a new reading".to_string()))
            } else {
                (qstate, qreason.clone())
            };
            json!({
                "id": q.id, "label": q.label, "windowMinutes": q.window_minutes, "resetsAt": q.resets_at,
                "history": quota_history(saved.quota_history.get(&q.id), now),
                "used": { "v": q.used, "unit": "%", "kind": "reported", "state": st, "src": saved.quota.src, "at": saved.quota.observed_at, "reason": reason }
            })
        })
        .collect();

    let hours: Vec<Value> = saved
        .hours
        .range(hour_of(now.saturating_sub(WIRE_HOURS_MS))..)
        .map(|(h, t)| {
            let mut v = t.wire();
            v["start"] = json!(h);
            v
        })
        .collect();


    json!({
        "provider": m.pid,
        "name": m.name,
        "status": { "state": state, "label": label },
        "refreshing": rt.refreshing,
        "detected": rt.detected || !rt.running.is_empty(),
        "lastEventAt": last_event,
        "tokenModel": m.token_model,
        "quotaScope": "Account",
        "src": { "tokens": m.tokens_src, "context": m.context_src, "contextKind": m.context_kind },
        "model": model,
        "clients": clients.iter().map(|(label, (active, seen))| json!({ "label": label, "active": active, "lastSeenAt": seen })).collect::<Vec<_>>(),
        "quotas": quotas,
        "quotaError": rt.quota_error.as_ref().map(|(s, r, at)| json!({ "state": s, "reason": r, "at": at })),
        "credits": saved.quota.credits,
        "hours": hours,
        "days": days,
        "sessions": sessions.iter().map(|s| json!({
            "id": s.id, "client": s.client, "model": s.model, "active": s.last_event + ACTIVE_MS > now,
            "startedAt": s.started, "lastEventAt": s.last_event, "tokens": s.tokens.wire(),
            "context": { "used": s.context_used, "capacity": s.context_cap, "at": s.context_at }
        })).collect::<Vec<_>>(),
        "events": rt.events.iter().map(|(at, t)| json!({ "at": at, "text": t })).collect::<Vec<_>>(),
    })
}

/// Last 24 h as fixed 10-minute steps; `null` where no reading exists (never filled in).
fn quota_history(h: Option<&BTreeMap<u64, f64>>, now: u64) -> Value {
    let Some(h) = h.filter(|h| !h.is_empty()) else { return Value::Null };
    let end = now - now % HISTORY_STEP;
    let start = end - (QUOTA_HISTORY_MS - HISTORY_STEP);
    let v: Vec<Value> = (0..QUOTA_HISTORY_MS / HISTORY_STEP).map(|i| h.get(&(start + i * HISTORY_STEP)).map_or(Value::Null, |x| json!(x.round()))).collect();
    json!({ "start": start, "step": HISTORY_STEP, "v": v })
}

pub fn snapshot(st: &Store) -> Value {
    let now = now_ms();
    json!({
        "schema": "ai-usage/1",
        "generatedAt": now,
        "paused": st.paused,
        "providers": {
            "claude": provider_wire(&CLAUDE, &st.saved.claude, &st.claude, st.paused, now),
            "codex": provider_wire(&CODEX, &st.saved.codex, &st.codex, st.paused, now),
        }
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn quota_history_keeps_bucket_peak_and_leaves_gaps_empty() {
        let mut p = ProviderSaved::default();
        let now = 1_790_000_000_000 - 1_790_000_000_000 % HISTORY_STEP + 5 * MIN;
        let q = |used, at| QuotaSet { quotas: vec![Quota { id: "five_hour".into(), used, ..Default::default() }], observed_at: at, ..Default::default() };
        p.set_quota(q(40.0, now - 4 * MIN));
        p.set_quota(q(35.0, now - MIN));
        let w = quota_history(p.quota_history.get("five_hour"), now);
        let v = w["v"].as_array().unwrap();
        assert_eq!(v.len(), 144);
        assert_eq!(v[143], json!(40.0));
        assert!(v[..143].iter().all(Value::is_null));
        assert_eq!(quota_history(None, now), Value::Null);
    }

    #[test]
    fn growth_never_negative() {
        let a = Tok { input: 10, output: 5, ..Default::default() };
        let b = Tok { input: 7, output: 9, ..Default::default() };
        assert_eq!(b.growth_over(&a), Tok { input: 0, output: 4, ..Default::default() });
        assert_eq!(a.max(&b), Tok { input: 10, output: 9, ..Default::default() });
    }

    #[test]
    fn snapshot_never_leaks_raw_ids_or_paths() {
        let shared = load_for_test();
        update(&shared, |st| {
            st.saved.claude.sessions.insert("raw-session-uuid".into(), Session { id: "c-abc123".into(), last_event: now_ms(), ..Default::default() });
            st.saved.claude.files.insert(r"C:\Users\me\.claude\projects\secret\x.jsonl".into(), FileCtx::default());
            st.saved.claude.counted.insert("msg_123|req_456".into(), (Tok::default(), 0));
        });
        let (text, token, salt) = {
            let st = lock(&shared);
            (snapshot(&st).to_string(), st.saved.widget_token.clone(), st.saved.salt.clone())
        };
        for leak in ["raw-session-uuid", "secret", "msg_123", "req_456", token.as_str(), salt.as_str()] {
            assert!(!text.contains(leak), "leaked {leak}");
        }
    }

    #[test]
    fn headline_model_ignores_background_sdk_sessions() {
        let shared = load_for_test();
        let now = now_ms();
        update(&shared, |st| {
            let s = &mut st.saved.claude.sessions;
            s.insert("chat".into(), Session { id: "c-chat".into(), client: "Desktop".into(), model: "claude-opus-5-5".into(), last_event: now - 60_000, ..Default::default() });
            for i in 0..9 {
                s.insert(format!("bg{i}"), Session { id: format!("c-bg{i}"), client: "SDK".into(), model: "claude-sonnet-4-5".into(), last_event: now - i, ..Default::default() });
            }
        });
        let text = snapshot(&lock(&shared)).to_string();
        assert!(text.contains(r#""v":"claude-opus-5-5""#), "{text}");
    }

    #[test]
    fn expired_token_with_an_earlier_reading_is_check_not_error() {
        let shared = load_for_test();
        let now = now_ms();
        let quota_error = || Some(("error".to_string(), "Claude sign-in expired".to_string(), now));
        update(&shared, |st| {
            st.claude.detected = true;
            st.claude.quota_error = quota_error();
        });
        assert!(snapshot(&lock(&shared)).to_string().contains(r#""status":{"label":"Claude sign-in expired","state":"error"}"#));
        update(&shared, |st| {
            st.saved.claude.set_quota(QuotaSet { quotas: vec![Quota { id: "seven_day".into(), used: 21.0, ..Default::default() }], observed_at: now - 5 * 3600_000, ..Default::default() });
            st.claude.quota_error = quota_error();
        });
        assert!(snapshot(&lock(&shared)).to_string().contains(r#""status":{"label":"Claude sign-in expired","state":"stale"}"#));
    }

    #[test]
    fn failed_save_stays_dirty_for_retry() {
        let shared = load_for_test();
        let root = std::env::temp_dir().join(format!("companion-save-{}", random_hex(4)));
        std::fs::create_dir_all(&root).unwrap();
        let parent_file = root.join("not-a-directory");
        std::fs::write(&parent_file, b"x").unwrap();
        assert!(save_to(&shared, &parent_file.join("state.json")).is_err());
        assert!(lock(&shared).dirty);
        std::fs::remove_dir_all(root).unwrap();
    }

    pub fn load_for_test() -> Shared {
        let s = load();
        let mut st = lock(&s);
        st.saved = Saved { salt: "salt".into(), widget_token: "tok".repeat(8), ..Default::default() };
        drop(st);
        s
    }
}
