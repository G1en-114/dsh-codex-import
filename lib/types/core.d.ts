/** A single parsed codex turn (before conversion). */
export interface Turn {
  index: number;
  turnId: string | null;
  startTs: number;
  endTs: number;
  messages: Array<{ ts: number; kind: "user" | "assistant"; text: string }>;
  tools: Array<{ ts: number; kind: "call" | "result"; payload: Record<string, unknown> }>;
  endReason: "completed" | "interrupted" | null;
}

/** Parse result of a codex rollout document. */
export interface Rollout {
  turns: Turn[];
  /** The session_meta payload, if present. */
  meta: Record<string, unknown> | null;
}

/** A DSH session header. */
export interface SessionHeader {
  type: "session";
  version: 0;
  id: string;
  createdAt: number;
  cwd: string;
  delegationDepth: 0;
  agentPreset: string;
}

/** Build result: header plus a seq-contiguous event log. */
export interface BuiltSession {
  header: SessionHeader;
  events: Array<Record<string, unknown>>;
}

export function projectKey(cwd: string): string;
export function parseRollout(text: string): Rollout;
export function deriveTitle(firstPrompt: string): string;
export function buildSession(
  turns: Turn[],
  options: {
    sessionId: string;
    cwd: string;
    createdAt?: number;
    maxTurns?: number;
    title?: string;
    summary?: Array<{ type: "text"; text: string }>;
    compactionId?: string;
  },
): BuiltSession;
export const SUMMARY_OPEN_TAG: string;
export const SUMMARY_CLOSE_TAG: string;
export const CHECKPOINT_PREAMBLE: string;
export const COMPACTION_INSTRUCTION: string;
export function estimateTokens(text: string): number;
export function estimateMessageTokens(message: { content?: Array<Record<string, unknown>> }): number;
export function surfaceMessages(events: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
export function estimateSessionTokens(events: Array<Record<string, unknown>>): number;
export function selectKeepCount(
  events: Array<Record<string, unknown>>,
  budgetTokens: number,
): { keep: number; estimate: number };
export function serializeWire(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
