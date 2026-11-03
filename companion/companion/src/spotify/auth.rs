//! Spotify sign-in: Authorization Code with PKCE (no client secret) and token storage.
//! The refresh token is encrypted with DPAPI for the current Windows user before it touches disk;
//! neither token ever leaves the companion (no window, widget or log sees it).
use super::{lock, publish, State, Status, TOKEN_URL};
use crate::util::{app_dir, atomic_write, constant_time_eq, now_ms, random_hex, read_limited, SEC};
use serde_json::{json, Value};
use std::time::Duration;

pub const REDIRECT_URI: &str = "http://127.0.0.1:47821/api/spotify/callback";
pub const SCOPES: &str = "user-read-playback-state user-read-currently-playing user-modify-playback-state";
const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
/// A sign-in left open in the browser expires after 10 minutes.
const PENDING_TTL_MS: u64 = 10 * 60 * SEC;
const MAX_TOKEN_RESPONSE: usize = 256 * 1024;
const MAX_STORAGE_BYTES: usize = 1024 * 1024;

pub struct Pending {
    pub state: String,
    pub verifier: String,
    pub client_id: String,
    pub created: u64,
}

pub struct Tokens {
    pub access: String,
    pub expires_at: u64,
    pub refresh: String,
}

pub fn valid_client_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

// ---------- encodings ----------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Unpadded base64url.
pub fn b64url(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() * 4 / 3 + 3);
    for chunk in data.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (*b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

pub fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

pub fn percent(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

pub fn percent_decode(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                        continue;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(windows)]
pub fn sha256(data: &[u8]) -> [u8; 32] {
    use windows::Win32::Security::Cryptography::{BCryptHash, BCRYPT_SHA256_ALG_HANDLE};
    let mut out = [0u8; 32];
    let status = unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, data, &mut out) };
    assert!(status.is_ok(), "BCryptHash failed");
    out
}

#[cfg(windows)]
fn protect(data: &[u8], encrypt: bool) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        if encrypt {
            CryptProtectData(&input, windows::core::w!("iCUE Edge Companion Spotify"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok.is_err() || output.pbData.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(Some(HLOCAL(output.pbData as _))) };
    Some(bytes)
}

// ---------- storage: %LOCALAPPDATA%\icue-edge-companion\spotify.json ----------

fn store_path() -> std::path::PathBuf {
    app_dir().join("spotify.json")
}

pub fn save(client_id: &str, refresh: &str) {
    #[cfg(windows)]
    let Some(sealed) = protect(refresh.as_bytes(), true) else { return };
    #[cfg(not(windows))]
    let sealed = refresh.as_bytes().to_vec();
    let body = json!({ "client_id": client_id, "refresh_token_dpapi": b64url(&sealed) });
    let _ = atomic_write(&store_path(), body.to_string().as_bytes());
}

/// (client id, refresh token) from disk, if a previous sign-in exists and still decrypts.
pub fn load() -> Option<(String, Option<String>)> {
    let bytes = read_limited(std::fs::File::open(store_path()).ok()?, MAX_STORAGE_BYTES).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let client_id = v["client_id"].as_str().filter(|c| valid_client_id(c))?.to_string();
    let sealed = v["refresh_token_dpapi"].as_str().and_then(b64url_decode);
    #[cfg(windows)]
    let refresh = sealed.and_then(|s| protect(&s, false)).and_then(|b| String::from_utf8(b).ok());
    #[cfg(not(windows))]
    let refresh = sealed.and_then(|b| String::from_utf8(b).ok());
    Some((client_id, refresh))
}

/// File and state are cleared under the state lock only: a refresh in flight re-saves under that
/// same lock and only if the tokens are still its own, so it cannot bring the file back, and
/// Disconnect never waits for a Spotify request.
fn disconnect_path(path: &std::path::Path) {
    let mut st = lock();
    match std::fs::remove_file(path) {
        Ok(()) => {
            *st = State { version: st.version, ..State::default() };
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            *st = State { version: st.version, ..State::default() };
        }
        Err(_) => {
            st.status = Status::Error;
            st.message = Some("The encrypted Spotify token could not be deleted.".into());
        }
    }
    publish(&mut st);
}

pub fn disconnect() {
    disconnect_path(&store_path());
}

// ---------- flow ----------

/// Starts a sign-in and returns the Spotify URL to open in the browser.
pub fn begin(client_id: &str) -> Result<String, &'static str> {
    if !valid_client_id(client_id) {
        return Err("A Client ID is 32 letters and digits.");
    }
    let verifier = random_hex(48);
    let state = random_hex(16);
    #[cfg(windows)]
    let challenge = b64url(&sha256(verifier.as_bytes()));
    #[cfg(not(windows))]
    let challenge = String::new();
    let url = format!(
        "{AUTH_URL}?client_id={}&response_type=code&redirect_uri={}&code_challenge_method=S256&code_challenge={}&scope={}&state={}",
        percent(client_id),
        percent(REDIRECT_URI),
        challenge,
        percent(SCOPES),
        state
    );
    let mut st = lock();
    st.pending = Some(Pending { state, verifier, client_id: client_id.to_string(), created: now_ms() });
    st.status = Status::Connecting;
    st.message = None;
    publish(&mut st);
    Ok(url)
}

pub fn cancel() {
    let mut st = lock();
    if st.pending.take().is_some() {
        st.status = if st.tokens.is_some() { Status::Connected } else { Status::NotConfigured };
        publish(&mut st);
    }
}

fn token_request(form: &[(&str, &str)]) -> Result<Value, (u16, String)> {
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(10)).build();
    let res = agent.post(TOKEN_URL).set("User-Agent", "icue-edge-companion").send_form(form);
    match res {
        Ok(r) => read_limited(r.into_reader(), MAX_TOKEN_RESPONSE)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or((0, "Unreadable answer from Spotify.".into())),
        Err(ureq::Error::Status(code, r)) => {
            let v: Value = read_limited(r.into_reader(), MAX_TOKEN_RESPONSE).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
            Err((code, v["error"].as_str().unwrap_or("error").to_string()))
        }
        Err(_) => Err((0, "Spotify is unreachable.".into())),
    }
}

fn tokens_from(v: &Value, previous_refresh: Option<&str>) -> Option<Tokens> {
    let access = v["access_token"].as_str()?.to_string();
    let refresh = v["refresh_token"].as_str().or(previous_refresh)?.to_string();
    let expires_in = v["expires_in"].as_u64().unwrap_or(3600);
    Some(Tokens { access, refresh, expires_at: now_ms() + expires_in.saturating_sub(60) * SEC })
}

/// Browser redirect target. Only a pending sign-in with the same single-use state is accepted.
pub fn callback(query: &str) -> (u16, &'static str) {
    let param = |k: &str| query.split('&').filter_map(|kv| kv.split_once('=')).find(|(a, _)| *a == k).map(|(_, v)| percent_decode(v));
    let pending = {
        let mut st = lock();
        let fresh = st.pending.as_ref().is_some_and(|p| now_ms() < p.created + PENDING_TTL_MS);
        let matches = fresh && param("state").is_some_and(|s| constant_time_eq(&s, &st.pending.as_ref().unwrap().state));
        if !matches {
            return (400, "This sign-in link is not valid any more. Start again from iCUE Edge Companion.");
        }
        st.pending.take().unwrap()
    };
    let Some(code) = param("code") else {
        let mut st = lock();
        st.status = if st.tokens.is_some() { Status::Connected } else { Status::NotConfigured };
        st.message = Some("Access was not granted in the browser.".into());
        publish(&mut st);
        return (200, "Access was not granted. You can close this tab.");
    };
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", pending.client_id.as_str()),
        ("code_verifier", pending.verifier.as_str()),
    ];
    match token_request(&form) {
        Ok(v) => match tokens_from(&v, None) {
            Some(tokens) => {
                let mut st = lock();
                save(&pending.client_id, &tokens.refresh);
                st.client_id = Some(pending.client_id);
                st.scopes = v["scope"].as_str().unwrap_or(SCOPES).split(' ').map(String::from).collect();
                st.tokens = Some(tokens);
                st.status = Status::Connected;
                st.message = None;
                st.poke = true;
                publish(&mut st);
                (200, "Spotify is connected to iCUE Edge Companion. You can close this tab.")
            }
            None => fail("Spotify did not return a usable token."),
        },
        Err((_, error)) if error == "invalid_client" => fail("Spotify refused the Client ID or the redirect URI. Check both in your Spotify app."),
        Err((_, error)) => fail(if error.contains("unreachable") { "Spotify is unreachable." } else { "Spotify refused the sign-in." }),
    }
}

fn fail(message: &'static str) -> (u16, &'static str) {
    let mut st = lock();
    st.status = Status::Error;
    st.message = Some(message.into());
    publish(&mut st);
    (200, message)
}

/// One refresh at a time: the poller and a widget command must not spend the same refresh token twice.
static REFRESH: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Current access token, refreshed when it is about to expire. Err carries the new status.
pub fn access_token() -> Result<String, Status> {
    let current = || {
        let st = lock();
        match (&st.tokens, &st.client_id) {
            (Some(t), _) if now_ms() < t.expires_at => Err(Ok(t.access.clone())),
            (Some(t), Some(c)) => Ok((c.clone(), t.refresh.clone())),
            _ => Err(Err(Status::NotConfigured)),
        }
    };
    if let Err(done) = current() {
        return done;
    }
    let _one = REFRESH.lock().unwrap_or_else(|e| e.into_inner());
    // Another thread may have refreshed while this one waited.
    match current() {
        Err(done) => done,
        Ok((client_id, refresh)) => refresh_with(&client_id, &refresh),
    }
}

fn refresh_with(client_id: &str, refresh: &str) -> Result<String, Status> {
    match token_request(&[("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", client_id)]) {
        Ok(v) => {
            let tokens = tokens_from(&v, Some(refresh)).ok_or(Status::Error)?;
            let access = tokens.access.clone();
            let mut st = lock();
            // A Disconnect or a new sign-in during the request wins: nothing is stored again.
            let still_ours = st.client_id.as_deref() == Some(client_id) && st.tokens.as_ref().is_some_and(|t| t.refresh == refresh);
            if !still_ours {
                return Err(Status::NotConfigured);
            }
            if tokens.refresh != refresh {
                save(client_id, &tokens.refresh);
            }
            st.tokens = Some(tokens);
            Ok(access)
        }
        // Revoked or expired grant: a new sign-in is needed. Network errors keep the old state.
        Err((400, e)) if e == "invalid_grant" => Err(Status::NeedsLogin),
        Err((400 | 401, _)) => Err(Status::NeedsLogin),
        Err(_) => Err(Status::Error),
    }
}

/// Force the next call to refresh (after a 401 from the Web API).
pub fn expire_access() {
    if let Some(t) = lock().tokens.as_mut() {
        t.expires_at = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_and_percent() {
        assert_eq!(b64url(b""), "");
        assert_eq!(b64url(b"f"), "Zg");
        assert_eq!(b64url(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(b64url_decode("Zm9vYmFy").unwrap(), b"foobar");
        assert_eq!(b64url_decode("-_8").unwrap(), vec![0xfb, 0xff]);
        assert!(b64url_decode("not base64!").is_none());
        assert_eq!(percent("a b/c"), "a%20b%2Fc");
        assert_eq!(percent_decode("a%20b%2Fc+d"), "a b/c d");
    }

    #[cfg(windows)]
    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        // RFC 7636 appendix B.
        let challenge = b64url(&sha256(b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip() {
        let sealed = protect(b"refresh-token", true).unwrap();
        assert_ne!(sealed, b"refresh-token");
        assert_eq!(protect(&sealed, false).unwrap(), b"refresh-token");
    }

    #[test]
    fn client_id_rules() {
        assert!(valid_client_id("0f3c9a1d7e5b4c2a8d6e0b1f9a7c3f2a"));
        assert!(!valid_client_id("0f3c9a1d7e5b4c2a8d6e0b1f9a7c3f2"));
        assert!(!valid_client_id("0f3c9a1d7e5b4c2a8d6e0b1f9a7c3f2!"));
    }

    #[test]
    fn stored_token_input_is_bounded() {
        assert!(read_limited(&vec![b' '; MAX_STORAGE_BYTES + 1][..], MAX_STORAGE_BYTES).is_err());
    }

    #[test]
    fn disconnect_deletes_storage_and_clears_tokens_together() {
        let path = std::env::temp_dir().join(format!("spotify-token-{}.json", random_hex(4)));
        std::fs::write(&path, b"encrypted").unwrap();
        {
            let mut st = lock();
            st.client_id = Some("0f3c9a1d7e5b4c2a8d6e0b1f9a7c3f2a".into());
            st.tokens = Some(Tokens { access: "access".into(), refresh: "refresh".into(), expires_at: 0 });
        }
        // A refresh holding its lock (a slow Spotify request) must not delay Disconnect.
        let _refresh = REFRESH.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = std::sync::mpsc::channel();
        let p = path.clone();
        std::thread::spawn(move || {
            disconnect_path(&p);
            let _ = tx.send(());
        });
        rx.recv_timeout(Duration::from_secs(2)).expect("Disconnect waited for the refresh lock");
        let st = lock();
        assert!(!path.exists() && st.tokens.is_none() && st.client_id.is_none());
    }
}
