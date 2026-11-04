//! Loopback HTTP server for the iCUE widgets. A request is accepted when the connection comes
//! from iCUE itself (the peer socket is mapped to its process, which must be `iCUE.exe` under
//! Program Files), or when it carries `Authorization: Bearer <widget token>` (scripts, tests).
//! Browsers and other programs get 401, whatever Origin they send.
//! The companion's own window uses Tauri IPC, not this server.
//! Routes are grouped per feature (`/api/usage/...`, `/api/media/...`).
use crate::media;
use crate::spotify;
use crate::usage::store::{lock, snapshot, update, Shared};
use crate::util::{constant_time_eq, now_ms, SEC};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const PORT: u16 = 47821;
const MAX_CONNECTIONS: usize = 24;
const MAX_STREAMS: usize = 8;
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 1024;
const MAX_EVENT: usize = 512 * 1024;

static CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
static STREAMS: AtomicUsize = AtomicUsize::new(0);
static FEEDS: [AtomicUsize; 3] = [AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0)];

/// The three event streams a widget can hold.
#[derive(Clone, Copy)]
pub enum Feed {
    Usage,
    Media,
    Spotify,
}

/// Live streams on one feed (the Widgets page shows which widgets are connected).
pub fn feed_streams(feed: Feed) -> usize {
    FEEDS[feed as usize].load(Ordering::SeqCst)
}

/// Endpoints that widgets poll instead of holding a stream (AI Cost, Screen Time).
#[derive(Clone, Copy)]
pub enum Poll {
    Usage,
    ScreenTime,
    Mixer,
    Agent,
    Deck,
    Stocks,
    Net,
    Game,
    Deals,
    Patches,
}
static POLLED_AT: [std::sync::atomic::AtomicU64; 10] = [const { std::sync::atomic::AtomicU64::new(0) }; 10];
fn polled(p: Poll) {
    POLLED_AT[p as usize].store(crate::util::now_ms(), Ordering::SeqCst);
}

/// True when a widget asked for this endpoint in the last 90 s (they poll every 15 to 30 s).
pub fn polled_recently(poll: Poll) -> bool {
    POLLED_AT[poll as usize].load(Ordering::SeqCst) + 90_000 > crate::util::now_ms()
}


pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    pub fn param(&self, name: &str) -> Option<&str> {
        self.query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v)
    }

    fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

pub fn read_request(stream: &mut impl Read) -> Result<Request, u16> {
    let mut reader = BufReader::new(stream);
    let mut head = Vec::new();
    loop {
        let mut line = Vec::new();
        let n = reader.by_ref().take((MAX_HEAD - head.len()) as u64 + 1).read_until(b'\n', &mut line).map_err(|_| 408u16)?;
        if n == 0 {
            return Err(400);
        }
        head.extend_from_slice(&line);
        if head.len() > MAX_HEAD {
            return Err(431);
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
    }
    let text = String::from_utf8(head).map_err(|_| 400u16)?;
    let mut lines = text.lines();
    let mut first = lines.next().ok_or(400u16)?.split(' ');
    let (method, target) = (first.next().ok_or(400u16)?.to_string(), first.next().ok_or(400u16)?);
    let target = target.split('#').next().unwrap_or("/");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let (path, query) = (path.to_string(), query.to_string());
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let len: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return Err(413);
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).map_err(|_| 400u16)?;
    Ok(Request { method, path, query, headers, body })
}

/// DNS-rebinding guard: only our loopback authority is accepted.
/// A web page from a remote site (Origin http(s)://, not this machine). Widgets run from local files
/// (Origin null or file://) and local dev pages from loopback, so none of ours is refused. This keeps a
/// remote document that iCUE might render in its own process (and so passes the peer check) away from the API.
pub fn remote_origin(req: &Request) -> bool {
    let Some(o) = req.header("origin") else { return false };
    let o = o.trim().to_ascii_lowercase();
    let Some(rest) = o.strip_prefix("http://").or_else(|| o.strip_prefix("https://")) else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit_once(':').filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit())).map_or(host, |(h, _)| h);
    !matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

pub fn host_ok(req: &Request) -> bool {
    matches!(req.header("host"), Some(h) if h == format!("127.0.0.1:{PORT}") || h == format!("localhost:{PORT}"))
}

/// iCUE's install folder is writable only by an administrator, so a user-level program cannot pose as it.
pub fn is_icue_path(path: &str, program_files: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.starts_with(&format!(r"{}\corsair\", program_files.trim_end_matches('\\').to_ascii_lowercase())) && p.ends_with(r"\icue.exe")
}

fn peer_is_icue(stream: &TcpStream) -> bool {
    let Ok(peer) = stream.peer_addr() else { return false };
    let Ok(local) = stream.local_addr() else { return false };
    let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    peer_process(peer, local).and_then(crate::util::exe_path).is_some_and(|p| is_icue_path(&p, &program_files))
}

/// Owner of the client end of a loopback connection to our port, from the system TCP table.
#[cfg(windows)]
fn peer_process(client: SocketAddr, server: SocketAddr) -> Option<u32> {
    use windows::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_CONNECTIONS};
    const AF_INET: u32 = 2;
    let mut size = 0u32;
    unsafe { GetExtendedTcpTable(None, &mut size, false, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) };
    // u32 buffer keeps the table aligned; slack covers connections opened between the two calls.
    let mut buf = vec![0u32; size as usize / 4 + 1024];
    size = (buf.len() * 4) as u32;
    if unsafe { GetExtendedTcpTable(Some(buf.as_mut_ptr().cast()), &mut size, false, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) } != 0 {
        return None;
    }
    let table = buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
    let rows: &[MIB_TCPROW_OWNER_PID] = unsafe { std::slice::from_raw_parts((*table).table.as_ptr(), (*table).dwNumEntries as usize) };
    // Ports sit in network byte order in the low 16 bits.
    let port = |p: u32| u16::from_be(p as u16);
    let (SocketAddr::V4(client), SocketAddr::V4(server)) = (client, server) else { return None };
    rows.iter()
        .find(|r| tcp_row_matches(r.dwLocalAddr, port(r.dwLocalPort), r.dwRemoteAddr, port(r.dwRemotePort), *client.ip(), client.port(), *server.ip(), server.port()))
        .map(|r| r.dwOwningPid)
}

#[cfg(not(windows))]
fn peer_process(_: SocketAddr, _: SocketAddr) -> Option<u32> {
    None
}

fn tcp_row_matches(
    local_addr: u32,
    local_port: u16,
    remote_addr: u32,
    remote_port: u16,
    client_addr: Ipv4Addr,
    client_port: u16,
    server_addr: Ipv4Addr,
    server_port: u16,
) -> bool {
    local_addr == u32::from_ne_bytes(client_addr.octets())
        && local_port == client_port
        && remote_addr == u32::from_ne_bytes(server_addr.octets())
        && remote_port == server_port
}

/// Off unless started with `--allow-token`: any program of the same Windows account can read the
/// token in state.json, so by default only iCUE (checked by process) gets in.
pub static TOKEN_ENABLED: AtomicBool = AtomicBool::new(false);

/// Token check for callers other than iCUE. Origin (even `null`) never grants access by itself.
pub fn authorized(req: &Request, shared: &Shared) -> bool {
    if !TOKEN_ENABLED.load(Ordering::Relaxed) {
        return false;
    }
    let token = lock(shared).saved.widget_token.clone();
    req.header("authorization").and_then(|v| v.strip_prefix("Bearer ")).is_some_and(|t| constant_time_eq(t.trim(), &token))
}

fn respond(stream: &mut TcpStream, status: u16, headers: &[(&str, String)], body: &[u8]) {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        421 => "Misdirected Request",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        _ => "Service Unavailable",
    };
    let mut out = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n", body.len());
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    let _ = stream.write_all(out.as_bytes());
    let _ = stream.write_all(body);
}

fn cors(req: &Request) -> Vec<(&'static str, String)> {
    match req.header("origin") {
        Some(origin) => vec![("Access-Control-Allow-Origin", origin.to_string()), ("Vary", "Origin".into())],
        None => Vec::new(),
    }
}

/// Reads with one deadline for the whole request, so a client sending a byte every few seconds
/// cannot hold a connection slot (the per-read timeout alone would allow that).
struct Deadline<'a> {
    stream: &'a TcpStream,
    until: std::time::Instant,
}

impl Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = self.until.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        self.stream.set_read_timeout(Some(left))?;
        (&mut &*self.stream).read(buf)
    }
}

fn handle(mut stream: TcpStream, shared: Shared) {
    // A client that stops reading must not pin a thread (and a stream slot) forever.
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let deadline = Deadline { stream: &stream, until: std::time::Instant::now() + Duration::from_secs(5) };
    let req = match read_request(&mut { deadline }) {
        Ok(r) => r,
        Err(code) => return respond(&mut stream, code, &[], b""),
    };
    if !host_ok(&req) {
        return respond(&mut stream, 421, &[], b"");
    }
    if remote_origin(&req) {
        return respond(&mut stream, 403, &[], b"");
    }
    // CORS preflight: reveals nothing; the real request still needs iCUE (or the token in test mode).
    if req.method == "OPTIONS" {
        let mut h = vec![
            ("Access-Control-Allow-Origin", req.header("origin").unwrap_or("null").to_string()),
            ("Access-Control-Allow-Methods", "GET, POST".into()),
            ("Access-Control-Allow-Headers", "Authorization, Content-Type".into()),
            ("Access-Control-Max-Age", "600".into()),
            ("Vary", "Origin".into()),
        ];
        if req.header("access-control-request-private-network").is_some() {
            h.push(("Access-Control-Allow-Private-Network", "true".into()));
        }
        return respond(&mut stream, 204, &h, b"");
    }
    let mut headers = cors(&req);
    if !req.path.starts_with("/api/") {
        return respond(&mut stream, 404, &headers, b"");
    }
    // Browser redirect after Spotify sign-in: no token possible here. It only completes a sign-in the
    // companion started, identified by its single-use random state (see spotify::auth::callback).
    if req.method == "GET" && req.path == "/api/spotify/callback" {
        let (code, message) = spotify::auth::callback(&req.query);
        let page = format!(
            "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>iCUE Edge Companion</title><body style=\"font:16px Segoe UI,sans-serif;background:#171717;color:#ececec;display:grid;place-items:center;height:100vh;margin:0\"><p>{message}</p></body></html>"
        );
        let h = [
            ("Content-Type", "text/html; charset=utf-8".to_string()),
            ("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'".to_string()),
            ("Referrer-Policy", "no-referrer".to_string()),
        ];
        return respond(&mut stream, code, &h, page.as_bytes());
    }
    if !authorized(&req, &shared) && !peer_is_icue(&stream) {
        return respond(&mut stream, 401, &headers, b"{\"error\":\"unauthorized\"}");
    }
    headers.push(("Content-Type", "application/json".into()));
    match (req.method.as_str(), req.path.as_str()) {
        // Screen Time widget: asking for its data is what switches collection on (see screentime.rs).
        ("GET", "/api/screentime/state") => {
            crate::screentime::enable();
            POLLED_AT[Poll::ScreenTime as usize].store(crate::util::now_ms(), Ordering::SeqCst);
            respond(&mut stream, 200, &headers, crate::screentime::snapshot_now().to_string().as_bytes());
        }
        // Audio Mixer, Agent Activity and Control Deck widgets.
        ("GET", "/api/mixer/state") => {
            polled(Poll::Mixer);
            respond(&mut stream, 200, &headers, crate::mixer::snapshot().to_string().as_bytes());
        }
        ("POST", "/api/mixer/command") => match req.json().ok_or((400, "bad_request")).and_then(|b| crate::mixer::command(&b)) {
            Ok(()) => respond(&mut stream, 200, &headers, b"{\"ok\":true}"),
            Err((code, error)) => respond(&mut stream, code, &headers, format!("{{\"error\":\"{error}\"}}").as_bytes()),
        },
        ("GET", "/api/agent/state") => {
            polled(Poll::Agent);
            let body = crate::usage::claude::agent_snapshot(&lock(&shared), now_ms()).to_string();
            respond(&mut stream, 200, &headers, body.as_bytes());
        }
        // Stocks widget: ?s=AAPL,NVDA (checked and capped in stocks.rs; only those symbols are sent to Yahoo).
        ("GET", "/api/stocks/state") => {
            polled(Poll::Stocks);
            let body = crate::stocks::snapshot(&crate::spotify::auth::percent_decode(req.param("s").unwrap_or(""))).to_string();
            respond(&mut stream, 200, &headers, body.as_bytes());
        }
        // Network Pulse widget: ?ping=cloudflare|google|quad9|off (any other value pings nothing).
        ("GET", "/api/net/state") => {
            polled(Poll::Net);
            respond(&mut stream, 200, &headers, crate::net::snapshot(req.param("ping").unwrap_or("off")).to_string().as_bytes());
        }
        // Rig Monitor widget: CPU and GPU load, RAM and VRAM over the last 3 minutes, sampled without pause.
        ("GET", "/api/system/history") => respond(&mut stream, 200, &headers, crate::system::snapshot().to_string().as_bytes()),
        // Game Session widget: asking is what switches the foreground watch on (see game.rs).
        ("GET", "/api/game/state") => {
            polled(Poll::Game);
            respond(&mut stream, 200, &headers, crate::game::snapshot().to_string().as_bytes());
        }
        // Free Games & Deals widget: ?cc=FR&steam=570,1245620 (checked and capped in deals.rs).
        ("GET", "/api/deals/state") => {
            polled(Poll::Deals);
            let body = crate::deals::snapshot(req.param("cc").unwrap_or("US"), &crate::spotify::auth::percent_decode(req.param("steam").unwrap_or(""))).to_string();
            respond(&mut stream, 200, &headers, body.as_bytes());
        }
        ("GET", "/api/deals/image") => match crate::deals::image_bytes(&crate::spotify::auth::percent_decode(req.param("u").unwrap_or(""))) {
            Some((mime, bytes)) => {
                headers.retain(|(k, _)| *k != "Content-Type");
                headers.push(("Content-Type", mime));
                respond(&mut stream, 200, &headers, &bytes)
            }
            None => respond(&mut stream, 404, &headers, b"{\"error\":\"no_image\"}"),
        },
        // Patch Radar widget: ?apps=271590,1245620 (checked and capped in deals.rs).
        ("GET", "/api/patches/state") => {
            polled(Poll::Patches);
            let body = crate::patches::snapshot(&crate::spotify::auth::percent_decode(req.param("apps").unwrap_or(""))).to_string();
            respond(&mut stream, 200, &headers, body.as_bytes());
        }
        ("GET", "/api/deck/state") => {
            polled(Poll::Deck);
            respond(&mut stream, 200, &headers, crate::deck::snapshot().to_string().as_bytes());
        }
        ("POST", "/api/deck/run") => match req.json().as_ref().and_then(|b| b["id"].as_str().map(str::to_string)).ok_or((400, "bad_request")).and_then(|id| crate::deck::run(&id)) {
            Ok(()) => respond(&mut stream, 200, &headers, b"{\"ok\":true}"),
            Err((code, error)) => respond(&mut stream, code, &headers, format!("{{\"error\":\"{error}\"}}").as_bytes()),
        },
        ("GET", "/api/usage/state") => {
            POLLED_AT[Poll::Usage as usize].store(crate::util::now_ms(), Ordering::SeqCst);
            let body = snapshot(&lock(&shared)).to_string();
            respond(&mut stream, 200, &headers, body.as_bytes());
        }
        ("GET", "/api/usage/events") => stream_events(stream, &req, Feed::Usage, |seen| {
            let mut st = lock(&shared);
            if st.version == *seen {
                st = shared.changed.wait_timeout(st, Duration::from_secs(5)).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
            }
            (st.version != *seen).then(|| {
                *seen = st.version;
                snapshot(&st).to_string()
            })
        }),
        ("POST", "/api/usage/refresh") => {
            if request_refresh(&shared) {
                respond(&mut stream, 200, &headers, b"{\"ok\":true}");
            } else {
                headers.push(("Retry-After", "30".into()));
                respond(&mut stream, 429, &headers, b"{\"error\":\"too_soon\"}");
            }
        }
        ("GET", "/api/media/state") => {
            let body = media::snapshot(&media::lock()).to_string();
            respond(&mut stream, 200, &headers, body.as_bytes());
        }
        ("GET", "/api/media/events") => stream_events(stream, &req, Feed::Media, |seen| {
            let mut st = media::lock();
            if st.version == *seen {
                st = media::HUB.changed.wait_timeout(st, Duration::from_secs(5)).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
            }
            (st.version != *seen).then(|| {
                *seen = st.version;
                media::snapshot(&st).to_string()
            })
        }),
        ("GET", "/api/media/viz") => stream_events(stream, &req, Feed::Media, media::viz::next),
        ("GET", "/api/media/art") => {
            let art = match (req.param("s"), req.param("r").and_then(|r| r.parse().ok())) {
                (Some(id), Some(rev)) => media::art_for(&media::lock(), id, rev),
                _ => None,
            };
            match art {
                Some((mime, bytes)) => {
                    headers.retain(|(k, _)| *k != "Content-Type");
                    headers.push(("Content-Type", mime.into()));
                    respond(&mut stream, 200, &headers, &bytes);
                }
                None => respond(&mut stream, 404, &headers, b"{\"error\":\"no_artwork\"}"),
            }
        }
        ("POST", "/api/media/command") if matches!(req.json().as_ref().and_then(|b| b["cmd"].as_str()), Some("volume" | "mute" | "sleep")) => {
            match media::system_command(&req.json().unwrap_or_default(), now_ms()) {
                Ok(()) => respond(&mut stream, 200, &headers, b"{\"ok\":true}"),
                Err((code, error)) => respond(&mut stream, code, &headers, format!("{{\"error\":\"{error}\"}}").as_bytes()),
            }
        }
        ("POST", "/api/media/command") => {
            let target = req.json().ok_or((400, "bad_request")).and_then(|body| media::resolve(&media::lock(), &body, now_ms()));
            match target.map(|t| media::execute(&t)) {
                Ok(Ok(accepted)) => respond(&mut stream, 200, &headers, format!("{{\"ok\":{accepted}}}").as_bytes()),
                Ok(Err(_)) => respond(&mut stream, 503, &headers, b"{\"error\":\"player_unreachable\"}"),
                Err((code, error)) => respond(&mut stream, code, &headers, format!("{{\"error\":\"{error}\"}}").as_bytes()),
            }
        }
        ("GET", "/api/spotify/state") => {
            let body = spotify::snapshot(&spotify::lock()).to_string();
            respond(&mut stream, 200, &headers, body.as_bytes());
        }
        ("GET", "/api/spotify/events") => stream_events(stream, &req, Feed::Spotify, |seen| {
            let mut st = spotify::lock();
            if st.version == *seen {
                st = spotify::HUB.changed.wait_timeout(st, Duration::from_secs(5)).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
            }
            (st.version != *seen).then(|| {
                *seen = st.version;
                spotify::snapshot(&st).to_string()
            })
        }),
        ("GET", "/api/spotify/art") => match req.param("r").and_then(|r| r.parse().ok()).and_then(|rev| spotify::art_for(&spotify::lock(), rev)) {
            Some((mime, bytes)) => {
                headers.retain(|(k, _)| *k != "Content-Type");
                headers.push(("Content-Type", mime.into()));
                respond(&mut stream, 200, &headers, &bytes);
            }
            None => respond(&mut stream, 404, &headers, b"{\"error\":\"no_artwork\"}"),
        },
        ("GET", "/api/spotify/queue-art") => {
            let art = match (req.param("i").and_then(|i| i.parse().ok()), req.param("q").and_then(|q| q.parse().ok())) {
                (Some(i), Some(q)) => spotify::queue_art_for(&spotify::lock(), i, q),
                _ => None,
            };
            match art {
                Some((mime, bytes)) => {
                    headers.retain(|(k, _)| *k != "Content-Type");
                    headers.push(("Content-Type", mime.into()));
                    respond(&mut stream, 200, &headers, &bytes);
                }
                None => respond(&mut stream, 404, &headers, b"{\"error\":\"no_artwork\"}"),
            }
        }
        ("POST", "/api/spotify/command") if req.json().is_some_and(|b| spotify::local_command(&spotify::lock(), &b).is_some()) => {
            // Spotify rate-limits the app: the command goes to the Spotify app through Windows instead.
            let body = req.json().and_then(|b| spotify::local_command(&spotify::lock(), &b)).unwrap_or_default();
            match media::resolve(&media::lock(), &body, now_ms()).map(|t| media::execute(&t)) {
                Ok(Ok(accepted)) => respond(&mut stream, 200, &headers, format!("{{\"ok\":{accepted}}}").as_bytes()),
                Ok(Err(_)) => respond(&mut stream, 503, &headers, b"{\"error\":\"player_unreachable\"}"),
                Err((code, error)) => respond(&mut stream, code, &headers, format!("{{\"error\":\"{error}\"}}").as_bytes()),
            }
        }
        ("POST", "/api/spotify/command") => {
            let call = req.json().ok_or((400, "bad_request")).and_then(|body| spotify::resolve(&spotify::lock(), &body));
            match call.and_then(|c| spotify::api::execute(&c)) {
                Ok(()) => respond(&mut stream, 200, &headers, b"{\"ok\":true}"),
                Err((code, error)) => respond(&mut stream, code, &headers, format!("{{\"error\":\"{error}\"}}").as_bytes()),
            }
        }
        ("POST", "/api/media/select") => match req.json().ok_or((400, "bad_request")).and_then(|body| media::select(&body)) {
            Ok(()) => respond(&mut stream, 200, &headers, b"{\"ok\":true}"),
            Err((code, error)) => respond(&mut stream, code, &headers, format!("{{\"error\":\"{error}\"}}").as_bytes()),
        },
        _ => respond(&mut stream, 404, &headers, b""),
    }
}

/// Manual quota refresh, at most once per 30 s whatever the caller (tray, window, widget).
pub fn request_refresh(shared: &Shared) -> bool {
    update(shared, |st| {
        let now = now_ms();
        if now < st.last_manual_refresh + 30 * SEC {
            return false;
        }
        st.last_manual_refresh = now;
        st.force_refresh_claude = true;
        st.force_refresh_codex = true;
        true
    })
}

/// One thread per stream, woken by store changes. Full snapshots (a few KiB) make reconnection trivial.
/// `next` waits up to 5 s and returns the new snapshot when the watched version moved past `seen`.
fn stream_events(mut stream: TcpStream, req: &Request, feed: Feed, mut next: impl FnMut(&mut u64) -> Option<String>) {
    if STREAMS.fetch_add(1, Ordering::SeqCst) >= MAX_STREAMS {
        STREAMS.fetch_sub(1, Ordering::SeqCst);
        return respond(&mut stream, 503, &cors(req), b"");
    }
    FEEDS[feed as usize].fetch_add(1, Ordering::SeqCst);
    let mut head = String::from("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\nX-Content-Type-Options: nosniff\r\n");
    for (k, v) in cors(req) {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\nretry: 3000\n\n");
    let mut ok = stream.write_all(head.as_bytes()).is_ok();
    let mut seen = 0u64;
    let mut idle = 0u8;
    // A 1 ms read timeout turns peek() into a liveness probe: Ok(0) means the client left,
    // so a closed widget frees its slot within 5 s instead of holding it until a write fails.
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1)));
    while ok {
        let mut probe = [0u8; 1];
        if matches!(stream.peek(&mut probe), Ok(0)) {
            break;
        }
        let msg = match next(&mut seen) {
            Some(p) if p.len() <= MAX_EVENT => format!("event: state\ndata: {p}\n\n"),
            Some(_) => "event: error\ndata: {\"error\":\"too_large\"}\n\n".to_string(),
            None => {
                idle += 1;
                if idle < 3 {
                    continue;
                }
                ": ping\n\n".to_string()
            }
        };
        idle = 0;
        ok = stream.write_all(msg.as_bytes()).and_then(|_| stream.flush()).is_ok();
    }
    FEEDS[feed as usize].fetch_sub(1, Ordering::SeqCst);
    STREAMS.fetch_sub(1, Ordering::SeqCst);
}

pub fn run(shared: Shared) {
    let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
        Ok(l) => l,
        Err(e) => {
            update(&shared, |st| st.server_error = Some(format!("Port {PORT} unavailable: {e}")));
            return;
        }
    };
    for stream in listener.incoming().flatten() {
        if CONNECTIONS.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            handle(stream, shared);
            CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::store;

    fn req(raw: &str) -> Request {
        read_request(&mut raw.as_bytes()).unwrap()
    }

    #[test]
    fn remote_web_origins_are_refused() {
        let o = |v: &str| req(&format!("GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nOrigin: {v}\r\n\r\n"));
        for bad in ["https://example.com", "http://evil.test:8080", "https://127.0.0.1.evil.test", "HTTPS://Store.SteamPowered.com/x"] {
            assert!(remote_origin(&o(bad)), "{bad}");
        }
        for ok in ["null", "file://", "http://localhost:8812", "http://127.0.0.1:5181", "http://[::1]:80"] {
            assert!(!remote_origin(&o(ok)), "{ok}");
        }
        assert!(!remote_origin(&req("GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:47821\r\n\r\n")));
    }

    #[test]
    fn host_origin_and_token_rules() {
        let shared = store::tests::load_for_test();
        let token = lock(&shared).saved.widget_token.clone();
        assert!(!host_ok(&req("GET /api/usage/state HTTP/1.1\r\nHost: evil.example:47821\r\n\r\n")));
        assert!(host_ok(&req("GET /api/usage/state HTTP/1.1\r\nHost: 127.0.0.1:47821\r\n\r\n")));
        assert!(!authorized(&req("GET /api/usage/state HTTP/1.1\r\nHost: 127.0.0.1:47821\r\n\r\n"), &shared));
        // Origin: null alone is not trusted.
        assert!(!authorized(&req("GET /api/usage/state HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nOrigin: null\r\n\r\n"), &shared));
        assert!(!authorized(&req("GET /api/usage/state HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nAuthorization: Bearer wrong\r\n\r\n"), &shared));
        let ok = format!("GET /api/usage/state HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nOrigin: null\r\nAuthorization: Bearer {token}\r\n\r\n");
        // The right token is refused unless the companion was started with --allow-token.
        TOKEN_ENABLED.store(false, Ordering::Relaxed);
        assert!(!authorized(&req(&ok), &shared));
        TOKEN_ENABLED.store(true, Ordering::Relaxed);
        assert!(authorized(&req(&ok), &shared));
        TOKEN_ENABLED.store(false, Ordering::Relaxed);
    }

    #[test]
    fn only_icue_under_program_files_counts() {
        let pf = r"C:\Program Files";
        assert!(is_icue_path(r"C:\Program Files\Corsair\Corsair iCUE5 Software\iCUE.exe", pf));
        assert!(!is_icue_path(r"C:\Users\x\Downloads\Corsair\iCUE.exe", pf));
        assert!(!is_icue_path(r"C:\Program Files\Corsair\Corsair iCUE5 Software\iCUE.exe.bak", pf));
        assert!(!is_icue_path(r"C:\Program Files\Google\Chrome\Application\chrome.exe", pf));
    }

    #[test]
    fn tcp_owner_match_includes_both_addresses() {
        let client = Ipv4Addr::new(127, 0, 0, 1);
        let server = Ipv4Addr::new(127, 0, 0, 1);
        let addr = |ip: Ipv4Addr| u32::from_ne_bytes(ip.octets());
        assert!(tcp_row_matches(addr(client), 50000, addr(server), PORT, client, 50000, server, PORT));
        assert!(!tcp_row_matches(
            addr(Ipv4Addr::new(127, 0, 0, 2)),
            50000,
            addr(server),
            PORT,
            client,
            50000,
            server,
            PORT
        ));
    }

    #[cfg(windows)]
    #[test]
    fn peer_process_finds_the_connecting_process() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, _) = listener.accept().unwrap();
        let (client_addr, server_addr) = (client.local_addr().unwrap(), listener.local_addr().unwrap());
        assert_eq!(peer_process(client_addr, server_addr), Some(std::process::id()));
        assert_eq!(peer_process(client_addr, SocketAddr::new(server_addr.ip(), server_addr.port().wrapping_add(1))), None);
    }

    #[test]
    fn oversized_requests_are_rejected() {
        let big = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEAD));
        assert_eq!(read_request(&mut big.as_bytes()).err(), Some(431));
        let body = "POST /api/usage/refresh HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nContent-Length: 5000\r\n\r\n";
        assert_eq!(read_request(&mut body.as_bytes()).err(), Some(413));
    }

    #[test]
    fn query_and_body_are_kept() {
        let r = req("POST /api/media/command?s=m-1&r=7#x HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nContent-Length: 15\r\n\r\n{\"cmd\":\"next\"}\n");
        assert_eq!((r.path.as_str(), r.param("s"), r.param("r"), r.param("x")), ("/api/media/command", Some("m-1"), Some("7"), None));
        assert_eq!(r.json().unwrap()["cmd"], "next");
    }

    #[test]
    fn manual_refresh_is_rate_limited() {
        let shared = store::tests::load_for_test();
        assert!(request_refresh(&shared));
        assert!(!request_refresh(&shared));
    }
}
