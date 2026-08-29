<p align="right">
  <a href="./README.zh-CN.md">中文</a> | <strong>English</strong>
</p>

# opencode-retry-proxy

[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![No deps](https://img.shields.io/badge/deps-zero-blue)](./proxy.mjs)

Transparent local retry proxy for `opencode.ai/zen` Responses API `previous_response_id` expiry (`referenced response not found or expired` → 400).

When the upstream returns `400 referenced response not found or expired`, the proxy strips `previous_response_id`, merges the stored full history for that id, and retries once. On success the session continues transparently — no client changes needed.

## Why

Reasonix / Opencode's Responses API chains turns server-side via `previous_response_id`. If the upstream evicts that id (idle timeout / rolling window / deploy), every subsequent turn fails with:

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "Error from provider (Console Go): Upstream request failed: [invalid_request_error] referenced response not found or expired"
  }
}
```

This proxy makes that error self-healing.

## Quick start

```bash
# run in background (nohup keeps it alive after the shell exits)
nohup node proxy.mjs >/dev/null 2>&1 &
# or with env overrides:
LISTEN_PORT=8765 UPSTREAM=https://opencode.ai/zen/go/v1 nohup node proxy.mjs >/dev/null 2>&1 &
# or use the bundled launcher:
./start.sh
```

> If port `8765` is already taken, the proxy exits with an error — pick another port via `LISTEN_PORT`.

Point your client at the proxy instead of the upstream:

```toml
# reasonix.toml (see reasonix.toml.example)
[[providers]]
name        = "local-fixed-responses"
kind        = "responses"
base_url    = "http://127.0.0.1:8765/v1"
models      = ["muse-spark-1.2-retry", "muse-spark-1.2-contributor"]
api_key_env = "CUSTOM_OPENCODE_AI_API_KEY"
```

Use model `muse-spark-1.2-retry` — the proxy aliases it to `muse-spark-1.2-contributor` upstream and enables the history-merge retry path. Using the real model name directly also works, but the alias makes it obvious when the fix is active.

Verify:

```bash
tail -f /tmp/opencode-retry-proxy.log
# stored history resp_xxx session=c1 items=912 bytes=1897560
# hit expired previous_response_id=resp_xxx session=c1 -> merge retry (46453 -> 1951954 bytes)
# retry result: 200 OK
```

> Tip: hitting the proxy with a bogus model (`{"model":"test",...}`) returns `ModelError: Model test is not supported` — that is the **proxy forwarding correctly** to the upstream, not a failure.

## Env

| Var | Default | Notes |
|-----|---------|-------|
| `LISTEN_HOST` | `127.0.0.1` | **Must stay loopback.** Do NOT set to `0.0.0.0` — that would expose an open proxy forwarding your `Authorization` to anyone. |
| `LISTEN_PORT` | `8765` |  |
| `UPSTREAM` | `https://opencode.ai/zen/go/v1` | Upstream Responses API base (should end with `/v1`). |
| `LOG_FILE` | `/tmp/opencode-retry-proxy.log` |  |
| `MAX_HISTORY` | `300` | Max response ids kept in memory (`respId -> input[]`). |
| `MAX_HISTORY_BYTES` | `268435456` (256MB) | Byte budget for stored inputs; oldest entries evicted first (disk file follows the trimmed state). |
| `MERGE_MAX_BYTES` | `4194304` (4MB) | Merged retry bodies larger than this are not sent; the upstream 400 passes through. |
| `HISTORY_FILE` | `/tmp/opencode-retry-proxy-history.json` | Disk persistence of stored history (see Security & Privacy). |

## How it works

1. Forwards every request to `UPSTREAM` verbatim (preserves `Authorization`, `content-type`, streaming).
2. Tracks sessions as `previous_response_id` chains: every stored response carries a `session=c_N` tag in logs, and full resends / compaction resets are detected per chain by matching the input's head hash against the chain head (the chain content is replaced instead of appended).
3. Stores full history by sniffing the response `id` from both `application/json` and `text/event-stream` (SSE) bodies. String `input` (used by some clients) is normalized to a single user-message item for storage/merging.
4. On `400 referenced response (not found|expired)`:
   - **with stored history** — strips `previous_response_id`, merges `history[prevId] + input` into a full replay (injecting `summary: []` on reasoning items that lack it), and retries once;
   - **without stored history** (chain predates proxy start, or evicted) — last-resort strip-and-retry so the session survives (`DEGRADED retry without context` in the log; that turn may lack older context);
   - **merged body over `MERGE_MAX_BYTES`** — the upstream 400 is passed through unchanged.
5. Persists history to `HISTORY_FILE` (debounced, flushed on SIGTERM/SIGINT) and restores it at startup, so restarts don't amnesia previously-alive chains.

No secrets are logged — only `len`, `id`, `status`, and truncated hints.

## launchd (macOS, optional)

```bash
# copy and edit ProgramArguments / WorkingDirectory paths inside
cp launchd.plist.example ~/Library/LaunchAgents/com.example.opencode-retry-proxy.plist

# register and start (modern macOS; `launchctl load` is deprecated)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.opencode-retry-proxy.plist

# verify
launchctl list | grep opencode

# unload / remove
launchctl bootout gui/$(id -u)/com.example.opencode-retry-proxy
```

Or use `start.sh`:

```bash
./start.sh
```

## Security & Privacy

- Binds to `127.0.0.1` only. Do not expose to the network.
- Forwards `Authorization` unchanged — whoever can reach the proxy can spend your API key's quota.
- **Request bodies are persisted locally**: stored history (full `input` arrays, up to `MAX_HISTORY_BYTES`) is written to `HISTORY_FILE` so sessions survive proxy restarts. Keep the file on a private disk; delete it to wipe stored context.
- Log lines contain only lengths, ids, statuses, and truncated hints — no full bodies.
- No dependencies beyond Node.js `>=18` (uses native `fetch`).

## License

MIT — see [LICENSE](./LICENSE).
