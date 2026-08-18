// Dev harness: load the plugin in a minimal real composition (real
// CommandRuntime + real JsonlSessionPersistence) and run /codex-import
// through the actual dispatch path.
//
// Needs the @deepseek-ai peer packages resolvable from the cwd (run it from
// inside a dsh install, e.g. the npx cache dir, or `npm install` the
// peerDependencies first):
//
//   node scripts/live.mjs <sessions-root> <codex-session-id|rollout.jsonl>
import { Context } from "@deepseek-ai/cordis";
import { CommandRuntime } from "@deepseek-ai/dsh-commands";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { apply } from "../lib/index.js";

const [root, rolloutArg] = process.argv.slice(2);
if (!root || !rolloutArg) {
  console.error("usage: node scripts/live.mjs <sessions-root> <codex-session-id|rollout.jsonl>");
  process.exit(2);
}

const ctx = new Context();
ctx.provide("sessions", { list: () => [], get: () => undefined, on: () => () => {} });
new JsonlSessionPersistence(ctx, { root, compression: "zstd", packChunks: true });
new CommandRuntime(ctx);
apply(ctx);

const stub = { session: { header: { cwd: "/mnt/e/cell" }, append: () => {} } };
console.log("registered commands:", ctx.commands.list(stub).map((c) => c.name));

const executed = await ctx.commands.execute(
  stub,
  `/codex-import ${rolloutArg} --session-id session-live-test`,
  new AbortController().signal,
);
console.log("result kind:", executed.result.kind);
console.log("result text:", executed.result.text);
if (executed.result.kind !== "success") process.exit(1);
process.exit(0);
