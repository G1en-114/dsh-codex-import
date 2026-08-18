import type { Context } from "@deepseek-ai/cordis";

export const name: string;
export const inject: string[];

export interface ParsedArgs {
  target: string | null;
  sessionId: string | null;
  cwd: string | null;
  maxTurns: number | null;
  title: string | null;
  noCompact: boolean;
  help?: boolean;
}

export interface ImportResult {
  sessionId: string;
  events: number;
  turns: number;
  title: string;
}

export interface CompactionInfo {
  kept: number;
  dropped: number;
  fallback: boolean;
}

export interface AutoCompactResult extends ImportResult {
  compacted?: CompactionInfo;
}

export function resolveRolloutPath(arg: string): Promise<string | null>;
export function tokenize(input: string): string[];
export function parseArgs(rawInput: string): ParsedArgs;
export function importRollout(deps: {
  persistence: {
    create(meta: unknown): Promise<void>;
    append(id: string, events: unknown[]): Promise<void>;
  };
  rolloutPath: string;
  cwd: string;
  sessionId?: string;
  maxTurns?: number;
  title?: string;
}): Promise<ImportResult>;
export function summarizeWithLlm(
  ctx: Context,
  options: {
    messages: Array<Record<string, unknown>>;
    provider: string;
    model: string;
    maxTokens?: number;
    signal?: AbortSignal;
  },
): Promise<Array<{ type: "text"; text: string }>>;
export function importWithAutoCompact(
  ctx: Context,
  deps: {
    persistence: {
      create(meta: unknown): Promise<void>;
      append(id: string, events: unknown[]): Promise<void>;
    };
    rolloutPath: string;
    cwd: string;
    sessionId?: string;
    title?: string;
    signal?: AbortSignal;
    policy: { provider: string; model: string; maxTokens: number; contextWindow: number };
  },
): Promise<AutoCompactResult>;
export function apply(ctx: Context): void;
