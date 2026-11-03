# Changelog

All notable changes to **icue-edge-widgets** are documented here.

---

## [Unreleased]

### Added - Network Pulse, System Pulse, Rig Pet, Flip Clock, Rain Window
- `network-pulse` (needs iCUE Edge Companion): download and upload rate of the hardware adapters, the last minute as a chart, and an optional ping to Cloudflare, Google or Quad9. Units in Mbit/s or MB/s.
- `system-pulse`: CPU, GPU, RAM and VRAM load rings with temperatures and the last minute, from the iCUE Sensors plugin (`shared/sensor-reader.js` picks the sensors by name).
- `rig-pet`: a creature that naps when the PC is cool, sweats when it warms up and pants when CPU or GPU passes 82 °C; it breathes faster under load. In wide slots it walks about (running animation, facing its way); a tap makes it wave or hop with a heart; it jumps for joy when the PC cools down. Moods keep a few degrees of margin before changing back (66 / 78 °C), and its lines vary and quote the hotter part, the load and how long the mood has lasted. Energy (drained by heat, restored by cool time) and joy (taps and balls; fades over hours): when one runs low the pet is tired or sulks. Experience and levels unlock a bow (level 4), a wizard hat (level 6) and a crown (level 10); a line shows today's max temperature, calm time, pets and balls; all kept between restarts. It plays when iCUE gives an FPS reading, wears headphones while music plays and watches Claude Code work (both through the companion), and naps more easily at night. The room behind it follows the time of day and the city's weather from Open-Meteo (rain, snow, storm, fog, clouds, stars). Swipe to throw a ball: it runs after it. Settings: personality (calm, energetic, grumpy), warm and hot thresholds, accessory, room weather and city, companion reactions, and a preview mode that plays every state in turn (calm, walking, warm, hot, cooled down, sleepy, music, Claude Code, gaming, tap, ball, tired, sulking, each accessory) every 6 s without changing the pet's real stats. In wide slots the room runs under the words, which sit on a glass panel, and a pixel pet stands taller; sweat, z's and steam follow a pixel pet's head. Same sensors. Mascot setting: Bit, Claude (pixel crab), Ghost, Robot, Slime, the pixel pets Clawd, Grace, Sea Lion, Jennie and Claire (Codex pet sheets drawn by the author) and the community pets Dario, Tom, Patrick, Pepe, Rick, Doge, Mini Elon, Kirby, Clippy, Tux and the anime pets Frieren, Anya, Miku, Luffy, Goku, Gojo, Umaru, Asuka, Doraemon, Elaina, Violet, Bocchi, Luo Xiaohei, Mini Sama, Doro, Guga, Kiki, Usagi and Hachiware (from codex-pet.org, credited in the README), all shipped in the package and animated row by mood: idle, waiting, running, failed), or your own pictures (one picture, GIF or short video per mood; a mood without one uses the calm one).
- `flip-clock`: flip cards that turn over each minute, or Nixie tubes, or a fluorescent (VFD) panel; 12h / 24h, seconds and date.
- `rain-window`: the real weather drawn behind a window (rain beads running down the glass, storm flashes, snow, fog, clouds, a clear sky with stars and moon at night), with the time and temperature. Open-Meteo, like `weather-now`.

### Fixed
- iCUE editor preview: a widget shown in the editor's small frame draws at the real slot size and is scaled down, so the preview matches the screen.
- `spotify` S: a long artist name in `Up next` stays inside its card.
- `spotify`: no longer frozen on the last track while Spotify rate-limits the app. With iCUE Edge Companion (unreleased build), the widget follows the Spotify app's Windows session until the wait ends: track, cover, progress, lyrics, play/pause and skips stay live; a line says until when; queue, volume, shuffle and repeat come back afterwards. The companion also reads the Web API far less often when the Spotify app is open on the PC (every 15 s / 30 s, woken at once by each change in the app), to avoid the bans in the first place.

### Added - Stocks (needs iCUE Edge Companion)
- `stocks`: up to 8 symbols in a market-terminal look (black, amber, orange bar, green / red moves): watchlist with day sparklines and a flash on each move; tall slots add the first symbol's intraday chart against the previous close; wide slots add a ticker tape. Quotes from Yahoo Finance's chart endpoint through the companion (unofficial, no key, at most once a minute per symbol; only the symbols you set are sent). Any Style other than Instrument restyles it.

### Added - Audio Mixer, Agent Activity, Control Deck (need iCUE Edge Companion)
- `audio-mixer`: a fader and a mute per app playing sound (Windows audio sessions) plus the output device, with live levels and the app icons; touch to set a volume. Portrait slots lay the faders down.
- `agent-activity`: what Claude Code is doing now (current step, last ten tool calls, tokens per minute, tool calls today). Only the tool name and a short target (file name, the command's own description) leave the logs.
- `control-deck`: touch keys for a fixed list of actions run by the companion: microphone and sound mute (red when muted), play / pause, next track, screenshot, lock, Calculator, File Explorer, Task Manager, Night light settings. The widget sends an action id, never a command.

### Fixed - readable text in every Style
- Contrast audit (`previews/contrast-audit`): every widget, size and Style is loaded and any text under 3:1 against what is behind it is listed. 1,995 combinations pass (widgets audited in their empty or offline state; text over images is not measured).
- Pastel: darker pink accent (#d63f78), so accent-coloured text reads on its pale background.
- Brutalist and Pastel: badges keep the Style's badge text colour (lime-on-lime badges in Daily Brief, Focus Timer, GitHub Repo Monitor).
- Habit Rings: the + button text and ISS Horizon's day / night badge are pulled towards the text colour, readable on light Styles.
- Pump gauges: the idle number is dimmed with opacity instead of a fixed grey, so it stays readable on each design.
- Spotify: Light theme keeps its light background and dark text with any Style; Blur keeps light text; accent-coloured text, secondary text and lyric buttons readable on every theme; the cover fills the left column in L and XL; the S up-next card no longer covers the Spotify mark; lyrics re-centre when the current line wraps.
- Now Playing: long current lyric lines step down in size instead of being cut.
- Screen Time: each application shows its own icon (read by the companion from the executable, kept as a small image; its initial when there is none).

### Added - three widgets that use iCUE Edge Companion
- `ai-cost`: estimated cost of today's Claude and Codex usage, with a 24 h trend, provider split, yesterday, month so far and pace. The price class (Sonnet, Opus, Haiku, GPT-5, Mini) is a setting; the figure is an estimate, not a bill. Needs the companion's new `days` totals for the month figure.
- `screen-time`: time per application today, categories and hours of the day. Needs the companion's new Screen Time module (application name and seconds only, kept on this PC; it starts when the widget first asks).
- `racing-gauge-pump`: racing-style gauge on the pump LCD. The scale follows the sensor: temperature with a redline, speed in rpm with shift lights, percent or any other unit. Seven animated designs (Classic, Race, Munich, Stuttgart, GR, GT-R, Maranello, inspired by motorsport and car dashboards, no brand logos): start-up sweep, spring-driven needle, redline flash, shift lights, segment tach, glow and a one-minute history depending on the design.
- `fps-gauge-pump`: the same animated designs plus an FPS design, fed by the iCUE FPS sensor. The scale adapts (60 to 600 FPS), with the last minute's average and low. Frame generation: Dynamic by default, which estimates the multiplier from the last minute's average (up to 165 FPS native, then 2×, 3×, 4×) and marks the split as an estimate; or Off, 2×, 3×, 4× set by hand. iCUE does not report whether frame generation is on. Outside a game (iCUE reports -1) the dial is empty and says No game running.

### Added - 12 more styles
- Aurora, Paper, Brutalist, Synthwave, Abyss, Sunset, Newsprint, Blueprint, Forest, Pastel, Amber and HUD: moods rather than brands, 21 styles in all.

### Added - "Style" setting on every widget
- Instrument (default), Apple, OpenAI, SpaceX, Nothing, Anthropic, Google, Terminal and Corsair, from `shared/widget-styles.css`. Colours chosen in iCUE (Custom Style) still win. Now Playing keeps its Apple default.

### Added - Now Playing "Style" setting
- Apple (default), SpaceX, OpenAI, Nothing and Classic. A tap on an Up next row skips to that track (needs the matching companion change).

### Changed - Now Playing, Apple-style skin
- Borderless rounded cover with shadow, glass controls, white progress and lyric line, blurred distant lyrics, ambient wash of the cover colour.
- 840 x 696 becomes a poster (cover fills the slot, text on a gradient); 1688 x 696 joins the lyrics-first wide layout with a visualiser column.

### Changed - unified design
- One shared kit (`shared/xeneon-widget.css`): same dark palette, single default accent `#a8d5ba`, same header / hero / metrics / status anatomy.
- All 14 widgets now have the "Widget Personalization" group (Text Color, Accent Color, Background Color, Background Transparency), applied by `WidgetRuntime.personalize()`. Background image and glass blur are not included yet.
- Claude/Codex Usage: same defaults and labels. Spotify: Segoe UI and the shared palette; bundled fonts removed.
- Pump widgets use the shared tokens. Focus Timer no longer changes accent per mode.

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
