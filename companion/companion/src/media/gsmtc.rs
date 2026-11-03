//! Windows media sessions (GlobalSystemMediaTransportControls), polled twice a second.
//! ponytail: polling instead of the session change events; switch to events if 500 ms is too slow.
use super::{apply, lock, set_error, wants_thumb, Action, Caps, Meta, Modes, Observed, Playback, Target, Thumb, Timeline, MAX_ART_BYTES};
use crate::util::now_ms;
use std::collections::HashMap;
use std::time::Duration;
use windows::core::Result;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status, GlobalSystemMediaTransportControlsSessionTimelineProperties as TimelineProperties,
};
use windows::Media::MediaPlaybackAutoRepeatMode;
use windows::Storage::Streams::DataReader;

const POLL: Duration = Duration::from_millis(500);
/// 1601-01-01 to 1970-01-01 in 100 ns ticks.
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

pub fn run() {
    loop {
        match Manager::RequestAsync().and_then(|op| op.get()) {
            Ok(manager) => {
                let mut failures = 0;
                // A player closing mid-read fails one round; ten in a row means the manager itself is gone.
                while failures < 10 {
                    match poll(&manager) {
                        Ok(()) => failures = 0,
                        Err(e) => {
                            failures += 1;
                            if failures == 10 {
                                set_error(format!("Windows media sessions unavailable: {}", e.message()));
                            }
                        }
                    }
                    std::thread::sleep(POLL);
                }
            }
            Err(e) => set_error(format!("Windows media sessions unavailable: {}", e.message())),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn poll(manager: &Manager) -> Result<()> {
    let now = now_ms();
    let current = manager.GetCurrentSession().ok().and_then(|s| s.SourceAppUserModelId().ok()).map(|h| h.to_string());
    let mut ordinals: HashMap<String, u32> = HashMap::new();
    let mut observed = Vec::new();
    for session in manager.GetSessions()? {
        let Ok(app_id) = session.SourceAppUserModelId().map(|h| h.to_string()) else { continue };
        let ordinal = {
            let n = ordinals.entry(app_id.clone()).or_insert(0);
            *n += 1;
            *n - 1
        };
        // One player failing to answer (suspended app, closing) is skipped; it must not blank the others.
        if let Ok(o) = observe(&session, app_id, ordinal, now) {
            observed.push(o);
        }
    }
    apply(observed, current, now);
    super::set_volume(super::volume::read(), now);
    // The sleep timer pauses whatever is playing when it runs out.
    if let Some(target) = super::due_sleep(now) {
        let _ = execute(&target);
    }
    Ok(())
}

// ponytail: WinRT `.get()` has no timeout; a player that never answers would stall this thread.
fn observe(session: &windows::Media::Control::GlobalSystemMediaTransportControlsSession, app_id: String, ordinal: u32, now: u64) -> Result<Observed> {
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let meta = Meta { title: props.Title()?.to_string(), artist: props.Artist()?.to_string(), album: props.AlbumTitle()?.to_string() };
    let info = session.GetPlaybackInfo()?;
    let playback = match info.PlaybackStatus()? {
        Status::Playing => Playback::Playing,
        Status::Paused => Playback::Paused,
        Status::Stopped | Status::Closed => Playback::Stopped,
        _ => Playback::Unknown,
    };
    let c = info.Controls()?;
    let caps = Caps {
        play_pause: c.IsPlayPauseToggleEnabled()? || c.IsPlayEnabled()? || c.IsPauseEnabled()?,
        next: c.IsNextEnabled()?,
        prev: c.IsPreviousEnabled()?,
        seek: c.IsPlaybackPositionEnabled()?,
        shuffle: c.IsShuffleEnabled()?,
        repeat: c.IsRepeatEnabled()?,
    };
    let modes = Modes {
        shuffle: info.IsShuffleActive().ok().and_then(|r| r.Value().ok()),
        repeat: info.AutoRepeatMode().ok().and_then(|r| r.Value().ok()).map(|m| m.0 as u8),
    };
    let timeline = timeline(&session.GetTimelineProperties()?, now);
    let fetch = wants_thumb(&lock(), &app_id, ordinal, &meta, now);
    let thumb = if fetch { read_thumb(&props) } else { Thumb::Unchanged };
    Ok(Observed { app_id, ordinal, meta, playback, timeline, caps, modes, thumb })
}

fn timeline(t: &TimelineProperties, now: u64) -> Option<Timeline> {
    let start = t.StartTime().ok()?.Duration;
    let end = t.EndTime().ok()?.Duration;
    let position_ms = ((t.Position().ok()?.Duration - start).max(0) / 10_000) as u64;
    let duration_ms = (end > start).then(|| ((end - start) / 10_000) as u64);
    // Nothing known: no timeline rather than a fake 0:00.
    if duration_ms.is_none() && position_ms == 0 {
        return None;
    }
    let updated_at = t
        .LastUpdatedTime()
        .ok()
        .map(|d| d.UniversalTime)
        .filter(|&u| u > UNIX_EPOCH_TICKS)
        .map(|u| ((u - UNIX_EPOCH_TICKS) / 10_000) as u64)
        .map_or(now, |u| u.min(now));
    Some(Timeline { position_ms, duration_ms, updated_at, start_ticks: start })
}

fn read_thumb(props: &Properties) -> Thumb {
    let Ok(reference) = props.Thumbnail() else { return Thumb::Missing };
    let read = || -> Result<Option<Vec<u8>>> {
        let stream = reference.OpenReadAsync()?.get()?;
        let size = stream.Size()?;
        if size == 0 || size > MAX_ART_BYTES as u64 {
            return Ok(None);
        }
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        let loaded = reader.LoadAsync(size as u32)?.get()?;
        let mut bytes = vec![0u8; loaded as usize];
        reader.ReadBytes(&mut bytes)?;
        Ok(Some(bytes))
    };
    match read() {
        Ok(Some(bytes)) => Thumb::Image(bytes),
        _ => Thumb::Missing,
    }
}

/// Looks the session up again by app id and ordinal: no WinRT object is kept across threads.
pub fn execute(target: &Target) -> Result<bool> {
    let manager = Manager::RequestAsync()?.get()?;
    let mut n = 0;
    for session in manager.GetSessions()? {
        if session.SourceAppUserModelId()?.to_string() != target.app_id {
            continue;
        }
        if n == target.ordinal {
            return match target.action {
                Action::Toggle => session.TryTogglePlayPauseAsync()?.get(),
                Action::Next => session.TrySkipNextAsync()?.get(),
                Action::Prev => session.TrySkipPreviousAsync()?.get(),
                Action::SeekMs(ms) => session.TryChangePlaybackPositionAsync(target.start_ticks + ms as i64 * 10_000)?.get(),
                Action::Shuffle(on) => session.TryChangeShuffleActiveAsync(on)?.get(),
                Action::Repeat(mode) => session.TryChangeAutoRepeatModeAsync(MediaPlaybackAutoRepeatMode(mode as i32))?.get(),
            };
        }
        n += 1;
    }
    Ok(false)
}
