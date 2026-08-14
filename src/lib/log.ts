/**
 * The log file: structured JSON Lines on disk, with size-based rotation.
 *
 * One event per line, machine-readable, greppable:
 *   {"t":"2026-08-14T10:13:00.522Z","level":"info","event":"run.finish",...}
 *
 * Three rules this file exists to keep:
 *
 *   1. LOGGING NEVER CRASHES THE APP. Every write is wrapped; a full disk or a
 *      read-only directory degrades to silence, never to an exception. The app
 *      is the product, the log is the diary.
 *   2. NO MEETING CONTENT. Transcripts, notes and quotes stay out of the log —
 *      ids, counts, codes and durations only. The log is the one artefact a
 *      user is likely to paste into an issue, so it must be safe to paste.
 *   3. WRITES ARE SYNCHRONOUS. A crash must leave its own last words behind;
 *      buffered async writes would lose exactly the lines that matter most.
 *      Volume is a handful of lines per meeting, so the cost is irrelevant.
 *
 * Rotation is size-based with numbered backups, the classic scheme:
 *   threadline.log → threadline.log.1 → threadline.log.2 → … → dropped
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { loggingConfig, type LoggingConfig } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Absolute path of the current (unrotated) log file. */
  file: string;
};

export function createLogger(cfg: LoggingConfig): Logger {
  const file = path.resolve(cfg.dir, cfg.file);
  const min = RANK[cfg.level] ?? RANK.info;
  // Tracked in memory so a stat() isn't paid on every line; seeded on first write.
  let size = -1;

  const write = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (RANK[level] < min) return;
    // The console mirror is what `npm run dev` shows. Errors always surface
    // there regardless, because a silent server is worse than a noisy one.
    if (cfg.console || level === "error") {
      const sink = level === "error" || level === "warn" ? console.error : console.log;
      sink(`[${level}] ${event}${fields && Object.keys(fields).length ? ` ${safeJson(fields)}` : ""}`);
    }
    if (!cfg.enabled) return;
    try {
      const line = safeJson({ t: new Date().toISOString(), level, event, ...fields }) + "\n";
      const bytes = Buffer.byteLength(line);
      if (size < 0) {
        mkdirSync(cfg.dir, { recursive: true });
        size = existsSync(file) ? statSync(file).size : 0;
      }
      if (size + bytes > cfg.maxBytes && size > 0) {
        rotate(file, cfg.maxFiles);
        size = 0;
      }
      appendFileSync(file, line);
      size += bytes;
    } catch {
      // Rule 1: the log is never worth an exception. Next line may well work.
      size = -1;
    }
  };

  return {
    debug: (e, f) => write("debug", e, f),
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
    file,
  };
}

/**
 * Shift the backups up by one and drop the oldest, then move the live file to
 * `.1`. Renames only — no copying, so rotation is atomic per file and cheap
 * regardless of how large the log got.
 */
export function rotate(file: string, maxFiles: number): void {
  if (maxFiles <= 0) {
    rmSync(file, { force: true });
    return;
  }
  // The oldest backup falls off the end first, so nothing is ever overwritten
  // by a rename that hasn't already been vacated.
  rmSync(`${file}.${maxFiles}`, { force: true });
  for (let i = maxFiles - 1; i >= 1; i--) {
    if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  if (existsSync(file)) renameSync(file, `${file}.1`);
}

/** Never let an unserialisable field (a cycle, a BigInt) cost us the line. */
function safeJson(o: unknown): string {
  try {
    return JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? String(v) : v)) ?? "{}";
  } catch {
    return JSON.stringify({ logError: "unserialisable fields dropped" });
  }
}

/** The app-wide logger. Config comes from agents.json `logging`. */
export const log: Logger = createLogger(loggingConfig());
