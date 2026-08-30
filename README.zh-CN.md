<p align="right">
  <strong>中文</strong> | <a href="./README.md">English</a>
</p>

# opencode-retry-proxy

[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![No deps](https://img.shields.io/badge/deps-zero-blue)](./proxy.mjs)

面向 `opencode.ai/zen` Responses API 的透明本地重试代理，自动修复 `previous_response_id` 过期导致的 `referenced response not found or expired`（400）错误。

当上游返回 `400 referenced response not found or expired` 时，代理会自动去掉 `previous_response_id`、合并该 id 对应的全量历史 `input`，重发一次。成功后会话无感续接，无需改客户端。

它还自愈**上下文长度超限**：muse 超限时报的是通用 `400 invalid_request_error: The request contains invalid parameters`（不带 "context length exceeded" 字样）。对超大请求，代理会估算输入 token 数，并在收到此类 400 时压缩 input（保留头部系统/任务上下文 + 尾部最近内容，丢弃中间，并保持 `function_call`/`function_call_output` 成对），随后重发——turn 用缩减后的旧上下文继续，而不是直接死掉。

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
# stored history resp_xxx session=c1 items=912 bytes=1897560
# hit expired previous_response_id=resp_xxx session=c1 -> merge retry (46453 -> 1951954 bytes)
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
| `MAX_HISTORY` | `10000` | 内存中保留的最大响应 id 数（共享链模型下 id 引用极小） |
| `MAX_HISTORY_BYTES` | `268435456`（256MB） | 存储历史的字节预算，超限按最旧驱逐（磁盘文件随之收敛） |
| `MERGE_MAX_BYTES` | `4194304`（4MB） | 合并重试请求体超过该值则不重发，改为原样透传上游 400 |
| `CTX_MAX_TOKENS` | `750000` | 上下文超源自愈的 token 预算，压缩后 input 目标不超过该值（需低于模型真实上限；设为 `0` 关闭该功能） |
| `CTX_HEAD_TOKENS` | `20000` | 压缩时始终保留的 input 头部 token 数（系统/任务上下文） |
| `CTX_MIN_SUSPECT_TOKENS` | `400000` | 仅当请求估算 token 数超过该值才尝试自愈，避免误伤小请求的真实错误 |
| `HISTORY_FILE` | `/tmp/opencode-retry-proxy-history.json` | 历史落盘文件（见「安全与隐私」） |

## 工作原理

1. 原样转发所有请求到 `UPSTREAM`（保留 `Authorization`、`content-type`、流式响应）。
2. 以 `previous_response_id` 链为会话单位：每条存储的历史都带 `session=c_N` 日志标签；通过比对请求 input 首条目哈希与链首哈希，按会话识别全量重发/压缩重置（此时链内容整体替换，而非追加旧历史）。
3. 通过嗅探 `application/json` 与 `text/event-stream`（SSE）响应中的 `id` 维护 `history`，将增量 `input` 合并为完整链路；字符串型 `input`（部分客户端使用）会规范化为单条 user message 再存储/合并。
4. 遇到 `400 referenced response (not found|expired)` 时：
   - **有存储历史** —— 去掉 `previous_response_id`，把 `history[prevId] + input` 合并成完整回放（为缺少 `summary` 的 reasoning item 注入 `summary: []`），重发一次；
   - **无存储历史**（链早于代理启动、或已被驱逐）—— 兜底剥离重试保证会话存活（日志标记 `DEGRADED retry without context`，该轮可能缺少更早的上下文）；
   - **合并后体积超过 `MERGE_MAX_BYTES`** —— 将上游 400 原样透传。
5. 历史落盘到 `HISTORY_FILE`（防抖写入，SIGTERM/SIGINT 时同步保存），启动时恢复——重启不再导致旧链失忆。
6. 自愈上下文超限：muse 把上下文超限报成通用 `400 invalid_request_error: The request contains invalid parameters`。当估算 token 数超过 `CTX_MIN_SUSPECT_TOKENS` 的请求收到此类 400 时，代理将 input 压缩到 `CTX_MAX_TOKENS`——保留头部（系统/任务上下文，`CTX_HEAD_TOKENS`）与最近尾部、丢弃中间，并保持 `function_call`/`function_call_output` 成对——先按预算重发一次，再按 70% 预算重试一次。日志标记 `context overflow suspected ... compacting N -> M items`。代价：模型不再看到被丢弃的中间旧上下文（较早的轮次）；客户端自身保存的会话不受影响。

日志不含敏感信息——仅 `len`、`id`、`status` 与截断提示。

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
- **请求体会本地落盘**：存储的历史（完整 `input`，上限 `MAX_HISTORY_BYTES`）会写入 `HISTORY_FILE`，以便代理重启后会话不失忆。请确保该文件位于私有磁盘；删除该文件即可清空已存上下文。
- 日志仅包含长度、id、状态码与截断提示，不记录完整请求体。
- 零依赖，仅需 Node.js `>=18`（使用原生 `fetch`）。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
