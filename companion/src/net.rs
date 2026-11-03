//! Network Pulse widget: download and upload rate of the PC's hardware network adapters (byte counters
//! of Windows, no traffic is read), and a ping to one fixed public resolver when the widget asks for it.
use crate::util::now_ms;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Byte totals of the connected adapters and the name of the busiest one.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Totals {
    pub rx: u64,
    pub tx: u64,
}

/// Bytes per second between two readings; a counter that went back (adapter reset) counts as 0.
pub fn rate(before: Totals, after: Totals, ms: u64) -> (f64, f64) {
    if ms == 0 {
        return (0.0, 0.0);
    }
    let per_s = |a: u64, b: u64| b.saturating_sub(a) as f64 * 1000.0 / ms as f64;
    (per_s(before.rx, after.rx), per_s(before.tx, after.tx))
}

/// Ping targets the widget may choose; nothing else is ever pinged.
pub fn target(name: &str) -> Option<[u8; 4]> {
    match name {
        "cloudflare" => Some([1, 1, 1, 1]),
        "google" => Some([8, 8, 8, 8]),
        "quad9" => Some([9, 9, 9, 9]),
        _ => None,
    }
}

struct State {
    last: Option<(u64, Totals)>,
    rate: (f64, f64),
    ping: Option<(u64, Option<u32>, String)>, // (measured at, round trip ms or lost, target)
    ping_at: u64,
}
static STATE: Mutex<State> = Mutex::new(State { last: None, rate: (0.0, 0.0), ping: None, ping_at: 0 });
static PINGING: AtomicBool = AtomicBool::new(false);

pub fn snapshot(ping_target: &str) -> Value {
    let now = now_ms();
    let (totals, adapter) = read_totals();
    let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(t) = totals {
        match st.last {
            // Readings closer than 400 ms (two widgets polling) keep the last rate instead of a noisy one.
            Some((at, _)) if now.saturating_sub(at) < 400 => {}
            Some((at, before)) => {
                st.rate = rate(before, t, now - at);
                st.last = Some((now, t));
            }
            None => st.last = Some((now, t)),
        }
    }
    if let Some(ip) = target(ping_target) {
        // One ping every 3 s at most, on its own thread: the answer never waits for it.
        if now.saturating_sub(st.ping_at) >= 3000 && !PINGING.swap(true, Ordering::SeqCst) {
            st.ping_at = now;
            let name = ping_target.to_string();
            std::thread::spawn(move || {
                let ms = ping(ip);
                STATE.lock().unwrap_or_else(|e| e.into_inner()).ping = Some((now_ms(), ms, name));
                PINGING.store(false, Ordering::SeqCst);
            });
        }
    }
    let ping = st.ping.as_ref().filter(|(at, _, name)| name == ping_target && at + 15_000 > now);
    json!({
        "schema": "net/1",
        "available": totals.is_some(),
        "adapter": adapter,
        "downBps": st.rate.0.round(),
        "upBps": st.rate.1.round(),
        "pingMs": ping.and_then(|p| p.1),
        "pingLost": ping.is_some_and(|p| p.1.is_none()),
    })
}

#[cfg(windows)]
fn read_totals() -> (Option<Totals>, Option<String>) {
    use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    // SAFETY: GetIfTable2 allocates the table; it is read within its NumEntries and freed once.
    unsafe {
        if GetIfTable2(&mut table).is_err() || table.is_null() {
            return (None, None);
        }
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let mut sum = Totals::default();
        let mut best: Option<(u64, String)> = None;
        for r in rows {
            // Hardware adapters only (bit 0 of the flags): virtual switches and VPNs would count the same bytes twice.
            if r.InterfaceAndOperStatusFlags._bitfield & 1 == 0 || r.OperStatus.0 != 1 {
                continue;
            }
            sum.rx += r.InOctets;
            sum.tx += r.OutOctets;
            let total = r.InOctets + r.OutOctets;
            if best.as_ref().is_none_or(|(b, _)| total > *b) {
                let len = r.Alias.iter().position(|&c| c == 0).unwrap_or(r.Alias.len());
                best = Some((total, String::from_utf16_lossy(&r.Alias[..len])));
            }
        }
        FreeMibTable(table as *const _);
        (Some(sum), best.map(|b| b.1))
    }
}

#[cfg(not(windows))]
fn read_totals() -> (Option<Totals>, Option<String>) {
    (None, None)
}

/// Round trip in ms of one ICMP echo, None when lost or after 1 s.
#[cfg(windows)]
fn ping(ip: [u8; 4]) -> Option<u32> {
    use windows::Win32::NetworkManagement::IpHelper::{IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY};
    let data = *b"icue-edge";
    let mut reply = [0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + 64];
    // SAFETY: the reply buffer is larger than one reply plus the echoed data; the handle is closed after use.
    unsafe {
        let h = IcmpCreateFile().ok()?;
        let n = IcmpSendEcho(h, u32::from_ne_bytes(ip), data.as_ptr().cast(), data.len() as u16, None, reply.as_mut_ptr().cast(), reply.len() as u32, 1000);
        let _ = IcmpCloseHandle(h);
        if n == 0 {
            return None;
        }
        let r = &*(reply.as_ptr() as *const ICMP_ECHO_REPLY);
        (r.Status == 0).then_some(r.RoundTripTime)
    }
}

#[cfg(not(windows))]
fn ping(_: [u8; 4]) -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_is_per_second_and_never_negative() {
        let a = Totals { rx: 1000, tx: 500 };
        assert_eq!(rate(a, Totals { rx: 3000, tx: 1500 }, 500), (4000.0, 2000.0));
        assert_eq!(rate(a, Totals { rx: 10, tx: 10 }, 1000), (0.0, 0.0));
        assert_eq!(rate(a, a, 0), (0.0, 0.0));
    }

    #[test]
    fn only_known_targets_are_pinged() {
        assert_eq!(target("cloudflare"), Some([1, 1, 1, 1]));
        assert_eq!(target("192.168.1.1"), None);
        assert_eq!(target("off"), None);
    }

    /// Reads the real adapters: `cargo test -- --ignored live_net`.
    #[test]
    #[ignore]
    fn live_net() {
        eprintln!("{}", snapshot("off"));
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let s = snapshot("cloudflare");
        std::thread::sleep(std::time::Duration::from_millis(1500));
        eprintln!("{s}\n{}", snapshot("cloudflare"));
        assert_eq!(s["available"], true);
    }
}
