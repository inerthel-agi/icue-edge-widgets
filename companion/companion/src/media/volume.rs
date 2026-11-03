//! System output volume and mute (Windows Core Audio) for the widget's volume control.
use windows::core::Result;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

fn endpoint() -> Result<IAudioEndpointVolume> {
    unsafe {
        // Already initialised on some threads: that answer is fine, only real failures show later.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
    }
}

/// (volume 0..=100, muted) of the default output device.
pub fn read() -> Option<(u8, bool)> {
    let v = endpoint().ok()?;
    unsafe { Some(((v.GetMasterVolumeLevelScalar().ok()? * 100.0).round() as u8, v.GetMute().ok()?.as_bool())) }
}

pub fn set_level(percent: u8) -> Result<()> {
    unsafe { endpoint()?.SetMasterVolumeLevelScalar(f32::from(percent.min(100)) / 100.0, std::ptr::null()) }
}

pub fn set_mute(muted: bool) -> Result<()> {
    unsafe { endpoint()?.SetMute(muted, std::ptr::null()) }
}

#[cfg(test)]
mod tests {
    /// Needs an output device, so it runs only on request: `cargo test -- --ignored volume`.
    #[test]
    #[ignore]
    fn reads_the_system_volume() {
        let (level, muted) = super::read().expect("default output device");
        eprintln!("system volume {level} %, muted {muted}");
        assert!(level <= 100);
    }
}
