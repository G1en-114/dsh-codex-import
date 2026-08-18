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
import { buildSession, parseRollout } from "./core.js";

export const name = "codex-import";
export const inject = ["commands", "sessionPersistence"];

const USAGE =
  "Usage: /codex-import <codex session id | rollout.jsonl path> [--session-id <id>] [--cwd <dir>] [--max-turns <n>]";

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

/** Parse raw command input into { target, sessionId, cwd, maxTurns }. */
export function parseArgs(rawInput) {
  const tokens = tokenize(rawInput);
  const out = { target: null, sessionId: null, cwd: null, maxTurns: null };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--session-id") out.sessionId = tokens[++i] ?? null;
    else if (tok === "--cwd") out.cwd = tokens[++i] ?? null;
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
export async function importRollout({ persistence, rolloutPath, cwd, sessionId, maxTurns }) {
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
  });

  await persistence.create(header);
  await persistence.append(id, events);

  const title = events.findLast((e) => e.type === "session/title")?.data?.title ?? "";
  const keptTurns = maxTurns === undefined ? turns.length : Math.min(maxTurns, turns.length);
  return { sessionId: id, events: events.length, turns: keptTurns, title };
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
        "Import a codex CLI conversation as a new DSH session (/codex-import <session-id|rollout.jsonl> [--session-id <id>] [--cwd <dir>] [--max-turns <n>])",
      input: {
        hint: "<codex session id | rollout.jsonl> [--session-id <id>] [--cwd <dir>] [--max-turns <n>]",
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
          const result = await importRollout({
            persistence: ctx.sessionPersistence,
            rolloutPath,
            cwd: parsed.cwd ?? fallbackCwd,
            sessionId: parsed.sessionId ?? undefined,
            maxTurns: parsed.maxTurns ?? undefined,
          });
          return {
            kind: "success",
            text:
              `Imported codex conversation as \`${result.sessionId}\` ` +
              `(${result.turns} turns, ${result.events} events, cwd ${parsed.cwd ?? "from rollout"})\n` +
              `Title: ${result.title}\n` +
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
