<p align="right">
  <strong>中文</strong> | <a href="./README.md">English</a>
</p>

# opencode-retry-proxy

[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![No deps](https://img.shields.io/badge/deps-zero-blue)](./proxy.mjs)

面向 `opencode.ai/zen` Responses API 的透明本地重试代理，自动修复 `previous_response_id` 过期导致的 `referenced response not found or expired`（400）错误。

当上游返回 `400 referenced response not found or expired` 时，代理会自动去掉 `previous_response_id`、合并该 id 对应的全量历史 `input`，重发一次。成功后会话无感续接，无需改客户端。

## 为什么需要它

Reasonix / Opencode 的 Responses API 通过 `previous_response_id` 在服务端串联多轮会话。如果上游因空闲超时、滚动窗口或发版把该 id 回收，后续每一轮都会失败：

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "Error from provider (Console Go): Upstream request failed: [invalid_request_error] referenced response not found or expired"
  }
}
```

本代理让这个错误自愈。

## 快速开始

```bash
# 后台运行（nohup 保证 shell 退出后进程仍在）
nohup node proxy.mjs >/dev/null 2>&1 &
# 或带环境变量覆盖：
LISTEN_PORT=8765 UPSTREAM=https://opencode.ai/zen/go/v1 nohup node proxy.mjs >/dev/null 2>&1 &
# 或使用自带启动脚本：
./start.sh
```

> 若 `8765` 端口已被占用，代理会报错退出——用 `LISTEN_PORT` 换一个端口即可。

把客户端指向代理而非直连上游：

```toml
# reasonix.toml（见 reasonix.toml.example）
[[providers]]
name        = "local-fixed-responses"
kind        = "responses"
base_url    = "http://127.0.0.1:8765/v1"
models      = ["muse-spark-1.2-retry", "muse-spark-1.2-contributor"]
api_key_env = "CUSTOM_OPENCODE_AI_API_KEY"
```

使用模型 `muse-spark-1.2-retry` —— 代理会在转发时自动映射为上游真实模型 `muse-spark-1.2-contributor`，并启用历史合并重试链路。直接用真实模型名也能走代理，但用 `-retry` 别名更易区分是否命中修复路径。

验证：

```bash
tail -f /tmp/opencode-retry-proxy.log
# hit expired previous_response_id=resp_xxx -> retry without it (... -> ... bytes)
# retry result: 200 OK
```

> 提示：用非法模型（`{"model":"test",...}`）打代理会返回 `ModelError: Model test is not supported`——这恰恰说明**代理已正确转发**到上游，不是故障。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LISTEN_HOST` | `127.0.0.1` | **必须保持回环地址。** 勿设为 `0.0.0.0`，否则会成为转发 `Authorization` 的开放代理，任何人都能消耗你的额度。 |
| `LISTEN_PORT` | `8765` | 监听端口 |
| `UPSTREAM` | `https://opencode.ai/zen/go/v1` | 上游 Responses API 基地址（应以 `/v1` 结尾） |
| `LOG_FILE` | `/tmp/opencode-retry-proxy.log` | 日志文件 |
| `MAX_HISTORY` | `300` | 内存中保留的最大响应 id 数（`respId -> input[]`） |

## 工作原理

1. 原样转发所有请求到 `UPSTREAM`（保留 `Authorization`、`content-type`、流式响应）。
2. 若请求携带 `previous_response_id` 且上游返回 `400` 且命中 `referenced response (not found|expired)` 或 `previous_response_id not found`，则构造重试请求：去掉 `previous_response_id`、将 `input` 替换为 `history[prevId] + 当前 input`，重发一次。
3. 通过嗅探 `application/json` 与 `text/event-stream`（SSE）响应中的 `id` 来维护 `history`，将增量 `input` 合并为完整链路，供后续重试使用。

不记录敏感信息——日志仅含 `len`、`id`、`status` 与 200 字符的 `bodyHint` 截断。

## launchd（macOS，可选）

```bash
# 复制并编辑文件内的 ProgramArguments / WorkingDirectory 路径
cp launchd.plist.example ~/Library/LaunchAgents/com.example.opencode-retry-proxy.plist

# 注册并启动（macOS 新版推荐；`launchctl load` 已废弃）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.opencode-retry-proxy.plist

# 验证
launchctl list | grep opencode

# 卸载 / 移除
launchctl bootout gui/$(id -u)/com.example.opencode-retry-proxy
```

或使用 `start.sh` 一键启动：

```bash
./start.sh
```

## 安全与隐私

- 仅绑定 `127.0.0.1`，不要暴露到网络。
- 原样转发 `Authorization` —— 能访问代理的人就能消耗你的 API 额度。
- 内存中最多保留 `MAX_HISTORY` 份完整 `input` 数组，并在 `LOG_FILE` 追加运行日志。除截断的 `bodyHint` 外，不落盘请求体。
- 零依赖，仅需 Node.js `>=18`（使用原生 `fetch`）。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
