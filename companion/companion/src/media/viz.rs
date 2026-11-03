//! Audio spectrum for the Now Playing visualiser: loopback capture of the default output (what you
//! hear), a 1024-point FFT and 24 log-spaced bands of 0..=255. The capture runs only while a widget
//! watches the /api/media/viz stream, and nothing but these 24 numbers ever leaves the capture code.
use crate::util::now_ms;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

pub const BANDS: usize = 24;
const N: usize = 1024;
/// The stream counts as watched for this long after its last read.
const WATCH_MS: u64 = 2_000;

static LEVELS: Mutex<[u8; BANDS]> = Mutex::new([0; BANDS]);
static VERSION: AtomicU64 = AtomicU64::new(0);
static WATCHED_AT: AtomicU64 = AtomicU64::new(0);

pub fn mark_watched() {
    WATCHED_AT.store(now_ms(), Ordering::Relaxed);
}

#[cfg(windows)]
fn watched() -> bool {
    now_ms() < WATCHED_AT.load(Ordering::Relaxed) + WATCH_MS
}

/// Next spectrum for a stream that last saw `seen`; waits briefly, None when nothing changed.
pub fn next(seen: &mut u64) -> Option<String> {
    mark_watched();
    for _ in 0..10 {
        let v = VERSION.load(Ordering::Acquire);
        if v != *seen {
            *seen = v;
            let bands = *LEVELS.lock().unwrap_or_else(|e| e.into_inner());
            return Some(format!("{{\"b\":{:?}}}", bands));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

#[cfg(windows)]
fn publish(levels: [u8; BANDS]) {
    let mut cur = LEVELS.lock().unwrap_or_else(|e| e.into_inner());
    if *cur != levels {
        *cur = levels;
        VERSION.fetch_add(1, Ordering::Release);
    }
}

/// In-place radix-2 FFT (`re.len()` a power of two).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * cr - im[b] * ci, re[b] * ci + im[b] * cr);
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
        len <<= 1;
    }
}

/// Band levels 0..=1 of N mono samples: Hann window, FFT, the loudest bin of each band, on a -55..-12 dB scale.
fn analyze(samples: &[f32], rate: f32) -> [f32; BANDS] {
    let hann = |i: usize| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (N - 1) as f32).cos();
    let mut re: Vec<f32> = samples.iter().enumerate().map(|(i, s)| s * hann(i)).collect();
    let mut im = vec![0.0f32; N];
    fft(&mut re, &mut im);
    let bin = rate / N as f32;
    let (lo, hi) = (50.0f32, (rate / 2.0 * 0.9).min(16_000.0));
    let mut out = [0.0f32; BANDS];
    for (b, o) in out.iter_mut().enumerate() {
        let edge = |k: usize| lo * (hi / lo).powf(k as f32 / BANDS as f32);
        let first = ((edge(b) / bin).ceil() as usize).clamp(1, N / 2 - 1);
        let last = ((edge(b + 1) / bin).ceil() as usize).clamp(first + 1, N / 2);
        let peak = (first..last).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt() / (N as f32 / 4.0)).fold(0.0f32, f32::max);
        // Music rarely peaks above -25 dB in one bin: -55 dB is the floor and -12 dB the top of the bars.
        *o = ((20.0 * peak.max(1e-6).log10() + 55.0) / 43.0).clamp(0.0, 1.0);
    }
    out
}

/// Rises at once, falls gently: bars that jump up and settle read as music, not as noise.
fn smooth(prev: &mut [f32; BANDS], fresh: [f32; BANDS]) -> [u8; BANDS] {
    let mut out = [0u8; BANDS];
    for i in 0..BANDS {
        prev[i] = fresh[i].max(prev[i] * 0.86);
        out[i] = (prev[i] * 255.0).round() as u8;
    }
    out
}

pub fn run() {
    #[cfg(windows)]
    loop {
        if !watched() {
            publish([0; BANDS]);
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        if capture().is_err() {
            std::thread::sleep(Duration::from_secs(2));
        }
    }
}

#[cfg(windows)]
fn capture() -> windows::core::Result<()> {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let fmt = client.GetMixFormat()?;
        let (channels, bits, rate) = (usize::from((*fmt).nChannels).max(1), (*fmt).wBitsPerSample, (*fmt).nSamplesPerSec as f32);
        let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt, None);
        CoTaskMemFree(Some(fmt as *const _));
        init?;
        let reader: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        let mut ring: Vec<f32> = Vec::with_capacity(N * 4);
        let mut prev = [0.0f32; BANDS];
        let mut last_pub = 0u64;
        let result = (|| -> windows::core::Result<()> {
            while watched() {
                std::thread::sleep(Duration::from_millis(15));
                while reader.GetNextPacketSize()? > 0 {
                    let (mut data, mut frames, mut flags) = (std::ptr::null_mut::<u8>(), 0u32, 0u32);
                    reader.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                    for f in 0..frames as usize {
                        let mut sum = 0.0f32;
                        if !silent {
                            for c in 0..channels {
                                sum += match bits {
                                    32 => *(data as *const f32).add(f * channels + c),
                                    16 => f32::from(*(data as *const i16).add(f * channels + c)) / 32768.0,
                                    _ => 0.0,
                                };
                            }
                        }
                        ring.push(sum / channels as f32);
                    }
                    reader.ReleaseBuffer(frames)?;
                }
                let mut fresh = None;
                while ring.len() >= N {
                    fresh = Some(analyze(&ring[..N], rate));
                    ring.drain(..N / 2);
                }
                // About 30 updates a second is plenty for the eye; more only costs the connection.
                let now = now_ms();
                if now >= last_pub + 33 {
                    last_pub = now;
                    publish(smooth(&mut prev, fresh.unwrap_or([0.0; BANDS])));
                }
            }
            Ok(())
        })();
        let _ = client.Stop();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, rate: f32) -> Vec<f32> {
        (0..N).map(|i| 0.5 * (2.0 * std::f32::consts::PI * hz * i as f32 / rate).sin()).collect()
    }

    #[test]
    fn a_tone_lights_its_band_and_silence_none() {
        let bands = analyze(&sine(1000.0, 48_000.0), 48_000.0);
        let (loudest, level) = bands.iter().enumerate().fold((0, 0.0), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
        // 1 kHz sits about 60 % up a log scale from 50 Hz to 16 kHz.
        assert!((11..=16).contains(&loudest), "band {loudest}");
        assert!(level > 0.6);
        assert!(analyze(&vec![0.0; N], 48_000.0).iter().all(|&v| v == 0.0));
    }

    #[test]
    fn levels_fall_slowly() {
        let mut prev = [0.0; BANDS];
        assert_eq!(smooth(&mut prev, [1.0; BANDS])[0], 255);
        let after = smooth(&mut prev, [0.0; BANDS])[0];
        assert!(after > 200 && after < 255);
    }

    /// Needs an output device (loud music makes the levels non-zero): `cargo test -- --ignored viz --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn loopback_capture_runs_on_this_machine() {
        let worker = std::thread::spawn(|| capture());
        let mut best = [0u8; BANDS];
        for _ in 0..40 {
            mark_watched();
            std::thread::sleep(Duration::from_millis(50));
            let cur = *LEVELS.lock().unwrap();
            for i in 0..BANDS {
                best[i] = best[i].max(cur[i]);
            }
        }
        eprintln!("peak levels seen: {best:?}");
        // The capture thread stops by itself two seconds after the last mark.
        let result = worker.join().unwrap();
        assert!(result.is_ok(), "{result:?}");
    }
}
