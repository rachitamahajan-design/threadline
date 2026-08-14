/**
 * One config file, one loader. agents.json is the capability registry: which
 * model serves which surface, what every workflow is allowed to spend, how
 * retries behave, and which gates block. Changing any of those is an edit to
 * agents.json, not a code change.
 *
 * Everything here has a code default, so a missing or partial agents.json
 * degrades to today's behaviour instead of crashing the app.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** Every closed-loop workflow the app runs. Budgets and run records key on this. */
export const WORKFLOW_KINDS = ["process-meeting", "notes", "handoff", "cross-handoff", "ask", "needle", "chat", "diarize", "project-ask", "doc-summary"] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export type BudgetSpec = { units: number; ms: number };
export type RetryPolicy = { maxAttempts: number; baseDelayMs: number };
/** blocking: unsupported claims are pruned; advisory: marked lowConfidence; off: not run. */
export type EntailmentMode = "blocking" | "advisory" | "off";
export type GatePolicy = { entailment: EntailmentMode };

export type ChatModelSpec = {
  /** Preferred provider when its key is configured. */
  provider?: string;
  /** Model name per provider, e.g. { "pyai": "pyai-think", "openai": "gpt-4o-mini" }. */
  model?: Record<string, string>;
  /** Per-purpose overrides, keyed by ModelCall.purpose ("notes", "entail.spotcheck"). */
  purposes?: Record<string, { model?: string; temperature?: number }>;
};

/** USD per 1k tokens, keyed by model name. Used for the cost column on run records. */
export type Pricing = Record<string, { in: number; out: number }>;

export type LoggingConfig = {
  enabled: boolean;
  dir: string;
  file: string;
  /** Rotate once a write would push the live file past this. */
  maxBytes: number;
  /** How many rotated backups to keep (total files on disk = maxFiles + 1). */
  maxFiles: number;
  level: "debug" | "info" | "warn" | "error";
  /** Mirror to stdout as well. Errors always print regardless. */
  console: boolean;
};

type AgentsFile = {
  models?: Record<string, unknown> & { chat?: ChatModelSpec; pricing?: Pricing };
  budgets?: Record<string, unknown> & { workflows?: Partial<Record<WorkflowKind, BudgetSpec>> };
  retry?: { max_attempts?: number; base_delay_ms?: number };
  gates?: { entailment?: EntailmentMode };
  logging?: {
    enabled?: boolean;
    dir?: string;
    file?: string;
    max_bytes?: number;
    max_files?: number;
    level?: string;
    console?: boolean;
  };
};

const DEFAULT_LOGGING: LoggingConfig = {
  enabled: true,
  dir: "data/logs",
  file: "threadline.log",
  maxBytes: 5 * 1024 * 1024,
  maxFiles: 5,
  level: "info",
  console: true,
};

const DEFAULT_BUDGETS: Record<WorkflowKind, BudgetSpec> = {
  "process-meeting": { units: 60, ms: 180_000 },
  notes: { units: 12, ms: 150_000 },
  handoff: { units: 12, ms: 150_000 },
  "cross-handoff": { units: 16, ms: 180_000 },
  ask: { units: 3, ms: 15_000 },
  diarize: { units: 2, ms: 600_000 }, // up to two batch jobs (hybrid); audio-length dominates
  needle: { units: 4, ms: 20_000 },
  chat: { units: 4, ms: 30_000 },
  "project-ask": { units: 3, ms: 30_000 },
  "doc-summary": { units: 2, ms: 30_000 },
};

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 400 };
const DEFAULT_GATES: GatePolicy = { entailment: "blocking" };

let cached: AgentsFile | null = null;
let overridden: AgentsFile | null = null;

function file(): AgentsFile {
  if (overridden) return overridden;
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(path.join(process.cwd(), "agents.json"), "utf8")) as AgentsFile;
  } catch {
    cached = {};
  }
  return cached;
}

/** Tests swap the whole config in; null restores the file. */
export function setConfigForTests(cfg: AgentsFile | null): void {
  overridden = cfg;
  cached = null;
}

export function budgetFor(kind: WorkflowKind): BudgetSpec {
  const spec = file().budgets?.workflows?.[kind];
  const fallback = DEFAULT_BUDGETS[kind];
  return {
    units: typeof spec?.units === "number" ? spec.units : fallback.units,
    ms: typeof spec?.ms === "number" ? spec.ms : fallback.ms,
  };
}

export function retryPolicy(): RetryPolicy {
  const r = file().retry;
  return {
    maxAttempts: typeof r?.max_attempts === "number" ? r.max_attempts : DEFAULT_RETRY.maxAttempts,
    baseDelayMs: typeof r?.base_delay_ms === "number" ? r.base_delay_ms : DEFAULT_RETRY.baseDelayMs,
  };
}

export function gatePolicy(): GatePolicy {
  const g = file().gates;
  const mode = g?.entailment;
  return { entailment: mode === "blocking" || mode === "advisory" || mode === "off" ? mode : DEFAULT_GATES.entailment };
}

export function chatModel(): ChatModelSpec {
  return file().models?.chat ?? {};
}

/** Log destination and rotation. Env wins so a shell can crank it up per-run. */
export function loggingConfig(): LoggingConfig {
  const l = file().logging ?? {};
  const d = DEFAULT_LOGGING;
  const envLevel = (process.env.LOG_LEVEL ?? "").toLowerCase();
  const level = ["debug", "info", "warn", "error"].includes(envLevel)
    ? (envLevel as LoggingConfig["level"])
    : ["debug", "info", "warn", "error"].includes(l.level ?? "")
      ? (l.level as LoggingConfig["level"])
      : d.level;
  return {
    enabled: process.env.LOG_TO_FILE === "0" ? false : (l.enabled ?? d.enabled),
    dir: process.env.LOG_DIR ?? l.dir ?? d.dir,
    file: l.file ?? d.file,
    maxBytes: typeof l.max_bytes === "number" ? l.max_bytes : d.maxBytes,
    maxFiles: typeof l.max_files === "number" ? l.max_files : d.maxFiles,
    level,
    console: typeof l.console === "boolean" ? l.console : d.console,
  };
}

/** USD cost of a call, from the pricing table. 0 when the model is unpriced. */
export function costOf(model: string, tokensIn: number, tokensOut: number): number {
  const p = file().models?.pricing?.[model];
  if (!p) return 0;
  return (tokensIn / 1000) * (p.in ?? 0) + (tokensOut / 1000) * (p.out ?? 0);
}
