// Authoritative wire verification: load the session with the REAL DSH
// persistence reader, rebuild the model-visible history with the REAL
// foldSurface + deriveEventMessage, serialize exactly like the REAL DeepSeek
// adapter, and assert no orphan `tool` messages (the 400 root cause).
import { Context } from "@deepseek-ai/cordis";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { deriveEventMessage, foldSurface } from "@deepseek-ai/dsh-session";

const root = process.argv[2];
const sessionId = process.argv[3];
if (!root || !sessionId) {
  console.error("usage: node wire-verify.mjs <sessions-root> <session-id>");
  process.exit(2);
}

const ctx = new Context();
ctx.provide("sessions", { list: () => [], get: () => undefined, on: () => () => {} });
const persistence = new JsonlSessionPersistence(ctx, { root, compression: "zstd", packChunks: true });

const stored = await persistence.loadStored(sessionId);
if (!stored) {
  console.error("FAIL: session not found");
  process.exit(1);
}
const { meta, events, tornMarker } = stored;
console.log(`loaded: ${events.length} events, torn: ${tornMarker ?? "none"}`);

// REAL surface fold + per-node projection (the exact derivation any model
// request is built from)
const surface = foldSurface(events);
const messages = [];
for (const seq of surface.nodes) {
  const msg = deriveEventMessage(events[seq]);
  if (msg) messages.push(msg);
}
console.log(`derived history: ${messages.length} messages from ${surface.nodes.length} surface nodes`);

// Verbatim replica of dsh-llm-deepseek serializeMessages (read from source)
function flattenText(blocks) {
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
}
function serializeAssistant(message) {
  const text = flattenText(message.content);
  const toolCalls = message.content
    .filter((b) => b.type === "tool-call")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: b.arguments } }));
  return { role: "assistant", content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
}
const wire = [];
for (const message of messages) {
  if (message.role === "assistant") {
    wire.push(serializeAssistant(message));
    continue;
  }
  const toolResults = message.content.filter((b) => b.type === "tool-result");
  const text = flattenText(message.content);
  if (text.length > 0 || toolResults.length === 0) wire.push({ role: "user", content: text });
  for (const result of toolResults) {
    wire.push({ role: "tool", tool_call_id: result.toolCallId, content: flattenText(result.content) || "(no output)" });
  }
}

// Assert the OpenAI/DeepSeek rule: each tool message's tool_call_id must be
// declared by the MOST RECENT preceding assistant message (a run of tool
// messages after one multi-tool-call assistant is the canonical valid shape).
let orphans = 0;
let toolCount = 0;
let blockCount = 0;
for (let i = 0; i < wire.length; i++) {
  const m = wire[i];
  if (m.role !== "tool") continue;
  toolCount++;
  // walk back over the tool-message run to the declaring assistant
  let j = i - 1;
  while (j >= 0 && wire[j].role === "tool") j--;
  const prev = wire[j];
  const declared = prev?.role === "assistant" && (prev.tool_calls ?? []).some((c) => c.id === m.tool_call_id);
  if (!declared) {
    orphans++;
    console.error(`ORPHAN tool message at wire index ${i}: call_id ${m.tool_call_id}, preceding role=${prev?.role ?? "none"}`);
  }
}
for (const m of wire) {
  if (m.role === "assistant") blockCount += (m.tool_calls ?? []).length;
}
console.log(`wire messages: ${wire.length} | assistant tool_calls: ${blockCount} | tool messages: ${toolCount} | orphans: ${orphans}`);

if (orphans > 0) process.exit(1);
// A declared call may lack a stored result only when its turn was aborted
// mid-call (DSH synthesizes interrupted closers on the live path); any
// surplus is a hard error.
if (blockCount < toolCount) {
  console.error(`FAIL: more tool results (${toolCount}) than declared calls (${blockCount})`);
  process.exit(1);
}
if (blockCount > toolCount) {
  console.log(`note: ${blockCount - toolCount} declared call(s) have no stored result (interrupted turns) — expected`);
}
console.log("WIRE VERIFY OK — every tool message is declared by a preceding assistant message");
process.exit(0);
