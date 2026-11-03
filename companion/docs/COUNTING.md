# Counting rules

Field meanings were checked on local files on 2026-09-27 (structure and counters only, no content). Both formats are internal to their clients and may change.

## Measures are kept apart

| Category | Unit | Never converted to |
|---|---|---|
| Tokens consumed | tokens, per request / session / hour | quota %, money |
| Context occupancy | tokens in the last request | consumption |
| Subscription quota | % of a provider window | tokens |
| Credits / extra usage | provider unit (Codex balance string, Claude minor currency units) | tokens |

Claude % and Codex % are never added. A missing value is sent as `null` with a reason and shown as unavailable.

## Codex

Source line: `{"type":"event_msg","payload":{"type":"token_count","info":{...},"rate_limits":{...}}}`.

- `info.total_token_usage` is cumulative for the session. Observed: `total_tokens = input_tokens + output_tokens`, so `cached_input_tokens` and `cache_write_input_tokens` are part of `input_tokens`, and `reasoning_output_tokens` is part of `output_tokens`.
- Total shown = input + output. Cache and reasoning are displayed as "included in".
- Per session (id from `session_meta.payload.id`), the collector keeps the per-field high-water mark and adds only the growth over it, attributed to the hour of the event's own `timestamp`. Repeated events, resumed sessions that replay history and re-reads after truncation add nothing. A decrease adds nothing.
- Context = `last_token_usage.total_tokens` / `model_context_window` (computed).
- Quotas: `rate_limits.primary` / `secondary` with `used_percent`, `window_minutes`, `resets_at` (seconds). Only windows present in the payload are shown; `limit_id` other than `codex` is ignored.
- `token_usage_record` lines (per-request usage with `response_id`) exist in recent versions; they are not used, the cumulative counter covers old and new files alike.

## Claude Code

Source line: `{"type":"assistant","message":{"id":...,"model":...,"usage":{...}},"requestId":...,"sessionId":...,"timestamp":...}`.

- One API message is written on several lines (observed: 147 usage lines for 68 distinct `message.id|requestId`). Usage is keyed by `message.id|requestId`; only per-field growth over what was already counted for that key is added. Keys are persisted 7 days.
- `input_tokens` excludes cache. `cache_read_input_tokens` and `cache_creation_input_tokens` are separate categories. Total shown = input + output + cache read + cache write.
- `output_tokens_details.thinking_tokens`, when present, is shown as reasoning included in output.
- Context estimate = input + cache read + cache write of the latest non-sidechain message. Capacity is not in the log.
- `model == "<synthetic>"` lines are skipped.

## Time

- All timestamps are UTC milliseconds. History is stored in UTC hour buckets for 90 days.
- "Today" is computed in the page with the viewer's time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`), shown next to the figure.
- On first launch, files changed in the last 48 h are read from the start and each usage is attributed to its own timestamp, not to the launch day.

## Files

- Only files modified in the last 48 h are followed. Codex: today's date folders (±2 days) every 10 s; Claude: directories modified in the last 48 h every 10 s; a full walk (depth 3) every 10 min.
- Each file resumes from its saved offset. An incomplete last line waits for its newline. A file shorter than the saved offset is re-read from 0; deduplication prevents recounting.
- State (offsets, dedup keys, history) is written atomically every 2 minutes and on exit.
