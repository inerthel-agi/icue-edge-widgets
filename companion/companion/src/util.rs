use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SEC: u64 = 1000;
pub const MIN: u64 = 60 * SEC;
pub const HOUR: u64 = 60 * MIN;
pub const DAY: u64 = 24 * HOUR;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

pub fn app_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(home_dir).join("icue-edge-companion")
}

/// Resolves a Windows system executable without consulting PATH or the current directory.
pub fn system_exe(name: &str) -> PathBuf {
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32").join(name)
}

fn is_reparse(path: &Path) -> io::Result<bool> {
    let meta = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(meta.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(meta.file_type().is_symlink())
    }
}

/// Refuses a write directory that is itself a symlink or Windows junction. Only the directory we
/// write into is checked: the folders above it (profile, AppData) belong to the user and may be
/// redirected legitimately.
pub fn ensure_no_links(dir: &Path) -> io::Result<()> {
    if is_reparse(dir)? {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "write directory is a link or junction"));
    }
    Ok(())
}

/// Same-directory atomic replacement through an unpredictable, exclusively-created temporary file.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "write path has no parent"))?;
    fs::create_dir_all(parent)?;
    ensure_no_links(parent)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    for _ in 0..4 {
        let tmp = parent.join(format!(".{name}.{}.tmp", random_hex(8)));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let result = file.write_all(bytes).and_then(|_| file.flush());
        drop(file);
        if let Err(e) = result {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        if let Err(e) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        return Ok(());
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "could not allocate a temporary file"))
}

/// Removes `atomic_write` temporaries left by a crash. Only those older than a minute, so a write
/// in progress in another thread is never touched.
pub fn remove_stale_tmp(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let old = e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|a| a.as_secs() >= 60));
        if name.starts_with('.') && name.ends_with(".tmp") && old {
            let _ = fs::remove_file(e.path());
        }
    }
}

pub fn read_limited(mut reader: impl Read, max: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.by_ref().take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "response exceeds size limit"));
    }
    Ok(bytes)
}

// Howard Hinnant's days_from_civil / civil_from_days (proleptic Gregorian, UTC).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, m, d)
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)` into UTC milliseconds.
pub fn parse_iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut i = 19;
    let mut frac_ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let digits = &s[start..i.min(start + 3)];
        frac_ms = format!("{digits:0<3}").parse().ok()?;
    }
    let offset_min = match b.get(i) {
        Some(b'Z') | Some(b'z') | None => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(i + 1, i + 3)?;
            let om = num(i + 4, i + 6).unwrap_or(0);
            let v = oh * 60 + om;
            if *sign == b'+' { v } else { -v }
        }
        _ => return None,
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let days = days_from_civil(y, mo as u32, d as u32);
    let ms = ((days * 86400 + h * 3600 + mi * 60 + se - offset_min * 60) * 1000) + frac_ms;
    (ms >= 0).then_some(ms as u64)
}

/// Random bytes from the OS CSPRNG, hex encoded.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
        let status = BCryptGenRandom(None, &mut buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
        assert!(status.is_ok(), "BCryptGenRandom failed");
    }
    #[cfg(not(windows))]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).expect("urandom");
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Stable pseudonym for a session id; the salt is per install so ids never leave the machine in clear.
pub fn pseudonym(prefix: &str, salt: &str, raw: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for byte in salt.bytes().chain([0u8]).chain(raw.bytes()) {
        h ^= byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}-{:06x}", h & 0xffffff)
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(windows)]
/// Full image path of a running process (limited query rights, works for other users' processes too).
pub fn exe_path(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let r = unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) };
    let _ = unsafe { CloseHandle(h) };
    r.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

#[cfg(not(windows))]
pub fn exe_path(_: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_parsing() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-09-27T12:32:00.123Z"), Some(1790512320123));
        assert_eq!(parse_iso_ms("2026-09-27T14:32:00+02:00"), Some(1790512320000));
        assert_eq!(parse_iso_ms("2026-09-27T12:32:00.5Z"), Some(1790512320500));
        assert_eq!(parse_iso_ms("garbage"), None);
    }

    #[test]
    fn civil_roundtrip() {
        for z in [-1000, 0, 19000, 20723] {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
    }

    #[test]
    fn pseudonym_is_stable_and_salted() {
        assert_eq!(pseudonym("c", "s1", "abc"), pseudonym("c", "s1", "abc"));
        assert_ne!(pseudonym("c", "s1", "abc"), pseudonym("c", "s2", "abc"));
    }

    #[test]
    fn limited_reads_and_atomic_replacement() {
        assert_eq!(read_limited(&b"abc"[..], 3).unwrap(), b"abc");
        assert_eq!(read_limited(&b"abcd"[..], 3).unwrap_err().kind(), io::ErrorKind::InvalidData);

        let dir = std::env::temp_dir().join(format!("companion-atomic-{}", random_hex(4)));
        let path = dir.join("state.json");
        atomic_write(&path, b"one").unwrap();
        atomic_write(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert!(fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));

        // Crash leftovers go; a temporary still being written (recent) and real files stay.
        let old = dir.join(".state.json.dead.tmp");
        fs::File::create(&old).unwrap().set_modified(SystemTime::now() - std::time::Duration::from_secs(120)).unwrap();
        fs::write(dir.join(".state.json.live.tmp"), b"").unwrap();
        remove_stale_tmp(&dir);
        assert!(!old.exists() && dir.join(".state.json.live.tmp").exists() && path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn atomic_write_rejects_junction_parent() {
        let base = std::env::temp_dir().join(format!("companion-junction-{}", random_hex(4)));
        let real = base.join("real");
        let link = base.join("link");
        fs::create_dir_all(&real).unwrap();
        let status = std::process::Command::new(system_exe("cmd.exe"))
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(atomic_write(&link.join("state.json"), b"secret").unwrap_err().kind(), io::ErrorKind::InvalidInput);
        assert!(!real.join("state.json").exists());
        // A junction higher up (a redirected profile or AppData) is the user's choice and stays allowed.
        atomic_write(&link.join("app").join("state.json"), b"ok").unwrap();
        assert_eq!(fs::read(real.join("app").join("state.json")).unwrap(), b"ok");
        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(base).unwrap();
    }
}
