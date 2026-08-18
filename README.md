# dsh-codex-import

> 把 **OpenAI Codex CLI** 的历史对话导入 **DeepSeek Harness (DSH)**，成为可浏览、可搜索、可继续的 DSH 会话。
> Import **OpenAI Codex CLI** conversation history into **DeepSeek Harness (DSH)** as browsable, searchable, resumable sessions.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.20-339933)](package.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#)

---

## 特性 / Features

- 🗂️ **一键导入**：`/codex-import <session-id>` 把 codex CLI 的任意历史会话变成 DSH 会话，出现在侧边栏对应 workspace 下
- 🔁 **完整保真**：用户消息、助手回复（commentary + final_answer）、工具调用与输出（`exec_command` / `write_stdin` / `apply_patch` 等）、turn/step 结构、会话标题
- 🧩 **两种形态**：宿主插件命令（在 GUI 里用）+ 独立 CLI（无需启动 DSH，直接写会话文件）
- ⚡ **零运行时依赖**：纯 Node，用 Node ≥ 22.20 内置的 `node:zlib` zstd 支持写 DSH 标准会话文件
- 🛡️ **写入自校验**：产物与 DSH 持久化层字节级一致（双帧 zstd、header 单独一帧、seq 连续、带 checksum），写完即验证

- **Source**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — the raw event stream `codex resume <session-id>` replays
- **Target**: `~/.dsh/sessions/<workspace>/<session-id>/session.jsonl.zstd` — the standard DSH session artifact

---

## 安装 / Install

### 作为 DSH 插件（推荐 / recommended）

```bash
dsh plugin --profile web add git+https://github.com/G1en-114/dsh-codex-import.git
```

> ⚠️ git 托管的安装：仓库的 `prepare` 脚本会被 pnpm 拦截，需要先按 pnpm 报错提示，把包名加进 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds`，然后重跑上面的命令。
>
> ⚠️ For git installs, pnpm blocks the `prepare` script until you add the exact package key it prints to `allowBuilds` in `~/.dsh/profiles/web/pnpm-workspace.yaml`, then re-run the command.

因为是 **bundle 插件**（`dsh.bundle.patch`），安装后自动注册到 profile，**重启 `dsh web`**（或刷新页面）后即可使用。

Being a **bundle plugin**, it self-registers into the profile — just restart `dsh web` (or refresh the page).

### 作为独立 CLI / standalone CLI

```bash
# 无需安装，直接从仓库运行（Node >= 22.20）
node bin/dsh-codex-import.mjs 019feec0-f565-7900-b985-1d6ba3b63a56

# 或全局安装
npm install -g dsh-codex-import
dsh-codex-import <codex-session-id | rollout.jsonl> [options]
```

---

## 使用 / Usage

### 在 DSH 会话里 / in a DSH session

```
/codex-import 019feec0-f565-7900-b985-1d6ba3b63a56
/codex-import ~/rollout.jsonl --session-id session-my-import --cwd /mnt/e/cell
```

导入完成后会返回新的 session id，刷新侧边栏即可看到（标题会在首次打开会话后固化到投影缓存）。

### CLI

```
dsh-codex-import <codex-session-id | rollout.jsonl> [options]

Options:
  --session-id <id>   指定导入后的会话 id（默认自动生成 session-<uuid>）
  --cwd <dir>         会话所属 workspace（默认取 codex 会话自己的 cwd）
  --root <dir>        DSH 会话根目录（默认 ~/.dsh/sessions）
  --dry-run           只解析、构建、打印摘要，不写入
  -h, --help          帮助
```

示例 / examples:

```bash
dsh-codex-import 019feec0-f565-7900-b985-1d6ba3b63a56                    # 导入到 ~/.dsh/sessions
dsh-codex-import --root /tmp/test-sessions 019feec0-...                  # 写入自定义根目录
dsh-codex-import --dry-run 019feec0-...                                  # 试跑
dsh-codex-import ~/backup/rollout-2026-08-11.jsonl --cwd /mnt/e/cell     # 直接给 rollout 文件
```

---

## 它是怎么工作的 / How it works

codex rollout 是两类事件流的 JSONL：`event_msg`（UI 层消息与 turn 生命周期）和 `response_item`（模型 API 条目，含工具调用与输出）。导入器按 codex 的 `turn_id` 分组，每个 codex turn 对应一个 DSH turn（含单个 step），消息与工具按时间戳排序合并：

| codex 事件 | 转换后 DSH 事件 |
| --- | --- |
| `event_msg/task_started` | `turn/start` + `step/start` |
| `event_msg/user_message` | `user/message` |
| `event_msg/agent_message`（commentary / final_answer） | `assistant/message` |
| `response_item/function_call`、`custom_tool_call` | `tool/call` |
| `response_item/function_call_output`、`custom_tool_call_output` | `tool/result` |
| `event_msg/task_complete` / `turn_aborted` | `step/end` + `turn/end` |
| 首条用户消息 | `session/title`（fallback 标题，自动剥离 URL） |

- `web_search_call` 因 codex 不落盘搜索结果而省略；工具调用保留 codex 原生名称与参数。
- 写入的 `session.jsonl.zstd` 与 DSH 持久化层完全一致：**第一帧只有 header 行**，第二帧为全部事件行，`seq` 从 0 连续递增，压缩带 checksum。CLI 写入后自校验（字节级比对 + seq 检查）。
- 产物已用 DSH 真实读取器 `JsonlSessionPersistence.loadStored` 验证通过（无 torn marker）。

---

## 开发 / Development

```bash
npm test                                    # 单元测试（纯 Node，无依赖）
node bin/dsh-codex-import.mjs --dry-run <session-id>   # 用真实 rollout 试跑
node scripts/live.mjs /tmp/test-sessions <session-id>  # 在真实 CommandRuntime 里跑 /codex-import（需 @deepseek-ai 依赖）
```

### 仓库结构 / layout

```
lib/core.js              # 纯转换核心：parseRollout / buildSession / projectKey / deriveTitle
lib/index.js             # 宿主插件：/codex-import 命令（commands + sessionPersistence 服务）
bin/dsh-codex-import.mjs # 独立 CLI：解析 → 构建 → 双帧 zstd 写入 → 自校验
test/                    # 单元测试 + 合成样例 rollout
scripts/live.mjs         # 真实 DSH 服务装配验证脚本
cordis.patch.yml         # bundle 插件行（自动注册）
```

---

## 常见问题 / FAQ

**导入后侧边栏看不到？** 重启 `dsh web` 后刷新；冷会话第一次打开后标题才固化到投影缓存。

**能重复导入同一个 codex 会话吗？** 可以，每次生成新 session id；指定相同 `--session-id` 会因 id 已存在而报错。

**为什么没有 web 搜索结果？** codex 的 rollout 不保存 `web_search_call` 的输出，无法还原，故省略。

**Node 版本要求？** ≥ 22.20（`node:zlib` 的 zstd API）。插件命令形态运行在 DSH 进程内，无此限制。

---

## License

[MIT](LICENSE)
