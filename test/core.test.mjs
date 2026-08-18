import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CHECKPOINT_PREAMBLE,
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  buildSession,
  deriveTitle,
  estimateMessageTokens,
  estimateSessionTokens,
  estimateTokens,
  parseRollout,
  projectKey,
  selectKeepCount,
  serializeWire,
  surfaceMessages,
} from "../lib/core.js";
import { parseArgs, tokenize } from "../lib/index.js";
import { serializeSession, verifySession } from "../bin/dsh-codex-import.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "fixtures", "sample-rollout.jsonl"), "utf8");

test("projectKey mirrors the dsh persistence encoding", () => {
  assert.equal(projectKey("/mnt/e/cell"), "--mnt-e-cell--");
  assert.equal(projectKey("/mnt/e/ctf/PWN/class1"), "--mnt-e-ctf-PWN-class1--");
});

test("parseRollout groups the fixture into one turn", () => {
  const { turns, meta } = parseRollout(fixture);
  assert.equal(turns.length, 1);
  assert.equal(meta.cwd, "/mnt/e/cell");
  const turn = turns[0];
  assert.equal(turn.endReason, "completed");
  assert.ok(turn.messages.some((m) => m.kind === "user"));
  assert.ok(turn.messages.some((m) => m.kind === "assistant"));
  assert.ok(turn.tools.some((t) => t.kind === "call"));
  assert.ok(turn.tools.some((t) => t.kind === "result"));
});

test("buildSession produces a valid, invariant-clean event log", () => {
  const { turns } = parseRollout(fixture);
  const { header, events } = buildSession(turns, {
    sessionId: "session-test-fixture",
    cwd: "/mnt/e/cell",
    createdAt: turns[0].startTs,
  });
  assert.equal(header.type, "session");
  assert.equal(header.id, "session-test-fixture");
  assert.equal(header.cwd, "/mnt/e/cell");

  // seq contiguous
  events.forEach((e, i) => assert.equal(e.seq, i));

  // turn/step nesting invariant trace
  let openTurn = null;
  let openStep = null;
  const pending = new Set();
  for (const e of events) {
    const d = e.data;
    if (e.type === "turn/start") {
      assert.equal(openTurn, null);
      openTurn = d.turn;
    } else if (e.type === "turn/end") {
      assert.equal(openTurn, d.turn);
      assert.equal(openStep, null);
      openTurn = null;
    } else if (e.type === "step/start") {
      assert.equal(openStep, null);
      openStep = d.step;
    } else if (e.type === "step/end") {
      assert.equal(openStep, d.step);
      openStep = null;
      pending.clear();
    } else if (e.type === "assistant/message" || e.type === "tool/call") {
      assert.equal(openTurn, d.turn);
      assert.equal(openStep, d.step);
      if (e.type === "tool/call") pending.add(d.callId);
    } else if (e.type === "tool/result") {
      assert.equal(e.surfaceOp, "append");
      assert.equal(openTurn, d.turn);
      assert.equal(openStep, d.step);
      assert.ok(pending.has(d.message.source.callId));
    } else if (e.type === "user/message") {
      assert.equal(d.source.kind, "user");
    }
  }
  assert.equal(openTurn, null);

  // tool calls: exec_command from function_call + apply_patch from custom_tool_call
  const calls = events.filter((e) => e.type === "tool/call");
  assert.ok(calls.some((c) => c.data.name === "exec_command"));
  assert.ok(calls.some((c) => c.data.name === "apply_patch"));
  const results = events.filter((e) => e.type === "tool/result");
  assert.equal(results.length, calls.length);

  // title derived from the first prompt
  const title = events.findLast((e) => e.type === "session/title");
  assert.ok(title.data.title.length > 0);
});

test("serialize/verify round-trips the two-frame zstd layout", () => {
  const { turns } = parseRollout(fixture);
  const { header, events } = buildSession(turns, {
    sessionId: "session-roundtrip",
    cwd: "/mnt/e/cell",
    createdAt: turns[0].startTs,
  });
  const bytes = serializeSession(header, events);
  const check = verifySession("session-roundtrip", bytes, header, events);
  assert.equal(check.events, events.length);
  assert.equal(check.header.cwd, "/mnt/e/cell");
});

/**
 * Replicate the DSH model-visible surface fold (deriveEventMessage over
 * surfaceOp append nodes) plus the DeepSeek chat-completions serializer:
 * assistant tool-call blocks become `tool_calls`, tool-result blocks become
 * standalone `tool` messages. Returns the wire message list.
 */
function wireMessages(events) {
  const wire = [];
  for (const e of events) {
    if (e.surfaceOp !== "append") continue;
    if (e.type === "user/message") {
      wire.push({ role: "user", content: e.data.content });
    } else if (e.type === "assistant/message") {
      const msg = e.data.message;
      if (msg.content.length === 0) continue;
      const toolCalls = msg.content
        .filter((b) => b.type === "tool-call")
        .map((b) => ({ id: b.id, name: b.name, arguments: b.arguments }));
      wire.push({ role: "assistant", content: msg.content, toolCalls });
    } else if (e.type === "tool/result") {
      for (const block of e.data.message.content) {
        if (block.type === "tool-result") {
          wire.push({ role: "tool", tool_call_id: block.toolCallId });
        }
      }
    }
  }
  return wire;
}

test("every tool message is preceded by an assistant declaring its call id", () => {
  const { turns } = parseRollout(fixture);
  const { events } = buildSession(turns, {
    sessionId: "session-wire",
    cwd: "/mnt/e/cell",
    createdAt: turns[0].startTs,
  });

  const wire = wireMessages(events);
  const toolMessages = wire.filter((m) => m.role === "tool");
  const declared = wire
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.toolCalls.map((c) => c.id));

  // every assistant tool-call block resolves to a tool result and vice versa
  assert.equal(declared.length, toolMessages.length);

  // OpenAI/DeepSeek rule: each tool message's id must be declared by the most
  // recent preceding assistant (a run of tool messages after one assistant
  // with multiple tool_calls is the canonical valid shape).
  for (let i = 0; i < wire.length; i++) {
    if (wire[i].role !== "tool") continue;
    let j = i - 1;
    while (j >= 0 && wire[j].role === "tool") j--;
    const prev = wire[j];
    assert.ok(prev, `tool message at ${i} has no preceding assistant`);
    assert.equal(prev.role, "assistant", `tool message at ${i} not preceded by assistant`);
    assert.ok(
      prev.toolCalls.some((c) => c.id === wire[i].tool_call_id),
      `tool message ${wire[i].tool_call_id} not declared by preceding assistant`,
    );
  }
});

test("tool calls without a preceding commentary still get a declaring assistant", () => {
  // synthetic: a user message followed directly by a tool call (no commentary)
  const rollout = [
    { timestamp: "2026-08-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/mnt/e/cell" } },
    { timestamp: "2026-08-01T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
    { timestamp: "2026-08-01T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "run it" } },
    {
      timestamp: "2026-08-01T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: "{\"cmd\":\"pwd\"}",
        call_id: "call_00_nocommentary",
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      },
    },
    {
      timestamp: "2026-08-01T00:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_00_nocommentary",
        output: "Process exited with code 0\n/mnt/e/cell\n",
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      },
    },
    { timestamp: "2026-08-01T00:00:05.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } },
  ].map((l) => JSON.stringify(l)).join("\n");

  const { turns } = parseRollout(rollout);
  const { events } = buildSession(turns, { sessionId: "session-synth", cwd: "/mnt/e/cell" });

  const wire = wireMessages(events);
  const toolIdx = wire.findIndex((m) => m.role === "tool");
  assert.ok(toolIdx > 0);
  assert.equal(wire[toolIdx - 1].role, "assistant");
  assert.equal(wire[toolIdx - 1].toolCalls[0].id, "call_00_nocommentary");
});

test("declared calls with no stored output get a synthesized interrupted result", () => {
  // synthetic: a call is emitted but the turn is aborted before any output
  const rollout = [
    { timestamp: "2026-08-01T00:00:00.000Z", type: "session_meta", payload: { cwd: "/mnt/e/cell" } },
    { timestamp: "2026-08-01T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
    { timestamp: "2026-08-01T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "go" } },
    {
      timestamp: "2026-08-01T00:00:03.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "running it", phase: "commentary" },
    },
    {
      timestamp: "2026-08-01T00:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: "{\"cmd\":\"long-task\"}",
        call_id: "call_00_aborted",
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      },
    },
    { timestamp: "2026-08-01T00:00:05.000Z", type: "event_msg", payload: { type: "turn_aborted", turn_id: "t1" } },
  ].map((l) => JSON.stringify(l)).join("\n");

  const { turns } = parseRollout(rollout);
  const { events } = buildSession(turns, { sessionId: "session-abort", cwd: "/mnt/e/cell" });

  // every declared call is answered (synthesized interrupted result)
  const wire = wireMessages(events);
  const declared = wire
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.toolCalls.map((c) => c.id));
  const toolIds = wire.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual([...new Set(toolIds)], [...new Set(declared)]);

  // the synthesized result carries the interrupted flag/message
  const synth = events.find((e) => e.type === "tool/result" && e.data.message.content[0].isError === true);
  assert.ok(synth, "expected a synthesized interrupted tool/result");
  assert.ok(synth.data.message.content[0].content[0].text.includes("interrupted"));
  assert.equal(synth.data.error.code, "TOOL_OUTCOME_UNKNOWN");
});

test("deriveTitle strips a leading URL glued to CJK text", () => {
  assert.equal(
    deriveTitle("https://www.kaggle.com/competitions/foo/overview我现在要打这个比赛，帮我规划一下任务"),
    "我现在要打这个比赛，帮我规划一下任务",
  );
  assert.equal(deriveTitle("hello world"), "hello world");
});

test("tokenize/parseArgs handle flags and quoted values", () => {
  assert.deepEqual(tokenize(`019feec0 "a b" --cwd /mnt/e/cell`), ["019feec0", "a b", "--cwd", "/mnt/e/cell"]);
  const parsed = parseArgs(`019feec0-f565 --session-id session-x --cwd "/mnt/e/cell" --max-turns 40`);
  assert.equal(parsed.target, "019feec0-f565");
  assert.equal(parsed.sessionId, "session-x");
  assert.equal(parsed.cwd, "/mnt/e/cell");
  assert.equal(parsed.maxTurns, 40);
  assert.throws(() => parseArgs(`019feec0 --max-turns abc`), /positive integer/);
});

test("buildSession maxTurns keeps only the newest turns but the original title", () => {
  const { turns } = parseRollout(fixture);
  const full = buildSession(turns, { sessionId: "session-full", cwd: "/mnt/e/cell" });
  const tail = buildSession(turns, { sessionId: "session-tail", cwd: "/mnt/e/cell", maxTurns: 1 });

  const fullTurns = full.events.filter((e) => e.type === "turn/start").length;
  const tailTurns = tail.events.filter((e) => e.type === "turn/start").length;
  assert.equal(fullTurns, turns.length);
  assert.equal(tailTurns, 1);

  // title comes from the FULL conversation, not the first retained turn
  const titleOf = (s) => s.events.find((e) => e.type === "session/title").data.title;
  assert.equal(titleOf(full), titleOf(tail));

  // an explicit title override wins over derivation
  const named = buildSession(turns, {
    sessionId: "session-named",
    cwd: "/mnt/e/cell",
    maxTurns: 1,
    title: "cell 比赛（最近80轮·可继续）",
  });
  assert.equal(titleOf(named), "cell 比赛（最近80轮·可继续）");

  // the tail remains wire-valid
  const wire = wireMessages(tail.events);
  const declared = wire
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.toolCalls.map((c) => c.id));
  const toolIds = wire.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual([...new Set(toolIds)], [...new Set(declared)]);
});

test("estimateTokens prices Han characters ~1 token and is conservative", () => {
  assert.ok(estimateTokens("你好世界") >= 4, "CJK chars price at least 1 token each");
  assert.ok(estimateTokens("a".repeat(100)) >= 50, "ASCII prices >= 1 token per 2 chars");
  // CJK of the same length prices higher than ASCII
  assert.ok(estimateTokens("你好你好你好你好") > estimateTokens("abcdabcd"));
  assert.equal(estimateTokens(""), 0);
});

test("surfaceMessages folds exactly the model-visible events", () => {
  const { turns } = parseRollout(fixture);
  const { events } = buildSession(turns, { sessionId: "session-s", cwd: "/mnt/e/cell" });
  const surface = surfaceMessages(events);
  assert.ok(surface.length >= 3, "expected user, assistant, and tool-result messages on the surface");
  assert.ok(surface.some((m) => m.role === "user"), "has a user message");
  assert.ok(
    surface.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool-call")),
    "assistant messages carry tool-call blocks",
  );
  assert.ok(
    surface.some((m) => m.role === "user" && m.content.some((b) => b.type === "tool-result")),
    "tool results are user messages with tool-result blocks",
  );
  // every surface message contributes to the session estimate
  assert.equal(
    estimateSessionTokens(events),
    surface.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
  );
});

test("selectKeepCount keeps only the newest turns under a budget", () => {
  // two-turn synthetic rollout: turn 1 has a long user text, turn 2 is short
  const mk = (id, ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload });
  const rollout = [
    mk("m", "2026-08-01T00:00:00.000Z", "session_meta", { cwd: "/mnt/e/cell" }),
    mk("m", "2026-08-01T00:00:01.000Z", "event_msg", { type: "task_started", turn_id: "t1" }),
    mk("m", "2026-08-01T00:00:02.000Z", "event_msg", { type: "user_message", message: "x".repeat(4000) }),
    mk("m", "2026-08-01T00:00:03.000Z", "event_msg", { type: "agent_message", message: "ok", phase: "commentary" }),
    mk("m", "2026-08-01T00:00:04.000Z", "event_msg", { type: "task_complete", turn_id: "t1" }),
    mk("m", "2026-08-01T00:00:05.000Z", "event_msg", { type: "task_started", turn_id: "t2" }),
    mk("m", "2026-08-01T00:00:06.000Z", "event_msg", { type: "user_message", message: "hi" }),
    mk("m", "2026-08-01T00:00:07.000Z", "event_msg", { type: "agent_message", message: "hello", phase: "commentary" }),
    mk("m", "2026-08-01T00:00:08.000Z", "event_msg", { type: "task_complete", turn_id: "t2" }),
  ].join("\n");
  const { turns } = parseRollout(rollout);
  const { events } = buildSession(turns, { sessionId: "session-2", cwd: "/mnt/e/cell" });
  const tiny = selectKeepCount(events, 10);
  assert.equal(tiny.keep, 1, "tiny budget keeps only the newest turn");
  const huge = selectKeepCount(events, 1e9);
  assert.equal(huge.keep, 2, "huge budget keeps everything");
});

test("buildSession with summary lands a compaction checkpoint before the kept turns", () => {
  const { turns } = parseRollout(fixture);
  const summary = [{ type: "text", text: "## Current Work\n- imported the codex session" }];
  const { events } = buildSession(turns, {
    sessionId: "session-cp",
    cwd: "/mnt/e/cell",
    maxTurns: 1,
    summary,
    compactionId: "cp-1",
  });

  const checkpoint = events.find((e) => e.type === "user/message" && e.data?.source?.plugin === "compact");
  assert.ok(checkpoint, "expected a compaction checkpoint user message");
  assert.equal(checkpoint.data.source.compactionId, "cp-1");
  const blocks = checkpoint.data.content;
  assert.equal(blocks[0].type, "text");
  assert.ok(blocks[0].text.startsWith(CHECKPOINT_PREAMBLE));
  assert.ok(blocks[0].text.includes(SUMMARY_OPEN_TAG));
  assert.equal(blocks[blocks.length - 1].text, SUMMARY_CLOSE_TAG);

  // the checkpoint is the FIRST model-visible node
  const surface = surfaceMessages(events);
  assert.equal(surface[0].source.plugin, "compact");

  // the retained turn is wire-valid (declared == answered)
  const wire = wireMessages(events);
  const declared = wire
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.toolCalls.map((c) => c.id));
  const toolIds = wire.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual([...new Set(toolIds)], [...new Set(declared)]);
});

test("serializeWire expands tool-call blocks and tool-result blocks like the adapter", () => {
  const { turns } = parseRollout(fixture);
  const { events } = buildSession(turns, { sessionId: "session-w", cwd: "/mnt/e/cell" });
  const wire = serializeWire(surfaceMessages(events));
  // every tool message is declared by the nearest preceding assistant
  let lastAssistantCalls = new Set();
  for (const msg of wire) {
    if (msg.role === "assistant") {
      lastAssistantCalls = new Set((msg.tool_calls ?? []).map((c) => c.id));
    } else if (msg.role === "tool") {
      assert.ok(lastAssistantCalls.has(msg.tool_call_id), `tool ${msg.tool_call_id} must be declared`);
    }
  }
});
