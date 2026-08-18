/**
 * dsh-codex-import — core conversion logic (pure Node, zero dependencies).
 *
 * Reads a codex CLI rollout JSONL (the file `codex resume <session-id>`
 * replays, kept under ~/.codex/sessions/YYYY/MM/DD/) and rebuilds it as a
 * DeepSeek Harness session: a header plus a seq-contiguous event log
 * (user/message, assistant/message, tool/call, tool/result, turn/step
 * wrappers, session/title).
 *
 * The same core powers two entry points:
 *   - the host plugin command  /codex-import   (lib/index.js)
 *   - the standalone CLI       dsh-codex-import (bin/dsh-codex-import.mjs)
 */

import { randomUUID } from "node:crypto";

export const EVENT_MSG_TYPES = new Set([
  "task_started",
  "user_message",
  "agent_message",
  "task_complete",
  "turn_aborted",
]);
export const RESPONSE_ITEM_TOOL_TYPES = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
]);

/** ISO-8601 timestamp -> epoch milliseconds (codex timestamps are already UTC "Z"). */
function tsMs(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid codex timestamp: ${JSON.stringify(iso)}`);
  return ms;
}

const newUuid = () => randomUUID();

/**
 * Mirror @deepseek-ai/dsh-session-persistence-jsonl `projectKey`: the
 * human-navigable directory name for a session's cwd (separators become
 * "-", other unsafe code units become "~XXXX").
 */
export function projectKey(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("projectKey: cwd must be a non-empty string");
  }
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = cwd[i];
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Parse a codex rollout document into ordered turns.
 *
 * The rollout carries two interleaved streams: `event_msg` (UI-level user /
 * agent messages and turn lifecycle) and `response_item` (model API items,
 * including tool calls and their outputs). Events are grouped into turns by
 * the codex `turn_id` (task_started events open turns; response_item payloads
 * carry the owning turn in `internal_chat_message_metadata_passthrough`).
 *
 * @param {string} text - full rollout JSONL text.
 * @returns {{ turns: Turn[], meta: object }} turns plus the session_meta payload.
 */
export function parseRollout(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip unparsable lines (torn tail / non-JSON noise)
    }
  }

  /** @type {import("./types.js").Turn[]} */
  const turns = [];
  const turnIndex = new Map(); // codex turn_id -> turn index
  let current = null;
  let meta = null;

  for (const ev of events) {
    const type = ev?.type;
    const payload = ev?.payload ?? {};
    if (type === "session_meta") {
      meta = payload;
      continue;
    }
    if (type === "event_msg") {
      const ptype = payload.type;
      const ts = tsMs(ev.timestamp);
      if (ptype === "task_started") {
        current = {
          index: turns.length,
          turnId: payload.turn_id ?? null,
          startTs: ts,
          endTs: ts,
          messages: [], // {ts, kind: "user"|"assistant", text}
          tools: [], // {ts, kind: "call"|"result", payload}
          endReason: null,
        };
        turns.push(current);
        if (payload.turn_id) turnIndex.set(payload.turn_id, current.index);
      } else if (ptype === "user_message" || ptype === "agent_message") {
        if (current === null) {
          current = {
            index: turns.length,
            turnId: null,
            startTs: ts,
            endTs: ts,
            messages: [],
            tools: [],
            endReason: null,
          };
          turns.push(current);
        }
        current.messages.push({
          ts,
          kind: ptype === "user_message" ? "user" : "assistant",
          text: payload.message ?? "",
        });
        current.endTs = Math.max(current.endTs, ts);
      } else if (ptype === "task_complete") {
        if (current !== null) {
          current.endReason = "completed";
          current.endTs = Math.max(current.endTs, ts);
        }
        current = null;
      } else if (ptype === "turn_aborted") {
        if (current !== null) {
          current.endReason = "interrupted";
          current.endTs = Math.max(current.endTs, ts);
        }
        current = null;
      }
    } else if (type === "response_item") {
      const ptype = payload.type;
      if (!RESPONSE_ITEM_TOOL_TYPES.has(ptype)) continue;
      const ts = tsMs(ev.timestamp);
      const tid = payload.internal_chat_message_metadata_passthrough?.turn_id;
      const idx = tid === undefined ? undefined : turnIndex.get(tid);
      if (idx === undefined) continue; // orphan tool event, not in this log
      const turn = turns[idx];
      turn.tools.push({
        ts,
        kind: ptype === "function_call" || ptype === "custom_tool_call" ? "call" : "result",
        payload,
      });
      turn.endTs = Math.max(turn.endTs, ts);
    }
  }

  for (const turn of turns) {
    if (turn.endReason === null) turn.endReason = "interrupted";
  }
  return { turns, meta };
}

/**
 * Deterministic fallback title: clean the first prompt, strip a leading URL
 * (even when glued to CJK text), cap at 60 UTF-8 bytes.
 */
export function deriveTitle(firstPrompt) {
  let text = String(firstPrompt ?? "").replace(/\s+/gu, " ").trim();
  text = text.replace(/https?:\/\/\S*?(?=[\u4e00-\u9fff\s]|$)/u, "").trim();
  text = text || String(firstPrompt ?? "").replace(/\s+/gu, " ").trim();
  text = text || "Imported codex session";
  if (Buffer.byteLength(text, "utf8") <= 60) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const bytes = Buffer.byteLength(ch, "utf8");
    if (used + bytes > 60) break;
    out += ch;
    used += bytes;
  }
  return out;
}

/** Whether a codex tool output line indicates a failing exit. */
function inferError(output) {
  const lines = String(output ?? "").split("\n").filter((l) => l.includes("Process exited with code"));
  if (lines.length === 0) return false;
  return !lines[lines.length - 1].includes("code 0");
}

/** Accumulate DSH session events with contiguous seq numbers. */
class SessionBuilder {
  constructor({ sessionId, cwd, createdAt }) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.createdAt = createdAt;
    /** @type {object[]} */
    this.events = [];
    this.seq = 0;
    this.firstUserSeq = null;
    this.emittedCalls = new Set();
    this.callSeqs = new Map();
  }

  ev(type, data, time, extra = {}) {
    const event = { type, seq: this.seq, time, data, ...extra };
    this.events.push(event);
    return this.seq++;
  }

  header() {
    return {
      type: "session",
      version: 0,
      id: this.sessionId,
      createdAt: this.createdAt,
      cwd: this.cwd,
      delegationDepth: 0,
      agentPreset: "minimal",
    };
  }

  setup(time) {
    this.ev("permission/preset", { preset: "workspace-write" }, time);
    this.ev("sandbox/mode", { mode: "workspace-write" }, time);
    this.ev("approval/policy", { policy: "ask" }, time);
  }

  userMessage(text, time) {
    const seq = this.ev(
      "user/message",
      {
        content: [{ type: "text", text }],
        source: { kind: "user", rpcId: newUuid(), clientTimeZone: "Asia/Shanghai" },
        role: "user",
        id: newUuid(),
      },
      time,
      { surfaceOp: "append" },
    );
    if (this.firstUserSeq === null) this.firstUserSeq = seq;
  }

  /**
   * Emit an assistant message. The message carries its tool calls as
   * `tool-call` content blocks (the model-visible surface derives
   * `tool_calls` from those blocks, so each following `tool/result` has a
   * preceding assistant declaring its call id). Messages with neither text
   * nor blocks are not emitted.
   * @param {string} text
   * @param {number} time
   * @param {number} turn
   * @param {number} step
   * @param {Array<{type:"tool-call",id:string,name:string,arguments:string}>} [toolBlocks]
   */
  assistantMessage(text, time, turn, step, toolBlocks = []) {
    const content = [];
    if (text.trim() !== "") content.push({ type: "text", text });
    content.push(...toolBlocks);
    if (content.length === 0) return;
    this.ev(
      "assistant/message",
      {
        turn,
        step,
        message: {
          role: "assistant",
          content,
          source: { kind: "model", provider: "codex", model: "codex" },
          id: newUuid(),
        },
      },
      time,
      { surfaceOp: "append" },
    );
  }

  toolCall(callId, name, argumentsRaw, time, turn, step) {
    const seq = this.ev(
      "tool/call",
      { turn, step, callId, name, arguments: argumentsRaw },
      time,
    );
    this.emittedCalls.add(callId);
    this.callSeqs.set(callId, seq);
    return seq;
  }

  toolResult(callId, output, isError, time, turn, step) {
    this.ev(
      "tool/result",
      {
        turn,
        step,
        message: {
          source: { kind: "tool", callId },
          content: [
            {
              type: "tool-result",
              toolCallId: callId,
              content: [{ type: "text", text: output }],
              isError,
            },
          ],
          role: "user",
          id: newUuid(),
        },
      },
      time,
      { sourceEventSeqs: [this.callSeqs.get(callId)], surfaceOp: "append" },
    );
  }

  /**
   * Synthesize an interrupted tool result for a declared call whose codex
   * output never arrived (turn aborted mid-call). Mirrors DSH's own
   * `interruptedTurnClosers` so the LLM history always answers every
   * assistant `tool_calls` with a tool message.
   */
  interruptedToolResult(callId, callSeq, time, turn, step) {
    const seq = this.seq;
    this.ev(
      "tool/result",
      {
        turn,
        step,
        message: {
          id: `interrupted-tool-result-${callId}-${seq}`,
          role: "user",
          source: { kind: "tool", callId },
          content: [
            {
              type: "tool-result",
              toolCallId: callId,
              isError: true,
              content: [
                {
                  type: "text",
                  text: "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.",
                },
              ],
            },
          ],
        },
        error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" },
      },
      time,
      { sourceEventSeqs: [callSeq], surfaceOp: "append" },
    );
  }

  turnStart(turn, time) {
    this.ev("turn/start", { turn }, time);
  }

  stepStart(turn, step, time) {
    this.ev("step/start", { turn, step }, time);
  }

  stepEnd(turn, step, time) {
    this.ev("step/end", { turn, step }, time);
  }

  turnEnd(turn, reason, time) {
    this.ev("turn/end", { turn, reason: { kind: reason } }, time);
  }

  sessionTitle(title, time) {
    this.ev(
      "session/title",
      {
        title,
        messageSeqs: this.firstUserSeq === null ? [] : [this.firstUserSeq],
        source: { kind: "fallback" },
      },
      time,
    );
  }
}

/**
 * Convert parsed turns into a DSH session header + event list.
 *
 * One codex turn maps to one DSH turn with a single step. The model-visible
 * surface derives the LLM history from only three event types —
 * `user/message`, `assistant/message`, `tool/result` — and the provider
 * requires every `tool/result` to be preceded by an assistant declaring that
 * call id (as a `tool-call` block) AND every declared call to be answered.
 * Each codex tool call is therefore attached as a `tool-call` block to the
 * nearest preceding assistant message (a synthetic assistant message carrying
 * only the tool-call block is emitted when the call has no commentary before
 * it), and a declared call whose codex output never arrived (turn aborted
 * mid-call) is closed with a synthetic interrupted `tool/result`. The
 * standalone `tool/call` events remain for the invariant checker and the UI
 * trajectory.
 *
 * @param {import("./types.js").Turn[]} turns
 * @param {{ sessionId: string, cwd: string, createdAt?: number }} options
 * @returns {{ header: object, events: object[] }}
 */
export function buildSession(turns, { sessionId, cwd, createdAt }) {
  const created = createdAt ?? (turns.length > 0 ? turns[0].startTs : Date.now());
  const builder = new SessionBuilder({ sessionId, cwd, createdAt: created });
  builder.setup(created);

  let firstPrompt = "";
  for (let turnNo = 0; turnNo < turns.length; turnNo++) {
    const turn = turns[turnNo];
    const number = turnNo + 1;
    const step = 1;
    builder.turnStart(number, turn.startTs);
    builder.stepStart(number, step, turn.startTs);

    // Ordered timeline of this turn's messages and tool events.
    const items = [
      ...turn.messages.map((m) => ({ group: "message", ...m })),
      ...turn.tools.map((t) => ({ group: "tool", ...t })),
    ].sort((a, b) => a.ts - b.ts);

    // Fold tool calls onto assistant messages: each call becomes a tool-call
    // content block of the nearest preceding assistant message; a call with no
    // preceding assistant gets a synthetic one carrying just the block.
    const ordered = [];
    let lastAssistant = null;
    for (const item of items) {
      if (item.group === "message") {
        ordered.push(item);
        if (item.kind === "assistant") lastAssistant = item;
      } else if (item.kind === "call") {
        if (lastAssistant === null) {
          lastAssistant = {
            group: "message",
            kind: "assistant",
            ts: item.ts,
            text: "",
            toolBlocks: [],
          };
          ordered.push(lastAssistant);
        }
        (lastAssistant.toolBlocks ??= []).push(toolBlockFor(item.payload));
        ordered.push(item);
      } else {
        ordered.push(item);
      }
    }

    const turnCalls = new Set(); // callIds emitted in this turn
    const turnResults = new Set(); // callIds answered in this turn
    for (const item of ordered) {
      if (item.group === "message") {
        if (item.kind === "user") {
          if (firstPrompt === "") firstPrompt = item.text;
          builder.userMessage(item.text, item.ts);
        } else {
          builder.assistantMessage(item.text, item.ts, number, step, item.toolBlocks ?? []);
        }
        continue;
      }
      const payload = item.payload;
      const ptype = payload.type;
      if (ptype === "function_call") {
        turnCalls.add(payload.call_id);
        builder.toolCall(
          payload.call_id,
          payload.name ?? "exec_command",
          payload.arguments ?? "{}",
          item.ts,
          number,
          step,
        );
      } else if (ptype === "custom_tool_call") {
        turnCalls.add(payload.call_id);
        builder.toolCall(
          payload.call_id,
          payload.name ?? "custom_tool",
          JSON.stringify({ input: payload.input ?? "" }),
          item.ts,
          number,
          step,
        );
      } else if (ptype === "function_call_output" || ptype === "custom_tool_call_output") {
        const callId = payload.call_id;
        if (builder.emittedCalls.has(callId)) {
          turnResults.add(callId);
          builder.toolResult(callId, payload.output ?? "", inferError(payload.output), item.ts, number, step);
        }
      }
    }

    // Close declared calls that codex never answered (aborted mid-call): the
    // LLM provider rejects an assistant tool_calls message with fewer tool
    // responses than declared ids, so synthesize DSH-style interrupted results.
    for (const callId of turnCalls) {
      if (!turnResults.has(callId)) {
        builder.interruptedToolResult(callId, builder.callSeqs.get(callId), turn.endTs, number, step);
      }
    }

    builder.stepEnd(number, step, turn.endTs);
    builder.turnEnd(number, turn.endReason ?? "interrupted", turn.endTs);
  }

  const title = deriveTitle(firstPrompt);
  builder.sessionTitle(title, turns.length > 0 ? turns[turns.length - 1].endTs : created);
  return { header: builder.header(), events: builder.events };
}

/** Build the `tool-call` content block for a codex call payload. */
function toolBlockFor(payload) {
  if (payload.type === "function_call") {
    return {
      type: "tool-call",
      id: payload.call_id,
      name: payload.name ?? "exec_command",
      arguments: payload.arguments ?? "{}",
    };
  }
  // custom_tool_call (apply_patch and friends)
  return {
    type: "tool-call",
    id: payload.call_id,
    name: payload.name ?? "custom_tool",
    arguments: JSON.stringify({ input: payload.input ?? "" }),
  };
}
