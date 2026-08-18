import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildSession, deriveTitle, parseRollout, projectKey } from "../lib/core.js";
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

test("deriveTitle strips a leading URL glued to CJK text", () => {
  assert.equal(
    deriveTitle("https://www.kaggle.com/competitions/foo/overview我现在要打这个比赛，帮我规划一下任务"),
    "我现在要打这个比赛，帮我规划一下任务",
  );
  assert.equal(deriveTitle("hello world"), "hello world");
});

test("tokenize/parseArgs handle flags and quoted values", () => {
  assert.deepEqual(tokenize(`019feec0 "a b" --cwd /mnt/e/cell`), ["019feec0", "a b", "--cwd", "/mnt/e/cell"]);
  const parsed = parseArgs(`019feec0-f565 --session-id session-x --cwd "/mnt/e/cell"`);
  assert.equal(parsed.target, "019feec0-f565");
  assert.equal(parsed.sessionId, "session-x");
  assert.equal(parsed.cwd, "/mnt/e/cell");
});
