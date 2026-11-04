//! Rig Monitor's continuous history: CPU load, GPU load, RAM and VRAM in use, sampled every 1.5 s for the
//! last 3 minutes. It starts with the first request and keeps running, so the widget's graphs stay unbroken
//! while iCUE hides or reloads it. Temperatures and power come only from iCUE's sensors, in the widget.
use crate::util::now_ms;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

pub const STEP_MS: u64 = 1500;
pub const LEN: usize = 120;
const GB: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(Default)]
pub struct Hist {
    pub at: u64,
    pub cpu: VecDeque<f32>,
    pub gpu: VecDeque<f32>,
    pub ram: VecDeque<f32>,
    pub vram: VecDeque<f32>,
    pub ram_total: f64,
    pub vram_total: f64,
    pub commit: f64,
}

static HIST: Mutex<Option<Hist>> = Mutex::new(None);
static STARTED: AtomicBool = AtomicBool::new(false);

fn lock() -> MutexGuard<'static, Option<Hist>> {
    HIST.lock().unwrap_or_else(|e| e.into_inner())
}

/// Adds one reading of each series (NaN when not read), keeping the last LEN.
pub fn push(h: &mut Hist, at: u64, cpu: Option<f64>, gpu: Option<f64>, ram: Option<f64>, vram: Option<f64>) {
    for (q, v) in [(&mut h.cpu, cpu), (&mut h.gpu, gpu), (&mut h.ram, ram), (&mut h.vram, vram)] {
        q.push_back(v.map_or(f32::NAN, |v| v as f32));
        while q.len() > LEN {
            q.pop_front();
        }
    }
    h.at = at;
}

/// Starts the sampler once; later calls do nothing.
pub fn start() {
    if !STARTED.swap(true, Ordering::SeqCst) {
        std::thread::spawn(run);
    }
}

pub fn snapshot() -> Value {
    start();
    let st = lock();
    let Some(h) = st.as_ref() else { return json!({ "schema": "sys/1", "available": false }) };
    let arr = |q: &VecDeque<f32>| q.iter().map(|v| if v.is_finite() { json!((*v as f64 * 10.0).round() / 10.0) } else { Value::Null }).collect::<Vec<_>>();
    json!({ "schema": "sys/1", "available": true, "stepMs": STEP_MS, "at": h.at,
        "cpu": arr(&h.cpu), "gpu": arr(&h.gpu), "ramGB": arr(&h.ram), "vramGB": arr(&h.vram),
        "ramTotalGB": h.ram_total, "vramTotalGB": h.vram_total, "commitGB": h.commit })
}

#[cfg(windows)]
fn run() {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Performance::*;
    unsafe {
        let mut q = PDH_HQUERY::default();
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut q) != 0 {
            return;
        }
        let (mut cpu, mut gpu) = (PDH_HCOUNTER::default(), PDH_HCOUNTER::default());
        let cpu_ok = PdhAddEnglishCounterW(q, w!(r"\Processor(_Total)\% Processor Time"), 0, &mut cpu) == 0;
        let gpu_ok = PdhAddEnglishCounterW(q, w!(r"\GPU Engine(*engtype_3D)\Utilization Percentage"), 0, &mut gpu) == 0;
        let _ = PdhCollectQueryData(q);
        loop {
            std::thread::sleep(Duration::from_millis(STEP_MS));
            let _ = PdhCollectQueryData(q);
            let c = if cpu_ok { single(cpu) } else { None };
            // ponytail: sums every process's 3D engine on every adapter; per-adapter sums if an iGPU skews it.
            let g = if gpu_ok { array(gpu).map(|v| v.iter().sum::<f64>().min(100.0)) } else { None };
            let mem = crate::util::memory();
            let vram = crate::util::vram();
            let mut st = lock();
            let h = st.get_or_insert_with(Hist::default);
            if let Some((_, total, commit, _)) = mem {
                h.ram_total = (total as f64 / GB * 10.0).round() / 10.0;
                h.commit = (commit as f64 / GB * 10.0).round() / 10.0;
            }
            if let Some((_, total)) = vram {
                h.vram_total = (total as f64 / GB * 10.0).round() / 10.0;
            }
            push(h, now_ms(), c.map(|v| v.clamp(0.0, 100.0)), g, mem.map(|m| m.0 as f64 / GB), vram.map(|v| v.0 as f64 / GB));
        }
    }

    unsafe fn single(c: PDH_HCOUNTER) -> Option<f64> {
        let mut v = PDH_FMT_COUNTERVALUE::default();
        (PdhGetFormattedCounterValue(c, PDH_FMT_DOUBLE, None, &mut v) == 0).then(|| v.Anonymous.doubleValue)
    }

    unsafe fn array(c: PDH_HCOUNTER) -> Option<Vec<f64>> {
        let (mut size, mut n) = (0u32, 0u32);
        let _ = PdhGetFormattedCounterArrayW(c, PDH_FMT_DOUBLE, &mut size, &mut n, None);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u64; size as usize / 8 + 1];
        if PdhGetFormattedCounterArrayW(c, PDH_FMT_DOUBLE, &mut size, &mut n, Some(buf.as_mut_ptr().cast())) != 0 {
            return None;
        }
        let items = std::slice::from_raw_parts(buf.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W, n as usize);
        Some(items.iter().map(|it| it.FmtValue.Anonymous.doubleValue).filter(|v| v.is_finite()).collect())
    }
}

#[cfg(not(windows))]
fn run() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_last_three_minutes_and_marks_missing_readings() {
        let mut h = Hist::default();
        for i in 0..LEN + 5 {
            push(&mut h, i as u64, Some(i as f64), None, Some(1.0), Some(2.0));
        }
        assert_eq!(h.cpu.len(), LEN);
        assert_eq!(h.cpu[0], 5.0);
        assert!(h.gpu.iter().all(|v| v.is_nan()));
        assert_eq!(h.at, (LEN + 4) as u64);
    }
}
