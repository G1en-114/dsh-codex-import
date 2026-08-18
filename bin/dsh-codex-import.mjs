#!/usr/bin/env node
/**
 * dsh-codex-import — standalone CLI.
 *
 * Import a codex CLI rollout conversation directly into the DeepSeek Harness
 * sessions store, without booting dsh:
 *
 *   dsh-codex-import <codex-session-id | rollout.jsonl> [--session-id <id>] [--cwd <dir>]
 *   dsh-codex-import --root <sessions-root> 019feec0-f565-7900-b985-1d6ba3b63a56
 *
 * Writes <root>/<project-key(cwd)>/<session-id>/session.jsonl.zstd using the
 * same two-frame Zstandard layout the dsh persistence backend reads
 * (frame 1 = the header line; frame 2 = the event rows), then self-verifies.
 *
 * Requires Node.js >= 22.20 (node:zlib zstd API). No external dependencies.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { buildSession, projectKey, parseRollout } from "../lib/core.js";
import { resolveRolloutPath } from "../lib/index.js";

const USAGE = `Usage:
  dsh-codex-import <codex-session-id | rollout.jsonl> [options]

Options:
  --session-id <id>   session id to use (default: session-<uuid>)
  --cwd <dir>         workspace cwd for the imported session (default: the
                      rollout's own session_meta cwd)
  --max-turns <n>     keep only the newest N turns (older work is dropped so
                      a huge codex session fits the model context window;
                      title/createdAt still come from the full conversation)
  --title <text>      override the session title (e.g. mark a truncated
                      continuation apart from the full browse-only import)
  --root <dir>        sessions root (default: ~/.dsh/sessions)
  --dry-run           parse and build, but do not write
  -h, --help          show this help`;

/** Parse argv into an options object. */
function parseArgv(argv) {
  const out = { target: null, sessionId: null, cwd: null, maxTurns: null, title: null, root: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--session-id") out.sessionId = argv[++i] ?? null;
    else if (tok === "--cwd") out.cwd = argv[++i] ?? null;
    else if (tok === "--title") out.title = argv[++i] ?? null;
    else if (tok === "--max-turns") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("--max-turns must be a positive integer");
      out.maxTurns = n;
    } else if (tok === "--root") out.root = argv[++i] ?? null;
    else if (tok === "--dry-run") out.dryRun = true;
    else if (tok === "-h" || tok === "--help") out.help = true;
    else if (tok.startsWith("--")) throw new Error(`unknown option: ${tok}`);
    else if (out.target === null) out.target = tok;
  }
  return out;
}

/** Serialize header + events as two Zstandard frames, matching dsh persistence. */
export function serializeSession(header, events) {
  const headerLine = JSON.stringify(header) + "\n";
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  return Buffer.concat([
    zstdCompressSync(Buffer.from(headerLine, "utf8"), options),
    zstdCompressSync(Buffer.from(body, "utf8"), options),
  ]);
}

/**
 * Verify a serialized artifact: recompute the expected two-frame bytes
 * (zstd compression of identical input is deterministic) and assert they
 * match exactly, then decode the event frame and check seq contiguity.
 */
export function verifySession(sessionId, bytes, header, events) {
  const expected = serializeSession(header, events);
  if (!bytes.equals(expected)) {
    throw new Error("verify failed: artifact bytes differ from the expected layout");
  }
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const eventFrame = zstdCompressSync(Buffer.from(body, "utf8"), options);
  const plain = zstdDecompressSync(eventFrame).toString("utf8");
  const lines = plain.split("\n").filter((l) => l.trim() !== "");
  for (let i = 0; i < lines.length; i++) {
    const event = JSON.parse(lines[i]);
    if (event.seq !== i) {
      throw new Error(`verify failed: seq gap at ${i} (got ${event.seq})`);
    }
  }
  return { header, events: lines.length };
}

async function main() {
  let opts;
  try {
    opts = parseArgv(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.target === null) {
    console.error("missing <codex-session-id | rollout.jsonl> argument");
    console.error(USAGE);
    process.exit(2);
  }

  const rolloutPath = await resolveRolloutPath(opts.target);
  if (rolloutPath === null) {
    console.error(`cannot find a codex rollout for ${JSON.stringify(opts.target)} under ~/.codex/sessions`);
    process.exit(1);
  }

  const text = await readFile(rolloutPath, "utf8");
  const { turns, meta } = parseRollout(text);
  if (turns.length === 0) {
    console.error(`no turns found in ${rolloutPath}`);
    process.exit(1);
  }

  const cwd = opts.cwd ?? meta?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    console.error("cannot determine the session cwd: pass --cwd <dir>");
    process.exit(1);
  }

  const sessionId = opts.sessionId ?? `session-${randomUUID()}`;
  const keptTurns = opts.maxTurns === null ? turns.length : Math.min(opts.maxTurns, turns.length);
  const { header, events } = buildSession(turns, {
    sessionId,
    cwd,
    createdAt: turns[0].startTs,
    maxTurns: opts.maxTurns ?? undefined,
    title: opts.title ?? undefined,
  });
  const title = events.findLast((e) => e.type === "session/title")?.data?.title ?? "";

  console.log(`rollout:   ${rolloutPath}`);
  console.log(`turns:     ${keptTurns}${keptTurns < turns.length ? ` (dropped the oldest ${turns.length - keptTurns})` : ""}`);
  console.log(`events:    ${events.length}`);
  console.log(`session:   ${sessionId}`);
  console.log(`cwd:       ${cwd}`);
  console.log(`title:     ${title}`);

  if (opts.dryRun) {
    console.log("dry-run:   not writing");
    return;
  }

  const root = opts.root ?? join(homedir(), ".dsh", "sessions");
  const outDir = join(root, projectKey(cwd), sessionId);
  const outPath = join(outDir, "session.jsonl.zstd");
  await mkdir(outDir, { recursive: true });

  const payload = serializeSession(header, events);
  const tmpPath = join(outDir, `.session.jsonl.zstd.tmp-${randomUUID()}`);
  await writeFile(tmpPath, payload);
  await rename(tmpPath, outPath);

  const check = verifySession(sessionId, payload, header, events);
  console.log(`wrote:     ${outPath} (${payload.length} bytes, ${check.events} events)`);
  console.log(`verify:    OK`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error(`dsh-codex-import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { main };
