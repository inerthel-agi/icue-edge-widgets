//! Community widgets: the list the repository's daily workflow builds from GitHub (`community/index.json`,
//! made by `scripts/community-index.py`) and installing one of them. Nothing in that list is reviewed. What
//! the companion guarantees: it installs exactly what the list pinned (a folder from one commit, every file
//! checked against its git blob id; a release package checked against its SHA-256), it only talks to GitHub,
//! and iCUE still asks the user to confirm.

use crate::util::{app_dir, atomic_write, ensure_no_links, now_ms, read_limited};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

const INDEX_URL: &str = "https://raw.githubusercontent.com/inerthel-agi/icue-edge-widgets/main/community/index.json";
const FRESH_MS: u64 = 6 * 3_600_000;
const RETRY_MS: u64 = 10 * 60_000;
const MAX_INDEX: usize = 8 * 1024 * 1024;
const MAX_WIDGET: usize = 32 * 1024 * 1024;
const MAX_FILES: usize = 300;

static INDEX: Mutex<(u64, Option<Value>)> = Mutex::new((0, None));

/// Only GitHub's own hosts, before and after redirects (a release asset redirects to its storage host).
fn allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    matches!(host, "raw.githubusercontent.com" | "github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com")
}

fn download(url: &str, max: usize) -> Result<Vec<u8>, String> {
    if !allowed(url) {
        return Err("not a GitHub address".into());
    }
    let r = ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build().get(url).set("User-Agent", "icue-edge-companion").call().map_err(|e| e.to_string())?;
    if !allowed(r.get_url()) {
        return Err("redirected away from GitHub".into());
    }
    read_limited(r.into_reader(), max).map_err(|e| e.to_string())
}

/// `community/index.json` of a checkout next to the companion (a developer build), if any.
fn local_index() -> Option<PathBuf> {
    Some(crate::util::checkout_root()?.join("community").join("index.json")).filter(|p| p.is_file())
}

fn valid(v: &Value) -> bool {
    v["version"] == 1 && v["widgets"].is_array()
}

/// The list: a local checkout first; otherwise the repository's copy, read at most every 6 hours and kept on
/// disk for when GitHub cannot be reached.
pub fn index() -> Option<Value> {
    if let Some(p) = local_index() {
        let file = std::fs::File::open(p).ok()?;
        return crate::util::read_limited(file, MAX_INDEX).ok().and_then(|b| serde_json::from_slice(&b).ok()).filter(valid);
    }
    let disk = app_dir().join("community-index.json");
    let mut g = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    // Starts at 0, so the first call downloads; after a failure the retry time holds even with no list.
    if g.0 + FRESH_MS < now_ms() {
        match download(INDEX_URL, MAX_INDEX).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok().filter(valid).map(|v| (b, v))) {
            Some((bytes, v)) => {
                let _ = std::fs::create_dir_all(app_dir()).and_then(|_| atomic_write(&disk, &bytes));
                *g = (now_ms(), Some(v));
            }
            None => {
                if g.1.is_none() {
                    g.1 = std::fs::read(&disk).ok().and_then(|b| serde_json::from_slice(&b).ok()).filter(valid);
                }
                g.0 = now_ms() - FRESH_MS + RETRY_MS;
            }
        }
    }
    g.1.clone()
}

fn find(key: &str) -> Result<Value, String> {
    let ix = index().ok_or("The community list could not be read.")?;
    ix["widgets"].as_array().and_then(|a| a.iter().find(|w| w["key"] == key)).cloned().ok_or_else(|| "This widget is no longer in the list.".into())
}

fn repo_ok(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |s: Option<&str>| s.is_some_and(|s| !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && s != "." && s != "..");
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn hex40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A path inside the widget folder: relative, no `..`, no drive or backslash.
fn safe_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= 240 && !p.starts_with('/') && !p.contains(['\\', ':', '\0'])
        && p.split('/').all(|s| !s.is_empty() && s != "." && s != "..")
}

fn encode_path(p: &str) -> String {
    p.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Git's id for a file: SHA-1 of "blob <size>\0" followed by the content.
fn git_blob_id(data: &[u8]) -> Option<String> {
    let mut buf = format!("blob {}\0", data.len()).into_bytes();
    buf.extend_from_slice(data);
    crate::util::sha1(&buf).map(|h| hex(&h))
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

/// A plain (stored, uncompressed) zip: what an .icuewidget is, with the files at its root.
fn stored_zip(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data) in entries {
        let (crc, size, offset) = (crc32(data), data.len() as u32, out.len() as u32);
        let head = |sig: u32, central: bool| {
            let mut h = sig.to_le_bytes().to_vec();
            if central {
                h.extend(20u16.to_le_bytes());
            }
            h.extend(20u16.to_le_bytes()); // version needed
            h.extend(0x0800u16.to_le_bytes()); // UTF-8 names
            h.extend(0u16.to_le_bytes()); // stored
            h.extend(0u16.to_le_bytes()); // time
            h.extend(0x21u16.to_le_bytes()); // 1980-01-01
            h.extend(crc.to_le_bytes());
            h.extend(size.to_le_bytes());
            h.extend(size.to_le_bytes());
            h.extend((name.len() as u16).to_le_bytes());
            h.extend(0u16.to_le_bytes()); // extra
            h
        };
        out.extend(head(0x0403_4b50, false));
        out.extend(name.as_bytes());
        out.extend(data);
        central.extend(head(0x0201_4b50, true));
        central.extend([0u8; 6]); // comment length, disk, internal attributes
        central.extend(0u32.to_le_bytes()); // external attributes
        central.extend(offset.to_le_bytes());
        central.extend(name.as_bytes());
    }
    let cd_offset = out.len() as u32;
    let n = entries.len() as u16;
    out.extend(&central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0u8; 4]);
    out.extend(n.to_le_bytes());
    out.extend(n.to_le_bytes());
    out.extend((central.len() as u32).to_le_bytes());
    out.extend(cd_offset.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    out
}

/// One community widget as an .icuewidget file for iCUE, checked against the list.
pub fn package(key: &str) -> Result<PathBuf, String> {
    let w = find(key)?;
    let src = &w["source"];
    let bytes = match src["type"].as_str() {
        Some("release") => {
            let b = download(src["url"].as_str().ok_or("no package address")?, MAX_WIDGET)?;
            let sum = crate::util::sha256(&b).map(|h| hex(&h)).ok_or("cannot check the package")?;
            if Some(sum.as_str()) != src["sha256"].as_str() || !b.starts_with(b"PK\x03\x04") {
                return Err("The package does not match the list: not installed.".into());
            }
            b
        }
        Some("folder") => {
            if src["outside"] == true {
                return Err("This widget needs files outside its folder: install it from its repository.".into());
            }
            let (repo, commit) = (w["repo"].as_str().unwrap_or(""), src["commit"].as_str().unwrap_or(""));
            let folder = src["folder"].as_str().unwrap_or("");
            let files = src["files"].as_array().ok_or("no files")?;
            if !repo_ok(repo) || !hex40(commit) || !(folder.is_empty() || safe_path(folder)) || files.is_empty() || files.len() > MAX_FILES {
                return Err("This list entry is not valid.".into());
            }
            let (mut entries, mut total) = (Vec::new(), 0usize);
            for f in files {
                let (Some(path), Some(blob)) = (f[0].as_str(), f[2].as_str()) else { return Err("This list entry is not valid.".into()) };
                if !safe_path(path) || !hex40(blob) {
                    return Err("This list entry is not valid.".into());
                }
                let full = if folder.is_empty() { path.to_string() } else { format!("{folder}/{path}") };
                let data = download(&format!("https://raw.githubusercontent.com/{repo}/{commit}/{}", encode_path(&full)), MAX_WIDGET - total)?;
                total += data.len();
                if git_blob_id(&data).as_deref() != Some(blob) {
                    return Err(format!("{path} does not match the list: not installed."));
                }
                entries.push((path.to_string(), data));
            }
            stored_zip(&entries)
        }
        _ => return Err("Unknown widget source.".into()),
    };
    let dir = crate::util::handoff_dir("community");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    ensure_no_links(&dir).map_err(|e| e.to_string())?;
    let stem: String = w["id"].as_str().unwrap_or("widget").chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '-' }).take(80).collect();
    let path = dir.join(format!("{stem}.icuewidget"));
    atomic_write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Ids and lower-case names of every widget installed in iCUE (its own manifests, `html_widgets` up to 4 levels).
fn installed_widgets() -> (std::collections::HashSet<String>, std::collections::HashSet<String>) {
    fn walk(dir: &std::path::Path, depth: u8, ids: &mut std::collections::HashSet<String>, names: &mut std::collections::HashSet<String>) {
        let m = dir.join("manifest.json");
        if m.is_file() {
            if let Some(v) = std::fs::read(&m).ok().and_then(|b| serde_json::from_slice::<Value>(b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&b)).ok()) {
                if let Some(id) = v["id"].as_str() { ids.insert(id.to_string()); }
                // Our own widgets share names with Marketplace ones (Now Playing): only others count for names.
                if let (Some(n), false) = (v["name"].as_str(), v["id"].as_str().is_some_and(|i| i.starts_with("com.stealthsrc."))) { names.insert(n.trim().to_lowercase()); }
            }
            return;
        }
        if depth == 0 { return; }
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) { walk(&e.path(), depth - 1, ids, names); }
        }
    }
    let (mut ids, mut names) = Default::default();
    if let Some(root) = crate::widgets::installed_dir("com.x").and_then(|d| d.parent().and_then(|p| p.parent()).map(|p| p.to_path_buf())) {
        walk(&root, 4, &mut ids, &mut names);
    }
    (ids, names)
}

/// The page's view of the list: no file lists, plus whether each widget is installed in iCUE.
pub fn page() -> Value {
    let Some(ix) = index() else { return json!({ "error": "The community list could not be read. Check the connection; it is retried every 10 minutes." }) };
    // One card per widget id, even with an older list that still has copies.
    let mut seen = std::collections::HashSet::new();
    let (ids, names) = installed_widgets();
    let widgets: Vec<Value> = ix["widgets"].as_array().map(|a| a.iter().filter(|w| seen.insert(w["id"].to_string())).map(|w| {
        let src = &w["source"];
        let icon = match (w["icon"].as_str(), w["repo"].as_str(), src["commit"].as_str()) {
            (Some(i), Some(r), Some(c)) if safe_path(i) && repo_ok(r) && hex40(c) => Value::String(format!("https://raw.githubusercontent.com/{r}/{c}/{}", encode_path(i))),
            _ => Value::Null,
        };
        let installed = w["id"].as_str().is_some_and(|id| ids.contains(id));
        json!({
            "key": w["key"], "repo": w["repo"], "owner": w["owner"], "ownerId": w["ownerId"], "stars": w["stars"], "pushed": w["pushed"],
            "license": w["license"], "id": w["id"], "name": w["name"], "author": w["author"], "version": w["version"],
            "description": w["description"], "devices": w["devices"], "plugins": w["plugins"], "interactive": w["interactive"], "icon": icon,
            "kind": src["type"], "tag": src["tag"], "asset": src["asset"], "folder": src["folder"], "size": src["size"],
            "installable": src["outside"] != true, "installed": installed,
        })
    }).collect()).unwrap_or_default();
    // The Elgato Marketplace's iCUE widgets: shown with a link to their page, never downloaded.
    let market: Vec<Value> = ix["marketplace"].as_array().map(|a| a.iter().filter(|m| m["slug"].as_str().is_some_and(market_slug_ok)).map(|m| json!({
        "id": m["id"], "name": m["name"], "maker": m["maker"], "free": m["free"] == true, "price": m["price"], "devices": m["devices"],
        "type": m["type"], "interactive": m["interactive"], "description": m["description"], "published": m["published"],
        // Matched by name: the Marketplace does not publish the widget's iCUE id.
        "installed": m["name"].as_str().is_some_and(|n| names.contains(&n.trim().to_lowercase())),
        "image": m["image"].as_str().filter(|u| u.starts_with("https://mp-cdn.elgato.com/")),
    })).collect()).unwrap_or_default();
    json!({ "generated": ix["generated"], "repos": ix["repos"], "widgets": widgets, "marketplace": market })
}

fn market_slug_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The Marketplace page of a listed widget (its slug comes from the list, not from the page).
pub fn marketplace_url(id: &str) -> Result<String, String> {
    let ix = index().ok_or("The community list could not be read.")?;
    let slug = ix["marketplace"].as_array().and_then(|a| a.iter().find(|m| m["id"] == id)).and_then(|m| m["slug"].as_str()).filter(|s| market_slug_ok(s))
        .ok_or("This widget is no longer in the list.")?;
    Ok(format!("https://marketplace.elgato.com/product/{slug}"))
}

/// The GitHub page of a listed widget (its folder at the listed commit, or its release).
pub fn source_url(key: &str) -> Result<String, String> {
    let w = find(key)?;
    let repo = w["repo"].as_str().filter(|r| repo_ok(r)).ok_or("This list entry is not valid.")?;
    let src = &w["source"];
    Ok(match (src["type"].as_str(), src["commit"].as_str(), src["folder"].as_str(), src["tag"].as_str()) {
        (Some("folder"), Some(c), Some(f), _) if hex40(c) && !f.is_empty() && safe_path(f) => format!("https://github.com/{repo}/tree/{c}/{}", encode_path(f)),
        (Some("folder"), Some(c), _, _) if hex40(c) => format!("https://github.com/{repo}/tree/{c}"),
        (Some("release"), _, _, Some(t)) => format!("https://github.com/{repo}/releases/tag/{}", encode_path(t)),
        _ => format!("https://github.com/{repo}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksums_match_known_values() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        // `git hash-object` of "hello\n"
        assert_eq!(git_blob_id(b"hello\n").as_deref(), Some("ce013625030ba8dba906f756967f9e9ca394464a"));
    }

    #[test]
    fn stored_zip_has_one_entry_per_file_and_an_end_record() {
        let z = stored_zip(&[("index.html".into(), b"<h1>x</h1>".to_vec()), ("resources/icon.png".into(), vec![1, 2, 3])]);
        assert!(z.starts_with(&0x0403_4b50u32.to_le_bytes()));
        let end = z.len() - 22;
        assert_eq!(&z[end..end + 4], &0x0605_4b50u32.to_le_bytes());
        assert_eq!(u16::from_le_bytes([z[end + 10], z[end + 11]]), 2);
        // The first local header carries the CRC of its data.
        assert_eq!(u32::from_le_bytes([z[14], z[15], z[16], z[17]]), crc32(b"<h1>x</h1>"));
        // The central directory is where the end record says, and its entries are 46 bytes plus the name.
        let at = |i: usize| u32::from_le_bytes([z[i], z[i + 1], z[i + 2], z[i + 3]]) as usize;
        let cd = at(end + 16);
        assert_eq!(at(cd), 0x0201_4b50);
        assert_eq!(&z[cd + 46..cd + 46 + 10], b"index.html");
        let second = cd + 46 + 10;
        assert_eq!(at(second), 0x0201_4b50);
        assert_eq!(at(second + 42), 30 + 10 + 10); // offset of the second local header
        assert_eq!(at(end + 12), z.len() - 22 - cd); // central directory size
    }

    #[test]
    fn paths_and_hosts_are_checked() {
        assert!(safe_path("index.html") && safe_path("res/a b.png"));
        for bad in ["", "../x", "a/../b", "/abs", "C:/x", "a\\b", "a//b", "./a"] {
            assert!(!safe_path(bad), "{bad}");
        }
        assert!(repo_ok("QuadraKev/qk-icue-widgets") && !repo_ok("a/b/c") && !repo_ok("../x") && !repo_ok("a"));
        assert!(allowed("https://raw.githubusercontent.com/a/b/c") && allowed("https://github.com/a/b/releases/download/x/y.icuewidget"));
        assert!(!allowed("http://github.com/a") && !allowed("https://github.com.evil.example/a") && !allowed("https://example.com/"));
        assert_eq!(encode_path("res/a b.png"), "res/a%20b.png");
        assert!(market_slug_ok("courtside-97d50235-7fa8-4399-81b0-3d9388472def"));
        assert!(!market_slug_ok("../x") && !market_slug_ok("a/b") && !market_slug_ok("A") && !market_slug_ok(""));
    }
}
