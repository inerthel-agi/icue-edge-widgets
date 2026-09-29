# Changelog

All notable changes to **icue-edge-widgets** are documented here.

---

## [Unreleased]

### Added - 1.3.0 Now Playing extras (need iCUE Edge Companion 0.1.4)
- Synced lyrics on several lines in tall and ultra-wide formats; a tap on a line jumps there when the player can seek.
- Album name back under the artist, and a tap on the length switches it to the time left.
- Shuffle and repeat buttons (off, all, one) around the transport, shown only when the player supports them (formats 1000 px wide and up, and tall portrait).
- Volume slider, mute button and a sleep timer (15, 30, 60 min, off) for the computer, in the ultra-wide and tall portrait formats.
- "Up next" (Spotify only): a tap on the visualiser area switches to the next five tracks with covers, and back. It needs the companion connected to Spotify; other players never show it.
- Audio visualiser (24 bands from the sound the computer plays) in the ultra-wide and tall portrait formats; the companion listens only while it is on screen.

### Fixed - 1.2.7 Now Playing cover colors setting
- Apply the "Cover colors" setting at once; it used to be read only when the next cover loaded, so a change showed up at the next track.

### Fixed - 1.2.6 Now Playing load time
- Replace the blurred-cover glow by a plain gradient: a blur filter over the whole artwork is slow to draw on the screen.

### Changed - 1.2.5 Now Playing cover colors
- Wash the widget background with the cover's colour (behind the artwork first) so the setting is visible even when the cover resembles the accent.

### Fixed - 1.2.4 Now Playing custom style
- Apply the cover colours (they stayed on the accent) by resolving them on the player element.
- Derive panels, lines and secondary text from the chosen text and background colours, so black text on a red background keeps readable buttons and a visible timeline.

### Changed - 1.2.3 Now Playing
- Stop clipping the descenders of g, j, p, q and y in the title, artist, album and source name.
- Enlarge the transport buttons at every size (up to 140 px, 170 px for play/pause; larger still in portrait).
- Show the player's own mark (Spotify, Chrome, Brave, Firefox, Edge, Opera, Vivaldi, VLC) in the source chip instead of a plain dot; other players keep the dot.
- Show synced lyrics (LRCLIB, through the updated companion) for any player when the artist and length match; one line on medium heights, two plus the next line on tall and ultra-wide ones, none on the short formats.
- Take the progress bar, equalizer and lyric colour from the cover (new iCUE setting "Cover colors", On by default); grey covers keep the chosen accent.
- Show a large clock and the date instead of "Nothing playing" when no player is active.
- Animate: equalizer bars while playing, text and cover slide in on a new track, soft glow of the cover, press feedback on the buttons. All of it stops with "reduce motion".

### Fixed - 1.2.2 Spotify rate limit
- Show "Spotify is busy" with the remaining wait instead of "Nothing playing" while Spotify rate-limits the companion.
- Show the wait in hours when it exceeds two hours.

### Changed - 1.2.1 XENEON EDGE readability
- Increase dashboard labels, status text, primary values, and font weight for viewing at a distance.
- Enlarge primary touch controls to at least 60 pixels and rearrange compact dashboard content.
- Place the ISS map controls in a separate toolbar and constrain larger pass popups to the map viewport.
- Verify minimum text/control sizes and three-digit weather values across dashboard layouts.

### Added - 1.2.0 usability
- Show data age and scheduled retries without replacing the last weather or commit details.
- Keep the Daily Brief clock visible during weather errors and explain invalid World Clock zones.
- Add optional manual cooling-sensor selection while retaining automatic selection by default.
- Support ISS pass estimates by touch, mouse, or a keyboard-accessible map-center button.
- Select the first nearby estimated pass, reject stale positions, and label the orbital model's limitations.
- Pause map following during manual navigation and expose the follow state to assistive technology.

### Changed - 1.1.1 local package preparation
- Reworked the ten widget layouts and retained existing widget IDs and settings.
- Fixed timer persistence, calendar-day countdowns, weather error handling, habit progress and keyboard focus, and paginated GitHub counts.
- Isolated saved data by iCUE instance while retaining legacy records.
- Added request cancellation, timeouts, retry backoff, resume handling, and native provider reconnection.
- Replaced key-protected CARTO tiles with OpenStreetMap for ISS dark/day modes, retaining satellite mode and visible attribution.
- Centralized package versions in `VERSION` and declared iCUE 5.47 as the minimum application version.
- Added staged package verification, distribution backups, failed-promotion rollback, and a packaging lock.
- Added logic, browser, and packaging-failure checks; replaced nonexistent pnpm instructions with verified commands.


### Added - Widget polish layer
- `widget-polish.css`: shared Huashu design finish layer for active widgets, with compact icon-only headers, tighter controls, restrained 8px surfaces, improved borders, focus states, and less title-heavy UI.
- `scripts/package-icuewidgets.ps1`: validates and builds active widgets into `dist/icuewidgets/*.icuewidget`.
- `windows-media-dashboard/`: XENEON EDGE dashboard using the local Windows media bridge.
- `system-status-local/`: XENEON EDGE dashboard using the local helper for CPU, RAM, disk, network, and uptime.
- `weather-now/`: XENEON EDGE weather dashboard using Open-Meteo without API keys.
- `github-repo-monitor/`: XENEON EDGE GitHub repository dashboard with optional token setting.
- `cooling-sensor-pump/`: pump LCD cooling sensor widget with automatic pump/temperature sensor selection.
- `windows-media-pump/`: pump LCD widget that reads the current Windows media session through the local helper.
- Generated `.icuewidget` packages now use widget-specific SVG preview icons instead of text initials.

### Fixed - iCUE packages
- Removed legacy productivity iframe widgets from source and package output.
- ISS Horizon now removes the live video area in favor of a larger ISS ground track map with Dark, Satellite, Day, and Auto styles.
- ISS Horizon map style now moves to native iCUE settings, and satellite mode overlays country/place labels.
- ISS Horizon map style changes now sync through an external iCUE bridge compatible with the widget CSP.
- Generated `.icuewidget` preview icons now use transparent widget-specific SVG marks across all widgets instead of black square tiles.
- Packaged widgets now inject the default iCUE event bridge as an external script, avoiding automatic CSP `unsafe-inline` relaxation.
- README now documents native `.icuewidget` imports.
- Final `.icuewidget` archives now write `index.html` as the first ZIP entry, matching importable Marketplace packages and avoiding iCUE's title parser reading another file.
- Generated `.icuewidget` archives now split into `xeneon-edge` and `corsair-watercooling` output folders.
- Packaged archives now exclude secondary HTML pages so iCUE only validates the widget `index.html`.
- Translation files now include Corsair's expected locale keys with English fallback values, preventing `tr('...')` titles from resolving empty in iCUE.
- Packaged HTML now adds a viewport meta tag before the iCUE title when source widgets omit one.
- Fixed packaged `widget-polish.css` paths for productivity widgets.
- Packaged manifests now declare `dashboard_lcd` with `sensor-screen`, matching known importable Xeneon Edge widget packages.
- Packaged HTML now keeps `viewport` before `<title>`, matching Corsair and Marketplace widget structure.
- Packaged widgets now include a minimal global `icueEvents` bridge, removing the iCUE CLI validation warning across all widgets.
- Generated packages now place translated `tr('...')` HTML titles at the top of `<head>` for the iCUE import validator.
- Packaging now stages files in `icuewidget-build/` so the official iCUE Widget CLI includes the widget files instead of creating empty or invalid archives.

### Changed - Active widgets
- Removed visible header titles across active widgets while preserving DOM ids for runtime copy updates.
- Standardized active widget UI to English-only copy and removed French language toggles/dictionaries.

### Changed - Documentation
- README now documents English-only widgets and the shared `widget-polish.css` layer.
- Removed French documentation section to match English-only widget behavior.

### Added - Xeneon Edge Design System
- `productivity/xeneon-edge.css`: Shared design system for all widgets — CSS tokens (dark/light), AMOLED `#000` base, scanline grid overlay, base components (`.mod-header`, `.mod-icon`, `.mod-title`, `.lang-toggle`, `.stat-chip`, `.stats-row`, `.btn`, `.btn-ghost`, `.toast`), M/L/XL size utilities via `data-size` attribute
- `productivity/size-loader.js`: Flash-free size detection — reads `?size=m|l|xl` from URL param, sets `data-size` on `<html>` before render; mirrors `theme-loader.js` pattern

### Changed - Pomodoro (reference implementation)
- Complete visual refonte to Xeneon Edge: Corsair cyan `#00c8ff` accent, gold `#f9ca24` timer digits, Space Grotesk + IBM Plex Sans + JetBrains Mono fonts
- **Size M** (`?size=m`): SVG ring hidden, large digital display 52px, phase label in cyan, 3px linear progress bar at bottom
- **Size L** (default): ring 170px, refined phase badge, glow effect on ring progress arc
- **Size XL** (`?size=xl`): ring 200px, stats row (Session / Focused / Done chips), expanded spacing and controls
- Added real-time stats tracking: focused-time accumulation per session, session counter display
- Added `is-break` class on `.widget` for teal break-mode visual state (border, accent line, icon, digits, controls)
- `btn-timer` now uses cyan/teal outline style (not solid fill) — activates solid on running state
- `m-progress-fill` synchronized with timer tick (elapsed indicator, 0 → 100%)

### Changed - ISS Horizon
- Fonts: Inter → Space Grotesk (UI) + JetBrains Mono; added IBM Plex Sans to Google Fonts import
- `xeneon-edge.css` linked; iCUE body-class size system (`sz-m/l/xl`) unchanged
- Inline `:root` refactored as a token bridge: `--bg-base`, `--text-main/dim/muted`, `--border-subtle/focus`, `--font-ui`, `--font-mono`, `--transition` now reference xeneon-edge tokens
- `--accent-blue` updated to Xeneon cyan `#00c8ff` for map/telemetry highlights; `--accent-nasa` `#fc3d21` retained for live indicators

### Removed
- Retired widgets removed from active widget set and documentation.

---

## [1.1.0] - 2026-04-04

### Fixed - Security
- Replace all `innerHTML` assignments with safe DOM methods (`createElement` / `textContent`) in `conflict-tracker`, eliminates XSS vectors
- Modernize clipboard API in `quick-clipboard`: use `navigator.clipboard` with `execCommand` fallback

### Fixed - Memory leaks
- `posture-reminder`: `clearInterval` on reset + extracted `startTimer()` to prevent timer accumulation

### Fixed - Bugs
- `habit-tracker`: remove double render on init
- `pomodoro`, `hydration`, `notes`: deduplicate storage event listeners (were registered twice on init)
- `posture-reminder`: add missing toast element, styles, and `showToast()` function
- `conflict-tracker`: remove `console.log` calls from production code

### Improved - Accessibility
- `conflict-tracker` tags: add `role="button"`, `tabIndex`, `Enter`/`Space` keyboard support
- `posture-reminder` action button: add `aria-label`

---

## [1.0.0] - 2026-02-28

### Added - Widgets
- **Claude Usage** (Alpha): Monitor Anthropic API token usage
- **Conflict Tracker** (Alpha): Track and visualize active conflicts worldwide
- **ISS Horizon**: Real-time ISS position tracking with horizon map

### Added - Productivity suite
- **Pomodoro**: Focus/break timer with SVG ring display
- **Timer**: Named phases, multiple display modes (ring / digital), Web Audio beeps
- **Daily Focus**: Single daily goal tracker
- **Habit Tracker**: Daily habit check-in with streak counters
- **Hydration**: Water intake reminder and tracker
- **Notes**: Lightweight persistent notepad
- **Quick Clipboard**: Fast clipboard snippets manager
- **Posture Reminder**: Interval-based posture alert
- **Budget**: Simple income/expense tracker

### Added - Infrastructure
- `theme-loader.js`: Flash-of-unstyled-content prevention (reads `pa_theme` from localStorage before render)
- Shared design system: CSS tokens, dark/light themes, toast notifications, grid scanline effect
- MIT License
