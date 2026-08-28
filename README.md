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
node proxy.mjs &
# or with env overrides:
LISTEN_PORT=8765 UPSTREAM=https://opencode.ai/zen/go/v1 node proxy.mjs
```

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
# hit expired previous_response_id=resp_xxx -> retry without it (... -> ... bytes)
# retry result: 200 OK
```

## Env

| Var | Default | Notes |
|-----|---------|-------|
| `LISTEN_HOST` | `127.0.0.1` | **Must stay loopback.** Do NOT set to `0.0.0.0` — that would expose an open proxy forwarding your `Authorization` to anyone. |
| `LISTEN_PORT` | `8765` |  |
| `UPSTREAM` | `https://opencode.ai/zen/go/v1` | Upstream Responses API base (should end with `/v1`). |
| `LOG_FILE` | `/tmp/opencode-retry-proxy.log` |  |
| `MAX_HISTORY` | `300` | Max response ids kept in memory (`respId -> input[]`). |

## How it works

1. Forwards every request to `UPSTREAM` verbatim (preserves `Authorization`, `content-type`, streaming).
2. If the request carried `previous_response_id` and upstream replied `400` matching `referenced response (not found|expired)` or `previous_response_id not found`, builds a retry body with `previous_response_id` removed and `input` replaced by `history[prevId] + current input`, then `POST`s once.
3. Maintains `history` by sniffing response `id` from both `application/json` and `text/event-stream` (SSE) bodies, merging incremental `input` into the full chain for future retries.

No secrets are logged — only `len`, `id`, `status`, and a 200-char `bodyHint`.

## launchd (macOS, optional)

```bash
cp launchd.plist.example ~/Library/LaunchAgents/com.example.opencode-retry-proxy.plist
# edit ProgramArguments / WorkingDirectory paths inside
launchctl load ~/Library/LaunchAgents/com.example.opencode-retry-proxy.plist
launchctl list | grep opencode
```

Or use `start.sh`:

```bash
./start.sh
```

## Security & Privacy

- Binds to `127.0.0.1` only. Do not expose to the network.
- Forwards `Authorization` unchanged — whoever can reach the proxy can spend your API key's quota.
- Keeps up to `MAX_HISTORY` full `input` arrays in memory and appends operational lines to `LOG_FILE`. No request bodies are persisted beyond the log's truncated hints.
- No dependencies beyond Node.js `>=18` (uses native `fetch`).

## License

MIT — see [LICENSE](./LICENSE).
