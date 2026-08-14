/**
 * The log file and its rotation.
 *
 * Two properties matter more than the format: disk stays bounded, and logging
 * can never take the app down with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger, rotate, type Logger } from "../src/lib/log.js";
import { loggingConfig, setConfigForTests } from "../src/lib/config.js";

function tempLogger(over: Partial<Parameters<typeof createLogger>[0]> = {}): { dir: string; log: Logger; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "threadline-log-"));
  const log = createLogger({
    enabled: true,
    dir,
    file: "t.log",
    maxBytes: 1024,
    maxFiles: 3,
    level: "info",
    console: false,
    ...over,
  });
  return { dir, log, file: log.file };
}

test("every line is one self-contained JSON object", () => {
  const { dir, log, file } = tempLogger();
  try {
    log.info("run.finish", { run: 7, outcome: "shipped", tokensIn: 12 });
    log.error("api.error", { route: "GET /api/ask" });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.event, "run.finish");
    assert.equal(first.level, "info");
    assert.equal(first.outcome, "shipped");
    assert.match(first.t, /^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    assert.equal(JSON.parse(lines[1]).level, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("level filtering keeps debug noise out of a normal run", () => {
  const { dir, log, file } = tempLogger({ level: "warn" });
  try {
    log.debug("model.call", {});
    log.info("run.start", {});
    log.warn("model.failover", {});
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).event, "model.failover");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the log rotates at the size limit and disk stays bounded", () => {
  const { dir, log, file } = tempLogger({ maxBytes: 512, maxFiles: 3 });
  try {
    // Far more than 4 × 512B, so rotation has to happen repeatedly.
    for (let i = 0; i < 200; i++) log.info("run.finish", { run: i, pad: "x".repeat(80) });

    assert.ok(existsSync(file), "the live file always exists");
    for (const n of [1, 2, 3]) assert.ok(existsSync(`${file}.${n}`), `backup .${n} exists`);
    // The invariant: max_files backups, and nothing beyond them.
    assert.ok(!existsSync(`${file}.4`), "the oldest backup is dropped, not kept forever");

    const total = [file, `${file}.1`, `${file}.2`, `${file}.3`].reduce((n, f) => n + statSync(f).size, 0);
    assert.ok(total <= 512 * 4 + 512, `bounded at ~(maxFiles+1)*maxBytes, got ${total}`);
    // Rotation must not corrupt lines: every surviving line still parses.
    for (const line of readFileSync(`${file}.1`, "utf8").trim().split("\n")) JSON.parse(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation shifts backups oldest-first, so no file is overwritten", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "threadline-rot-"));
  const file = path.join(dir, "t.log");
  try {
    writeFileSync(file, "live\n");
    writeFileSync(`${file}.1`, "one\n");
    writeFileSync(`${file}.2`, "two\n");
    rotate(file, 3);
    assert.equal(existsSync(file), false, "the live file moved aside");
    assert.equal(readFileSync(`${file}.1`, "utf8"), "live\n");
    assert.equal(readFileSync(`${file}.2`, "utf8"), "one\n");
    assert.equal(readFileSync(`${file}.3`, "utf8"), "two\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken log destination never throws at the caller", () => {
  // dir is an existing FILE, so mkdir/append cannot succeed.
  const dir = mkdtempSync(path.join(tmpdir(), "threadline-bad-"));
  const blocker = path.join(dir, "blocked");
  writeFileSync(blocker, "not a directory");
  try {
    const log = createLogger({
      enabled: true, dir: blocker, file: "t.log", maxBytes: 1024, maxFiles: 2, level: "info", console: false,
    });
    assert.doesNotThrow(() => log.info("run.start", { run: 1 }));
    assert.doesNotThrow(() => log.error("api.error", { route: "x" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unserialisable fields cost the field, never the line", () => {
  const { dir, log, file } = tempLogger();
  try {
    const cyclic: Record<string, unknown> = { run: 1 };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => log.info("run.finish", cyclic));
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    assert.ok(line.logError, "the line is still valid JSON, just marked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logging is config: agents.json sizes rotation, env can override", () => {
  setConfigForTests({ logging: { dir: "somewhere/else", max_bytes: 99, max_files: 2, level: "warn" } });
  try {
    const cfg = loggingConfig();
    assert.equal(cfg.dir, "somewhere/else");
    assert.equal(cfg.maxBytes, 99);
    assert.equal(cfg.maxFiles, 2);
    assert.equal(cfg.level, "warn");

    process.env.LOG_LEVEL = "debug";
    process.env.LOG_TO_FILE = "0";
    assert.equal(loggingConfig().level, "debug");
    assert.equal(loggingConfig().enabled, false, "LOG_TO_FILE=0 turns the file off");
  } finally {
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_TO_FILE;
    setConfigForTests(null);
  }
});
