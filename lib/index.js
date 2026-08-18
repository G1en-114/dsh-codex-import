/**
 * dsh-codex-import — host plugin.
 *
 * Registers the `/codex-import` command: import a codex CLI rollout
 * conversation as a NEW DeepSeek Harness session in the current workspace.
 *
 *   /codex-import <codex-session-id | rollout.jsonl> [--session-id <id>] [--cwd <dir>]
 *
 * The imported session is persisted through the standard sessionPersistence
 * service and appears in the web GUI sidebar on the next refresh.
 *
 * @module dsh-codex-import
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  COMPACTION_INSTRUCTION,
  buildSession,
  estimateSessionTokens,
  parseRollout,
  selectKeepCount,
  surfaceMessages,
} from "./core.js";

export const name = "codex-import";
export const inject = ["commands", "sessionPersistence"];

const USAGE =
  "Usage: /codex-import <codex session id | rollout.jsonl path> [--session-id <id>] [--cwd <dir>] [--max-turns <n>] [--title <text>] [--no-compact]";

/**
 * Locate a codex rollout file. Accepts either a direct path to a rollout
 * JSONL or a codex session id (the rollout filename embeds the id, e.g.
 * rollout-2026-08-11T10-57-30-019feec0-....jsonl), searched under
 * ~/.codex/sessions.
 * @param {string} arg - path or codex session id.
 * @returns {Promise<string | null>} resolved rollout path, or null.
 */
export async function resolveRolloutPath(arg) {
  if (typeof arg !== "string" || arg.trim() === "") return null;
  const trimmed = arg.trim();

  // Direct file path
  const asPath = resolve(trimmed);
  try {
    const st = await stat(asPath);
    if (st.isFile() && trimmed.endsWith(".jsonl")) return asPath;
  } catch {
    /* not a file — try as a session id below */
  }

  // Codex session id -> search ~/.codex/sessions/**/rollout-*-<id>.jsonl
  const root = join(homedir(), ".codex", "sessions");
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl") &&
        entry.name.includes(trimmed)
      ) {
        return full;
      }
    }
  }
  return null;
}

/** Split a command line into tokens (whitespace-separated, quotes honored). */
export function tokenize(input) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of input.matchAll(re)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/** Parse raw command input into { target, sessionId, cwd, maxTurns, title, noCompact }. */
export function parseArgs(rawInput) {
  const tokens = tokenize(rawInput);
  const out = { target: null, sessionId: null, cwd: null, maxTurns: null, title: null, noCompact: false };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--session-id") out.sessionId = tokens[++i] ?? null;
    else if (tok === "--cwd") out.cwd = tokens[++i] ?? null;
    else if (tok === "--title") out.title = tokens[++i] ?? null;
    else if (tok === "--no-compact") out.noCompact = true;
    else if (tok === "--max-turns") {
      const n = Number(tokens[++i]);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("--max-turns must be a positive integer");
      out.maxTurns = n;
    } else if (tok === "--help" || tok === "-h") out.help = true;
    else if (tok.startsWith("--")) throw new Error(`unknown option: ${tok}`);
    else if (out.target === null) out.target = tok;
  }
  return out;
}

/**
 * Execute one import. Exposed separately so the standalone CLI can share it.
 * @param {object} deps
 * @param {object} deps.persistence - ctx.sessionPersistence (or a test double).
 * @param {string} deps.rolloutPath - resolved rollout file.
 * @param {string} deps.cwd - workspace cwd for the new session.
 * @param {string} [deps.sessionId] - desired session id (default: generated).
 * @param {number} [deps.maxTurns] - keep only the newest N turns.
 * @returns {Promise<{sessionId: string, events: number, turns: number, title: string}>}
 */
export async function importRollout({ persistence, rolloutPath, cwd, sessionId, maxTurns, title }) {
  const text = await readFile(rolloutPath, "utf8");
  const { turns, meta } = parseRollout(text);
  if (turns.length === 0) throw new Error(`no turns found in ${rolloutPath}`);

  const targetCwd = cwd ?? meta?.cwd;
  if (typeof targetCwd !== "string" || targetCwd.length === 0) {
    throw new Error("cannot determine the session cwd: pass --cwd <dir>");
  }

  const id = sessionId ?? `session-${randomUUID()}`;
  const createdAt = turns[0].startTs;
  const { header, events } = buildSession(turns, {
    sessionId: id,
    cwd: targetCwd,
    createdAt,
    maxTurns,
    title,
  });

  await persistence.create(header);
  await persistence.append(id, events);

  const finalTitle = events.findLast((e) => e.type === "session/title")?.data?.title ?? "";
  const keptTurns = maxTurns === undefined ? turns.length : Math.min(maxTurns, turns.length);
  return { sessionId: id, events: events.length, turns: keptTurns, title: finalTitle };
}

/**
 * Summarize a span of model-visible messages with the DSH LLM service,
 * mirroring @deepseek-ai/dsh-compaction-basic's summarizer call: the
 * conversation prefix followed by the compaction instruction, a small
 * completion budget (the input dominates), text-only output.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} options
 * @param {Array<object>} options.messages - derived messages of the dropped span.
 * @param {string} options.provider
 * @param {string} options.model
 * @param {number} [options.maxTokens]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{type:"text",text:string}>>} summary text blocks.
 */
export async function summarizeWithLlm(ctx, { messages, provider, model, maxTokens = 8192, signal }) {
  const { BlockAssembler, createUserMessage } = await import("@deepseek-ai/dsh-llm");
  const assembler = new BlockAssembler();
  const request = [
    ...messages,
    createUserMessage({
      content: [{ type: "text", text: COMPACTION_INSTRUCTION }],
      source: { kind: "plugin", plugin: "dsh-codex-import" },
    }),
  ];
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    messages: request,
    maxTokens,
    purpose: "compaction",
    ...signal === void 0 ? {} : { signal },
  })) {
    assembler.push(chunk);
  }
  const finish = assembler.finish;
  if (finish?.kind === "error" || finish?.kind === "aborted" || finish?.kind === "max-tokens") {
    throw new Error(`summarization did not complete: ${finish.failure?.message ?? finish.kind}`);
  }
  const summary = assembler.blocks().filter((block) => block.type === "text");
  if (!summary.some((block) => block.text.trim().length > 0)) {
    throw new Error("summarization produced no text content");
  }
  return summary;
}

/**
 * Import with import-time auto-compaction: when the full model-visible
 * history would exceed the model's context budget, summarize the oldest
 * turns with the DSH LLM and land a compaction-checkpoint user message
 * before the newest turns (kept verbatim). Falls back to plain truncation
 * when summarization fails so the import never hard-fails.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} deps - same shape as importRollout, plus options.
 * @param {object} deps.policy - { provider, model, maxTokens, contextWindow }.
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<{sessionId: string, events: number, turns: number, title: string, compacted?: {kept: number, dropped: number, fallback?: boolean}}>}
 */
export async function importWithAutoCompact(ctx, deps) {
  const { persistence, rolloutPath, cwd, sessionId, title, signal } = deps;
  const text = await readFile(rolloutPath, "utf8");
  const { turns, meta } = parseRollout(text);
  if (turns.length === 0) throw new Error(`no turns found in ${rolloutPath}`);

  const targetCwd = cwd ?? meta?.cwd;
  if (typeof targetCwd !== "string" || targetCwd.length === 0) {
    throw new Error("cannot determine the session cwd: pass --cwd <dir>");
  }

  const id = sessionId ?? `session-${randomUUID()}`;
  const createdAt = turns[0].startTs;
  const full = buildSession(turns, { sessionId: id, cwd: targetCwd, createdAt, title });

  // Budget for model-visible messages: context window minus the completion
  // budget minus a safety margin for system prompt and tool schemas.
  const { provider, model, maxTokens, contextWindow } = deps.policy;
  const budget = Math.max(1, contextWindow - maxTokens - 30000);
  const estimate = estimateSessionTokens(full.events);
  if (estimate <= budget) {
    await persistence.create(full.header);
    await persistence.append(id, full.events);
    const finalTitle = title ?? full.events.findLast((e) => e.type === "session/title")?.data?.title ?? "";
    return { sessionId: id, events: full.events.length, turns: turns.length, title: finalTitle };
  }

  // Over budget: keep the newest turns that fit ~60% of the budget and
  // summarize the rest into a checkpoint.
  const { keep } = selectKeepCount(full.events, Math.floor(budget * 0.6));
  const dropped = turns.length - keep;
  const keptTurns = buildSession(turns, {
    sessionId: id,
    cwd: targetCwd,
    createdAt,
    maxTurns: keep,
    title,
  });
  let summary;
  let fallback = false;
  try {
    const droppedEvents = buildSession(turns, {
      sessionId: id,
      cwd: targetCwd,
      createdAt,
      maxTurns: dropped,
    });
    summary = await summarizeWithLlm(ctx, {
      messages: surfaceMessages(droppedEvents.events),
      provider,
      model,
      signal,
    });
  } catch (error) {
    fallback = true;
    ctx.logger?.warn?.(`codex-import: summarization failed (${error instanceof Error ? error.message : String(error)}); importing a truncated tail instead`);
  }
  const events = summary
    ? buildSession(turns, {
        sessionId: id,
        cwd: targetCwd,
        createdAt,
        maxTurns: keep,
        title,
        summary,
      }).events
    : keptTurns.events;

  await persistence.create(keptTurns.header);
  await persistence.append(id, events);

  const finalTitle = title ?? events.findLast((e) => e.type === "session/title")?.data?.title ?? "";
  return {
    sessionId: id,
    events: events.length,
    turns: keep,
    title: finalTitle,
    compacted: { kept: keep, dropped, fallback },
  };
}

/**
 * Register the `/codex-import` command.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function apply(ctx) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: "codex-import",
      description:
        "Import a codex CLI conversation as a new DSH session; auto-compacts oversized histories (/codex-import <session-id|rollout.jsonl> [--session-id <id>] [--cwd <dir>] [--max-turns <n>] [--title <text>] [--no-compact])",
      input: {
        hint: "<codex session id | rollout.jsonl> [--session-id <id>] [--cwd <dir>] [--max-turns <n>] [--title <text>] [--no-compact]",
      },
      handler: async (invocation) => {
        let parsed;
        try {
          parsed = parseArgs(invocation.rawInput);
        } catch (error) {
          return { kind: "error", text: `${USAGE}\n${error.message}` };
        }
        if (parsed.help || parsed.target === null) {
          return { kind: "error", text: USAGE };
        }
        try {
          const rolloutPath = await resolveRolloutPath(parsed.target);
          if (rolloutPath === null) {
            return {
              kind: "error",
              text: `cannot find a codex rollout for ${JSON.stringify(parsed.target)} under ~/.codex/sessions`,
            };
          }
          const fallbackCwd = invocation.agent?.session?.header?.cwd;
          const cwd = parsed.cwd ?? fallbackCwd;

          // The invoking agent's routed target prices the context budget; fall
          // back to the deepseek-official defaults before any request exists.
          const headerConfig = invocation.agent?.session?.requestHeader?.()?.config;
          const context = invocation.agent?.session?.requestContext?.();
          const policy = {
            provider: headerConfig?.provider ?? "deepseek-official",
            model: headerConfig?.model ?? "deepseek-v4-flash",
            maxTokens: headerConfig?.maxTokens ?? 256000,
            contextWindow: context?.contextWindow ?? 1000000,
          };

          if (parsed.maxTurns !== undefined || parsed.noCompact) {
            const result = await importRollout({
              persistence: ctx.sessionPersistence,
              rolloutPath,
              cwd,
              sessionId: parsed.sessionId ?? undefined,
              maxTurns: parsed.maxTurns ?? undefined,
              title: parsed.title ?? undefined,
            });
            return {
              kind: "success",
              text:
                `Imported codex conversation as \`${result.sessionId}\` ` +
                `(${result.turns} turns, ${result.events} events, cwd ${parsed.cwd ?? "from rollout"})\n` +
                `Title: ${result.title}\n` +
                `Refresh the session sidebar to see it.`,
            };
          }

          const result = await importWithAutoCompact(ctx, {
            persistence: ctx.sessionPersistence,
            rolloutPath,
            cwd,
            sessionId: parsed.sessionId ?? undefined,
            title: parsed.title ?? undefined,
            signal: invocation.signal,
            policy,
          });
          const compactNote = result.compacted
            ? result.compacted.fallback
              ? `\nCompaction attempted but the summarizer failed — imported the newest ${result.compacted.kept} turns verbatim.`
              : `\nHistory exceeded the model context window — the oldest ${result.compacted.dropped} turns were compacted into a summary checkpoint, the newest ${result.compacted.kept} kept verbatim.`
            : "";
          return {
            kind: "success",
            text:
              `Imported codex conversation as \`${result.sessionId}\` ` +
              `(${result.turns} turns, ${result.events} events, cwd ${parsed.cwd ?? "from rollout"})\n` +
              `Title: ${result.title}${compactNote}\n` +
              `Refresh the session sidebar to see it.`,
          };
        } catch (error) {
          return {
            kind: "error",
            text: `codex-import failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    });
  }, "dsh-codex-import lifecycle");
}
