# dsh-codex-import

把 **OpenAI Codex CLI** 的历史对话导入 **DeepSeek Harness (DSH)**，成为可浏览、可搜索的 DSH 会话。

Import **OpenAI Codex CLI** conversation history into **DeepSeek Harness (DSH)** as browsable, searchable sessions.

- 来源：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（`codex resume <session-id>` 回放的原始事件流）
- 目标：`~/.dsh/sessions/<workspace>/<session-id>/session.jsonl.zstd`（DSH 标准会话格式）
- 保留：用户消息、助手回复（commentary + final_answer）、工具调用与输出（`exec_command` / `write_stdin` / `apply_patch` 等）、turn/step 结构、会话标题
- 零运行时依赖（纯 Node，使用 Node ≥22.20 内置的 `node:zlib` zstd 支持）

## 安装

### 作为 DSH 插件（推荐）

```bash
# 从 GitHub 安装（发布后）
dsh plugin --profile web add git+https://github.com/<your-name>/dsh-codex-import.git

# 或本地目录
dsh plugin --profile web add /path/to/dsh-codex-import
```

> git 托管的安装需要先在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 里加上 pnpm 提示的那个包名（仓库的 `prepare` 脚本会被 pnpm 拦截），然后重跑上面的命令。`dsh plugin add` 会在报错信息里给出精确的 key。

因为是 bundle 插件，安装后会自动注册到 profile，重启 `dsh web`（或刷新页面）后即可在会话输入框使用：

```
/codex-import 019feec0-f565-7900-b985-1d6ba3b63a56
/codex-import ~/rollout.jsonl --session-id session-my-import --cwd /mnt/e/cell
```

导入完成会返回新的 session id，刷新侧边栏即可看到（首次打开会话后标题会固化到投影缓存）。

### 作为独立 CLI

```bash
# 直接安装（需要 Node >= 22.20）
npm install -g dsh-codex-import

# 或从仓库直接运行
node bin/dsh-codex-import.mjs 019feec0-f565-7900-b985-1d6ba3b63a56

# 用法
dsh-codex-import <codex-session-id | rollout.jsonl> [--session-id <id>] [--cwd <dir>]
dsh-codex-import --root /tmp/test-sessions <session-id>   # 写入自定义会话根目录
dsh-codex-import --dry-run <session-id>                   # 只解析不写入
```

## 它是怎么工作的

codex rollout 是两类事件流的 JSONL：

| codex 事件 | 转换后 DSH 事件 |
| --- | --- |
| `event_msg/task_started` | `turn/start` + `step/start` |
| `event_msg/user_message` | `user/message` |
| `event_msg/agent_message`（commentary / final_answer） | `assistant/message` |
| `response_item/function_call`、`custom_tool_call` | `tool/call` |
| `response_item/function_call_output`、`custom_tool_call_output` | `tool/result` |
| `event_msg/task_complete` / `turn_aborted` | `step/end` + `turn/end` |
| 首条用户消息 | `session/title`（fallback 标题） |

`web_search_call` 因 codex 不落盘搜索结果而省略；工具调用保留 codex 原生名称与参数。

写入的 `session.jsonl.zstd` 与 DSH 持久化层完全一致：第一帧只有 header 行，第二帧为事件行，seq 从 0 连续递增，压缩带 checksum。CLI 写入后会自校验。

## 开发

```bash
npm test                                  # 运行单元测试（纯 Node，无依赖）
node bin/dsh-codex-import.mjs --dry-run <session-id>   # 用真实 rollout 试跑
node scripts/live.mjs /tmp/test-sessions <session-id>  # 在真实 CommandRuntime 里跑 /codex-import（需要 @deepseek-ai 依赖）
```

## License

MIT
