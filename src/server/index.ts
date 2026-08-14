/**
 * Threadline local server. Serves the UI and a small JSON API over the local
 * SQLite database. Localhost only — nothing is exposed to the network.
 *
 *   npm run dev   →  http://localhost:4640
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.js";
import { LiveSession, type LiveEvent } from "./live.js";
import { ensureApiKey, writeEnvVar } from "../lib/firstrun.js";
import { processMeeting, reindexMeeting, type MeetingInput } from "../pipeline/extract.js";
import { findOccurrences, applyCorrection, undoCorrection, detectWordSwap } from "../pipeline/corrections.js";
import { chatAboutMeeting } from "../pipeline/notes.js";
import { bulletAt, type StructuredSummary } from "../lib/summary.js";
import { hasOpenAI, openaiModel } from "../lib/openai.js";
import { chatJson } from "../lib/model.js";
import { extractDocText, summarizeDoc, EXTRACTABLE } from "../lib/docs.js";
import type { Utterance } from "../lib/pyai.js";
import { googleConfigured, googleConnected, authUrl, exchangeCode, upcomingEvents } from "./google.js";
import { icsUrl, setIcsUrl, icsUpcomingEvents } from "./ics.js";
import { ask } from "../pipeline/ask.js";
import {
  customerMeetingIds,
  ensureNotes,
  meetingMeta,
  runCrossHandoff,
  runHandoff,
} from "../pipeline/handoff.js";
import {
  deleteHandoffRun,
  listCrossMeetingRuns,
  listHandoffRuns,
  readStatements,
  readOutline,
  saveHandoffEdit,
  saveOutlineEdit,
} from "../lib/store.js";
import { handoffCatalog, matchHandoff } from "../handoffs/registry.js";
import { transcriptFingerprint } from "../lib/segments.js";
import { modelInfo } from "../lib/model.js";
import { firstFailure, getRun, listRuns, recordRun, type RunRecord } from "../lib/runlog.js";
import { log } from "../lib/log.js";
import { publicReason, reasonFrom, type Outcome } from "../lib/reasons.js";
import { converse } from "../pipeline/needle.js";
import { indexMeeting } from "../pipeline/chunker.js";
import { MCP_TOOLS } from "../mcp/meta.js";
import { diarizeMeeting, rederiveMeeting } from "../pipeline/diarize.js";

// tiny .env loader
for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const db = openDb();

// Last-resort net. Node kills the process on an unhandled rejection, and a dead
// server is the one state where the user cannot reach the retry button that
// every failed run is supposed to leave them. Loud, never silent: a stray
// rejection is still a bug, it just must not take the app down with it.
process.on("unhandledRejection", (reason) => {
  log.error("process.unhandledRejection", { stack: reason instanceof Error ? reason.stack : String(reason) });
});
process.on("uncaughtException", (e) => {
  log.error("process.uncaughtException", { stack: e.stack ?? String(e) });
});

const PORT = Number(process.env.PORT ?? 4640);
const PUBLIC = path.resolve("public");
const DOCS_DIR = path.resolve("data", "docs");

// A missing key must not kill the server: boot into a "setup needed" state so
// the in-app onboarding wizard can mint or collect one.
await ensureApiKey().catch((e: Error) => {
  console.error(e.message);
  console.error(`Starting without a PyAI key — open http://localhost:${process.env.PORT ?? 4640} and run onboarding.`);
});
const pyaiKey = () => process.env.PYAI_API_KEY ?? "";
let live: LiveSession | null = null;

// Floating recording panel — a native always-on-top mini window that appears
// while a take is live (any start path) with a timer and Stop. Best-effort
// companion process; its absence must never affect the server.
import { spawn as spawnProc } from "node:child_process";
if (existsSync("capture/threadline-panel")) {
  const panel = spawnProc("capture/threadline-panel", [], { stdio: ["pipe", "ignore", "pipe"] });
  panel.stderr?.on("data", (d: Buffer) => console.log(d.toString().trim()));
  panel.on("error", () => console.log("[panel] failed to start"));
}
const sseClients = new Set<(e: LiveEvent) => void>();
const recentEvents: LiveEvent[] = [];

// ── Onboarding / setup state ────────────────────────────────────────────────
const maskKey = (v?: string) => (v ? (v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : "…") : null);

let sampleJob: {
  running: boolean;
  done: number;
  total: number;
  results: { id: string; title: string; exit: string }[];
  error: string | null;
} | null = null;

// One aggregated readiness view for the onboarding wizard — the individual
// signals all exist elsewhere; this is the only place they meet. Keys are
// always masked: full values never cross the wire.
function setupStatus() {
  const profileRow = db.prepare("SELECT value FROM meta WHERE key = 'profile'").get() as { value: string } | undefined;
  const profile = profileRow ? (JSON.parse(profileRow.value) as { first_name: string | null }) : null;
  const via = googleConnected() ? "oauth" : icsUrl(db) ? "ics" : null;
  return {
    pyai: { configured: !!process.env.PYAI_API_KEY, masked: maskKey(process.env.PYAI_API_KEY) },
    openai: { configured: hasOpenAI(), masked: maskKey(process.env.OPENAI_API_KEY) },
    model: modelInfo(),
    capture: { recorder_built: existsSync("capture/threadline-capture"), panel_built: existsSync("capture/threadline-panel") },
    google: { configured: googleConfigured(), connected: !!via, via },
    profile: { set: !!profile?.first_name, first_name: profile?.first_name ?? null },
    meetings: (db.prepare("SELECT COUNT(*) AS n FROM meetings").get() as { n: number }).n,
    onboarded: !!db.prepare("SELECT value FROM meta WHERE key = 'onboarded'").get(),
    platform: process.platform,
    node: process.version,
  };
}

type Handler = (params: URLSearchParams, body: unknown) => unknown | Promise<unknown>;

function startRecording(opts: { title?: string; mode?: string; meeting_id?: string }) {
  if (live) return { error: "already recording" };
  if (!pyaiKey()) return { error: "PyAI key not configured — run onboarding from the profile menu" };
  recentEvents.length = 0;
  // Resume: keep recording into an existing meeting — new audio lands after
  // what's already there, and stop re-stitches the whole transcript.
  if (opts.meeting_id) {
    const m = db.prepare(`SELECT id, title, mode FROM meetings WHERE id = ?`).get(opts.meeting_id) as
      | { id: string; title: string; mode: string }
      | undefined;
    if (!m) return { error: "meeting not found" };
    const last = db
      .prepare(`SELECT COALESCE(MAX(offset_s + duration_s), 0) AS t FROM utterances WHERE meeting_id = ?`)
      .get(opts.meeting_id) as { t: number };
    live = new LiveSession(db, pyaiKey(), m.title, m.mode, { meetingId: m.id, offsetBase: last.t + 2 });
  } else {
    live = new LiveSession(db, pyaiKey(), opts.title?.trim() || `Meeting ${new Date().toLocaleString()}`, opts.mode ?? "discovery");
  }
  live.onEvent((e) => {
    recentEvents.push(e);
    if (recentEvents.length > 200) recentEvents.shift();
    for (const send of sseClients) send(e);
  });
  live.start();
  return { ok: true, meetingId: live.meetingId };
}

async function stopRecording() {
  if (!live) return { error: "not recording" };
  const s = live;
  live = null;
  const r = await s.stop();
  // Speaker identification runs in the background — narrated over SSE,
  // never blocking the stop response, never failing the meeting.
  if (r.meetingId && r.exit !== "failed" && r.exit !== "discarded") {
    // Seed the run row BEFORE returning, so the meeting page's first render
    // already shows "identification in progress" — no race with the
    // background task's own first write.
    db.prepare("INSERT OR REPLACE INTO diarize_runs (meeting_id, status, updated_at) VALUES (?, 'queued', ?)").run(r.meetingId, Date.now());
    const tell = (message: string) => { const e = { type: "status" as const, message }; recentEvents.push(e); for (const send of sseClients) send(e); };
    (async () => {
      tell("identifying speakers…");
      await diarizeMeeting(db, pyaiKey(), r.meetingId);
      const run = db.prepare("SELECT status, speakers, reason FROM diarize_runs WHERE meeting_id = ?").get(r.meetingId) as { status: string; speakers: number | null; reason: string | null } | undefined;
      if (run?.status === "shipped" && (run.speakers ?? 0) > 1) tell(`${run.speakers} speakers identified — name them on the meeting page`);
      else if (run?.status === "failed") tell(`speaker ID failed: ${run.reason}`);
    })().catch(() => {});
  }
  return r;
}

/**
 * A meeting's length in minutes when nobody has set one: the transcript's own
 * last offset, rounded up, else the recorded wall duration. `+59)/60` is an
 * integer ceiling — SQLite's `ceil()` needs a build flag we can't assume.
 */
const COMPUTED_MINUTES_SQL = `NULLIF(CAST(
    COALESCE(
      (SELECT (MAX(u.offset_s) + 59) / 60 FROM utterances u WHERE u.meeting_id = m.id),
      (m.duration_s + 59) / 60
    ) AS INTEGER), 0)`;

const MEETING_LIST_SQL = `
  SELECT m.id, m.title, m.mode, m.started_at, m.duration_s, m.exit, m.headline,
    COALESCE(m.duration_minutes, ${COMPUTED_MINUTES_SQL}) AS duration_minutes,
    (SELECT COUNT(*) FROM claims c WHERE c.meeting_id = m.id AND c.kind='decision' AND c.gate='passed') AS n_decisions,
    (SELECT COUNT(*) FROM claims c WHERE c.meeting_id = m.id AND c.kind='action_item' AND c.gate='passed') AS n_actions,
    (SELECT GROUP_CONCAT(DISTINCT speaker) FROM utterances u WHERE u.meeting_id = m.id AND speaker IS NOT NULL) AS participants,
    (SELECT GROUP_CONCAT(mp.project_id) FROM meeting_projects mp WHERE mp.meeting_id = m.id) AS topic_ids
  FROM meetings m ORDER BY m.started_at DESC`;

const api: Record<string, Handler> = {
  "GET /api/today"() {
    const todos = (db
      .prepare(
        `SELECT c.id, COALESCE(c.edited_body, c.body) AS body, c.quote, c.offset_s, c.done, m.title AS meeting_title, m.id AS meeting_id, m.started_at
         FROM claims c JOIN meetings m ON m.id = c.meeting_id
         WHERE c.kind = 'action_item' AND c.gate = 'passed'
         ORDER BY c.done ASC, m.started_at DESC`,
      )
      .all() as { id: number; body: string; quote: string | null; offset_s: number | null; done: number; meeting_title: string; meeting_id: string; started_at: number }[])
      .map((r) => ({ ...r, body: JSON.parse(r.body) }));
    const meetings = db.prepare(`${MEETING_LIST_SQL} LIMIT 10`).all();
    const stats = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM meetings) AS meetings,
                (SELECT COALESCE(SUM(duration_s),0) FROM meetings) AS seconds,
                (SELECT COUNT(*) FROM claims WHERE kind='action_item' AND gate='passed' AND done=0 AND meeting_id != '') AS open_actions,
                (SELECT COUNT(*) FROM claims WHERE kind='decision' AND gate='passed') AS decisions`,
      )
      .get();
    return { todos, meetings, stats };
  },

  "GET /api/meetings"() {
    return db.prepare(`${MEETING_LIST_SQL} LIMIT 500`).all();
  },

  "GET /api/meeting"(p) {
    const id = p.get("id")!;
    const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as
      | ({ summary_json: string | null } & Record<string, unknown>)
      | undefined;
    if (!meeting) return { error: "not found" };
    // Same fallback the list uses, so the detail header never shows a blank
    // duration for a meeting nobody has timed by hand.
    if (meeting.duration_minutes == null)
      meeting.duration_minutes =
        (db.prepare(`SELECT ${COMPUTED_MINUTES_SQL} AS mins FROM meetings m WHERE m.id = ?`).get(id) as { mins: number | null } | undefined)?.mins ?? null;
    if (meeting.summary_json) {
      try { meeting.summary_json = JSON.parse(meeting.summary_json); } catch { meeting.summary_json = null; }
    }
    const utterances = db.prepare(`SELECT * FROM utterances WHERE meeting_id = ? ORDER BY idx`).all(id);
    const claims = (db.prepare(`SELECT * FROM claims WHERE meeting_id = ?`).all(id) as { body: string; edited_body: string | null }[]).map(
      (c) => ({ ...c, body: JSON.parse(c.edited_body ?? c.body) }),
    );
    // The pipeline panel shows the latest full-pipeline run; a notes or handoff
    // run must not displace it. The full per-workflow history is not part of
    // the product UI — it lives in the runs table and GET /api/runs for
    // debugging; the user only ever sees outcomes and retry buttons in place.
    // User-safe projection only — outcome and public failure text, never raw
    // steps or failure details (harnesses.md: records reach the browser via forUi).
    const runs = listRuns(db, id, 50).filter((r) => r.kind === "process-meeting").slice(0, 1).map(forUi);
    // backlinks: other meetings sharing a person/topic node with this one —
    // plus meetings one `related` hop away, so "ANZ rollout" (kickoff) still
    // threads to "ANZ pricing" (investor call) without pretending they are
    // the same topic.
    const backlinks = db
      .prepare(
        `SELECT DISTINCT m.id, m.title, n.label AS via FROM edges e1
         JOIN edges e2 ON e1.src = e2.src AND e2.meeting_id != e1.meeting_id
         JOIN meetings m ON m.id = e2.meeting_id
         JOIN nodes n ON n.id = e1.src
         WHERE e1.meeting_id = ?
         UNION
         SELECT DISTINCT m.id, m.title, n.label AS via FROM edges e1
         JOIN edges e2 ON e1.dst = e2.dst AND e2.meeting_id != e1.meeting_id
         JOIN meetings m ON m.id = e2.meeting_id
         JOIN nodes n ON n.id = e1.dst
         WHERE e1.meeting_id = ? AND n.kind != 'meeting'
         UNION
         SELECT DISTINCT m.id, m.title, n1.label || ' ~ ' || n2.label AS via FROM edges e1
         JOIN edges r  ON r.src = e1.dst AND r.kind = 'related'
         JOIN edges e2 ON e2.dst = r.dst AND e2.kind = 'mentions' AND e2.meeting_id != e1.meeting_id
         JOIN meetings m ON m.id = e2.meeting_id
         JOIN nodes n1 ON n1.id = e1.dst
         JOIN nodes n2 ON n2.id = r.dst
         WHERE e1.meeting_id = ? AND e1.kind = 'mentions'`,
      )
      .all(id, id, id);
    const projects = db
      .prepare(
        `SELECT p.id, p.name FROM meeting_projects mp JOIN projects p ON p.id = mp.project_id WHERE mp.meeting_id = ?`,
      )
      .all(id);
    const suggestions = db
      .prepare(
        `SELECT s.id, s.project_id, p.name, s.confidence, s.reason FROM project_suggestions s
         JOIN projects p ON p.id = s.project_id WHERE s.meeting_id = ? AND s.status = 'pending'`,
      )
      .all(id);
    return { meeting, utterances, claims, runs: runs[0] ?? null, backlinks, projects, suggestions };
  },

  "GET /api/graph"() {
    const nodes = db.prepare(`SELECT n.*, (SELECT title FROM meetings WHERE id = n.id) AS meeting_title FROM nodes n`).all();
    const edges = db.prepare(`SELECT * FROM edges`).all();
    return { nodes, edges };
  },

  // Chunk-level search: every hit carries offset_s, so the UI can land the
  // reader on the exact transcript line instead of just the meeting.
  "GET /api/search"(p) {
    const q = (p.get("q") ?? "").trim();
    if (!q) return [];
    const safe = q.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
    if (!safe) return [];
    const words = safe.split(/\s+/);
    const run = (match: string) => {
      try {
        return db
          .prepare(
            `SELECT c.id AS chunk_id, c.meeting_id, m.title, m.started_at, c.kind, c.start_offset_s AS offset_s,
                    snippet(chunk_fts, 0, '<b>', '</b>', '…', 12) AS hit
             FROM chunk_fts f JOIN chunks c ON c.id = f.rowid JOIN meetings m ON m.id = c.meeting_id
             WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts, 10.0, 2.0) LIMIT 20`,
          )
          .all(match) as unknown[];
      } catch { return []; }
    };
    // AND with a trailing prefix for precision while typing; OR keeps the old recall floor.
    const strict = run(words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(" AND "));
    return strict.length ? strict : run(words.map((w) => `"${w}"`).join(" OR "));
  },

  // Ask the brain: hybrid retrieval + gated synthesis. Costs an LLM call when
  // OPENAI_API_KEY is set (extractive and fully local otherwise), so the UI
  // fires it on Enter — never per keystroke.
  async "GET /api/ask"(p) {
    const q = (p.get("q") ?? "").trim();
    if (!q) return { error: "missing q" };
    // Closed loop: even a crashed ask leaves a run record with outcome+cost.
    return await recordRun(
      db,
      { kind: "ask", args: { q } },
      (budget) => ask(db, q, { budget }),
      (r) => ({
        outcome: r.exit as Outcome,
        steps: r.steps,
        failure: r.exit === "shipped" ? null : firstFailure(r.steps),
      }),
    );
  },

  "POST /api/record/start"(p, body) {
    const { title, mode, meeting_id } = (body ?? {}) as { title?: string; mode?: string; meeting_id?: string };
    return startRecording({ title, mode, meeting_id });
  },

  async "POST /api/record/stop"() {
    return await stopRecording();
  },

  // One route, every trigger: starts when idle, stops when recording. The
  // macOS Shortcuts script curls this, so the
  // response carries both vocabularies ({action} and {recording}). Meetings
  // started here get a default title and are renamed from their own content
  // after processing (autoTitle in extract.ts).
  async "POST /api/record/toggle"(p, body) {
    if (live) {
      const r = await stopRecording();
      const title = (db.prepare("SELECT title FROM meetings WHERE id = ?").get((r as { meetingId: string }).meetingId) as
        | { title: string }
        | undefined)?.title;
      return { action: "stopped", recording: false, ...r, title: title ?? null };
    }
    const { title, mode } = (body ?? {}) as { title?: string; mode?: string };
    const r = startRecording({ title, mode });
    return "error" in r ? r : { action: "started", recording: true, ...r };
  },


  /** Mid-recording metadata: mode and topic, applied at stop. */
  "POST /api/record/meta"(p, body) {
    if (!live) return { error: "not recording" };
    const { mode, topic_id } = (body ?? {}) as { mode?: string; topic_id?: number };
    live.setMeta({ mode, topicId: topic_id });
    return { ok: true };
  },

  /** Correct when a meeting happened and how long it ran. Absent fields stay. */
  "POST /api/meeting/time"(p, body) {
    const { id, started_at, duration_minutes } = (body ?? {}) as { id?: string; started_at?: number; duration_minutes?: number };
    if (!id) return { error: "missing id" };
    const exists = db.prepare(`SELECT id FROM meetings WHERE id = ?`).get(id);
    if (!exists) return { error: "not found" };
    if (started_at != null) {
      if (!Number.isFinite(started_at)) return { error: "bad started_at" };
      db.prepare(`UPDATE meetings SET started_at = ? WHERE id = ?`).run(Math.round(started_at), id);
    }
    if (duration_minutes != null) {
      if (!Number.isFinite(duration_minutes) || duration_minutes < 0) return { error: "bad duration_minutes" };
      db.prepare(`UPDATE meetings SET duration_minutes = ? WHERE id = ?`).run(Math.round(duration_minutes) || null, id);
    }
    return { ok: true };
  },

  /** Delete a meeting and everything hanging off it. */
  "POST /api/meeting/delete"(p, body) {
    const { id } = (body ?? {}) as { id?: string };
    if (!id) return { error: "missing id" };
    // One transaction, real errors. The old version ran ~15 deletes each in
    // its own try{}catch{} and returned ok:true no matter what — a partial
    // failure silently corrupted the graph. It also deleted from corrections
    // by a meeting_id column that table doesn't have (rules are scoped via
    // scope='meeting:<id>'), so rules survived their meeting.
    db.exec("BEGIN");
    try {
      for (const t of ["entity_mentions", "chunks", "search", "edges", "claims", "utterances", "runs",
        "summary_versions", "notes_versions", "project_suggestions", "meeting_projects"])
        db.prepare(`DELETE FROM ${t} WHERE meeting_id = ?`).run(id);
      db.prepare("DELETE FROM corrections WHERE scope = ?").run(`meeting:${id}`);
      db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
      db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      log.error("api.error", { route: "meeting/delete", reason: reasonFrom(e).code });
      return { error: publicReason(reasonFrom(e)) };
    }
    return { ok: true };
  },

  /**
   * Context pack for one Brain node, as markdown built for pasting into an
   * LLM: what the node is, how it connects, and the receipts behind it.
   */
  "GET /api/node/context"(p) {
    const id = p.get("id") ?? "";
    const node = db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as { id: string; kind: string; label: string } | undefined;
    if (!node) return { error: "unknown node" };
    const md: string[] = [];
    const meetingRow = (mid: string) => db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(mid) as { id: string; title: string; started_at: number; headline: string | null; summary: string | null } | undefined;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const claimsOf = (mid: string) =>
      (db.prepare(`SELECT kind, body, quote FROM claims WHERE meeting_id = ? AND gate = 'passed'`).all(mid) as { kind: string; body: string; quote: string | null }[])
        .map((c) => ({ ...c, body: JSON.parse(c.body) as Record<string, string | null> }));
    const neighborsOf = (nid: string, kind: string) =>
      db.prepare(
        `SELECT DISTINCT n.id, n.label FROM edges e JOIN nodes n ON n.id = CASE WHEN e.src = ? THEN e.dst ELSE e.src END
         WHERE (e.src = ? OR e.dst = ?) AND n.kind = ?`,
      ).all(nid, nid, nid, kind) as { id: string; label: string }[];

    if (node.kind === "meeting") {
      const m = meetingRow(node.id);
      if (!m) return { error: "meeting missing" };
      md.push(`# Meeting: ${m.title} (${day(m.started_at)})`);
      if (m.summary) md.push(`\n## Summary\n${m.summary}`);
      const cs = claimsOf(m.id);
      const dec = cs.filter((c) => c.kind === "decision");
      const act = cs.filter((c) => c.kind === "action_item");
      if (dec.length) md.push(`\n## Decisions\n` + dec.map((d) => `- ${d.body.text}`).join("\n"));
      if (act.length) md.push(`\n## Action items\n` + act.map((a) => `- ${a.body.owner ?? "unassigned"}: ${a.body.task}${a.body.due ? ` (due ${a.body.due})` : ""} — evidence: "${a.quote ?? a.body.task}"`).join("\n"));
      const people = neighborsOf(m.id, "person");
      const topics = neighborsOf(m.id, "topic");
      md.push(`\n## Connections\n- People present: ${people.map((p) => p.label).join(", ") || "unknown"}\n- Topics discussed: ${topics.map((t) => t.label).join(", ") || "none extracted"}`);
      for (const t of topics.slice(0, 6)) {
        const others = (db.prepare(`SELECT DISTINCT e.meeting_id FROM edges e WHERE (e.src = ? OR e.dst = ?) AND e.meeting_id != ?`).all(t.id, t.id, m.id) as { meeting_id: string }[])
          .map((r) => meetingRow(r.meeting_id)).filter(Boolean) as { title: string; started_at: number }[];
        if (others.length) md.push(`- "${t.label}" also came up in: ${others.map((o) => `${o.title} (${day(o.started_at)})`).join("; ")}`);
      }
    } else {
      const meetIds = (db.prepare(`SELECT DISTINCT meeting_id FROM edges WHERE (src = ? OR dst = ?) AND meeting_id IS NOT NULL`).all(node.id, node.id) as { meeting_id: string }[]).map((r) => r.meeting_id);
      const meets = meetIds.map(meetingRow).filter(Boolean) as { id: string; title: string; started_at: number; headline: string | null }[];
      meets.sort((a, b) => a.started_at - b.started_at);
      md.push(`# ${node.kind === "person" ? "Person" : "Topic"}: ${node.label}`);
      md.push(`\nAppears in ${meets.length} meeting${meets.length === 1 ? "" : "s"}.`);
      md.push(`\n## Timeline`);
      for (const m of meets) md.push(`- ${day(m.started_at)} — ${m.title}${m.headline ? `: ${m.headline}` : ""}`);
      const label = node.label.toLowerCase();
      const related: string[] = [];
      for (const m of meets) {
        for (const c of claimsOf(m.id)) {
          const text = `${c.body.text ?? ""} ${c.body.task ?? ""} ${c.quote ?? ""}`.toLowerCase();
          if (node.kind === "person" && c.kind === "action_item" && (c.body.owner ?? "").toLowerCase() === label)
            related.push(`- [${m.title}] ${node.label} owns: ${c.body.task}${c.body.due ? ` (due ${c.body.due})` : ""}`);
          else if (node.kind === "topic" && text.includes(label))
            related.push(`- [${m.title}] ${c.kind}: ${c.body.text ?? c.body.task}${c.quote ? ` — evidence: "${c.quote}"` : ""}`);
        }
      }
      if (related.length) md.push(`\n## ${node.kind === "person" ? "Commitments and mentions" : "Decisions and actions on this topic"}\n` + [...new Set(related)].slice(0, 12).join("\n"));
      const coPeople = new Map<string, number>();
      const coTopics = new Map<string, number>();
      for (const mid of meetIds) {
        for (const p of neighborsOf(mid, "person")) if (p.id !== node.id) coPeople.set(p.label, (coPeople.get(p.label) ?? 0) + 1);
        for (const t of neighborsOf(mid, "topic")) if (t.id !== node.id) coTopics.set(t.label, (coTopics.get(t.label) ?? 0) + 1);
      }
      const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([l, c]) => `${l} (${c}×)`);
      md.push(`\n## Connection graph\n- Co-occurring people: ${top(coPeople, 6).join(", ") || "—"}\n- Co-occurring topics: ${top(coTopics, 8).join(", ") || "—"}`);
    }
    md.push(`\n---\nExported from Threadline — a local-first meeting brain. Every claim above passed a grounding gate against the source transcript.`);
    const markdown = md.join("\n");
    return { markdown, filename: `threadline-${node.kind}-${node.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md` };
  },

  "GET /api/record/state"() {
    return { recording: !!live, meetingId: live?.meetingId ?? null, title: live?.title ?? null, startedAt: live?.startedAt ?? null };
  },

  // The MCP setup page needs this machine's absolute server path + tool list.
  "GET /api/mcp/info"() {
    return { server_path: path.resolve("src/mcp/server.ts"), tools: MCP_TOOLS };
  },

  // The user's own identity — first/last name plus a small avatar kept as a
  // data URI in the meta kv table, rendered wherever the product shows "you".
  "GET /api/profile"() {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'profile'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { first_name: null, last_name: null, photo: null };
  },

  "POST /api/profile"(p, body) {
    const { first_name, last_name, photo } = (body ?? {}) as { first_name?: string; last_name?: string; photo?: string | null };
    if (photo && (!/^data:image\//.test(photo) || photo.length > 500_000))
      return { error: "photo must be a data:image/* URI under 500KB" };
    const value = JSON.stringify({
      first_name: (first_name ?? "").trim().slice(0, 80) || null,
      last_name: (last_name ?? "").trim().slice(0, 80) || null,
      photo: photo || null,
    });
    db.prepare("INSERT INTO meta (key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
    return { ok: true };
  },

  // The in-app shortcut guide needs this machine's absolute script path and
  // whether the floating-panel companion is built.
  "GET /api/hotkey/info"() {
    return {
      script: path.resolve("scripts/record-toggle.sh"),
      daemon: existsSync("capture/threadline-panel"),
    };
  },

  // ── Onboarding / setup ──────────────────────────────────────────────────
  // Localhost-only server (listen() binds 127.0.0.1), so no auth — same
  // exposure as every other mutating endpoint here. Saved keys land in .env
  // AND process.env, so they take effect without a restart.

  "GET /api/setup/status"() {
    return setupStatus();
  },

  async "POST /api/setup/keys"(p, body) {
    const { pyai_api_key, openai_api_key } = (body ?? {}) as { pyai_api_key?: string; openai_api_key?: string };
    const save = async (name: "PYAI_API_KEY" | "OPENAI_API_KEY", raw: string, checkUrl: string): Promise<string | null> => {
      const v = raw.trim();
      if (!v || /\s/.test(v) || v.length > 500) return `${name} must be a single token under 500 chars`;
      // Only a definite 401/403 rejects — the host may not serve /models, and
      // being offline shouldn't block saving a key.
      try {
        const r = await fetch(checkUrl, { headers: { Authorization: `Bearer ${v}` } });
        if (r.status === 401 || r.status === 403) return `${name} was rejected by the provider — check for typos`;
      } catch {}
      writeEnvVar(name, v);
      return null;
    };
    if (pyai_api_key !== undefined) {
      const base = process.env.PYAI_BASE_URL ?? "https://api.pyai.com/v1";
      const err = await save("PYAI_API_KEY", pyai_api_key, `${base}/models`);
      if (err) return { error: err };
    }
    if (openai_api_key !== undefined) {
      const err = await save("OPENAI_API_KEY", openai_api_key, "https://api.openai.com/v1/models");
      if (err) return { error: err };
    }
    return setupStatus();
  },

  // force: mint a fresh key even when one is configured (ensureApiKey returns
  // early otherwise). The old key is restored if the mint fails.
  async "POST /api/setup/mint"(p, body) {
    const { force } = (body ?? {}) as { force?: boolean };
    const prior = process.env.PYAI_API_KEY;
    try {
      if (force) delete process.env.PYAI_API_KEY;
      await ensureApiKey();
      return { ok: true, masked: maskKey(process.env.PYAI_API_KEY) };
    } catch (e) {
      if (prior) process.env.PYAI_API_KEY = prior;
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },

  "POST /api/setup/onboarded"(p, body) {
    const { completed } = (body ?? {}) as { completed?: boolean };
    if (completed) db.prepare("INSERT INTO meta (key, value) VALUES ('onboarded', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    else db.prepare("DELETE FROM meta WHERE key = 'onboarded'").run();
    return { ok: true };
  },

  // Sample meetings run through the normal pipeline in-process (same SQLite
  // handle — no cross-process contention). Each takes several model calls, so
  // this fires the job and the UI polls sample-status.
  "POST /api/setup/sample-data"() {
    if (!pyaiKey()) return { error: "PyAI key needed first — add one in the key step" };
    if (sampleJob?.running) return { error: "already running" };
    const meetings: MeetingInput[] = JSON.parse(readFileSync("samples/meetings.json", "utf8"));
    const job = { running: true, done: 0, total: meetings.length, results: [] as { id: string; title: string; exit: string }[], error: null as string | null };
    sampleJob = job;
    (async () => {
      for (const m of meetings) {
        const already = db.prepare("SELECT exit FROM meetings WHERE id = ? AND exit IS NOT NULL AND exit != 'failed'").get(m.id) as { exit: string } | undefined;
        if (already) job.results.push({ id: m.id, title: m.title, exit: `skipped (${already.exit})` });
        else {
          const res = await processMeeting(db, pyaiKey(), m);
          job.results.push({ id: m.id, title: m.title, exit: res.exit });
        }
        job.done++;
      }
    })()
      .catch((e) => { job.error = e instanceof Error ? e.message : String(e); })
      .finally(() => { job.running = false; });
    return { ok: true, total: meetings.length };
  },

  "GET /api/setup/sample-status"() {
    return sampleJob ?? { running: false, done: 0, total: 0, results: [], error: null };
  },

  "GET /api/projects"() {
    return db
      .prepare(
        `SELECT p.id, p.name, p.description,
          (SELECT COUNT(*) FROM meeting_projects mp WHERE mp.project_id = p.id) AS n_meetings,
          (SELECT COUNT(*) FROM meeting_projects mp JOIN claims c ON c.meeting_id = mp.meeting_id
             WHERE mp.project_id = p.id AND c.kind='action_item' AND c.gate='passed' AND c.done=0)
          + (SELECT COUNT(*) FROM claims c2 WHERE c2.project_id = p.id AND c2.kind='action_item' AND c2.done=0) AS n_open
         FROM projects p ORDER BY p.created_at DESC`,
      )
      .all();
  },

  "POST /api/project"(p, body) {
    const { name, description } = (body ?? {}) as { name?: string; description?: string };
    if (!name?.trim()) return { error: "missing name" };
    db.prepare(`INSERT INTO projects (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING`).run(name.trim(), Date.now());
    if (description?.trim())
      db.prepare(`UPDATE projects SET description = ? WHERE name = ? AND description IS NULL`).run(description.trim(), name.trim());
    return db.prepare(`SELECT id, name, description FROM projects WHERE name = ?`).get(name.trim());
  },

  "POST /api/project/update"(p, body) {
    const { id, name, description } = (body ?? {}) as { id?: number; name?: string; description?: string };
    if (!id) return { error: "missing id" };
    if (name?.trim()) db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).run(name.trim(), id);
    if (description !== undefined) db.prepare(`UPDATE projects SET description = ? WHERE id = ?`).run(description.trim() || null, id);
    return { ok: true };
  },

  "POST /api/project/assign"(p, body) {
    const { project_id, meeting_id, remove } = (body ?? {}) as { project_id?: number; meeting_id?: string; remove?: boolean };
    if (!project_id || !meeting_id) return { error: "missing ids" };
    if (remove) db.prepare(`DELETE FROM meeting_projects WHERE project_id = ? AND meeting_id = ?`).run(project_id, meeting_id);
    else {
      db.prepare(`INSERT INTO meeting_projects (meeting_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(meeting_id, project_id);
      // Manual filing settles any pending suggestion for the same pair.
      db.prepare(`UPDATE project_suggestions SET status = 'accepted' WHERE meeting_id = ? AND project_id = ? AND status = 'pending'`)
        .run(meeting_id, project_id);
      linkMeetingPeople(meeting_id, project_id);
    }
    return { ok: true };
  },

  "POST /api/suggestion/resolve"(p, body) {
    const { id, action } = (body ?? {}) as { id?: number; action?: string };
    if (!id || (action !== "accept" && action !== "dismiss")) return { error: "missing fields" };
    const s = db.prepare(`SELECT * FROM project_suggestions WHERE id = ? AND status = 'pending'`).get(id) as
      | { meeting_id: string; project_id: number }
      | undefined;
    if (!s) return { error: "not found" };
    db.prepare(`UPDATE project_suggestions SET status = ? WHERE id = ?`).run(action === "accept" ? "accepted" : "dismissed", id);
    if (action === "accept") {
      db.prepare(`INSERT INTO meeting_projects (meeting_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(s.meeting_id, s.project_id);
      linkMeetingPeople(s.meeting_id, s.project_id);
    }
    const projects = db
      .prepare(`SELECT p.id, p.name FROM meeting_projects mp JOIN projects p ON p.id = mp.project_id WHERE mp.meeting_id = ?`)
      .all(s.meeting_id);
    return { ok: true, projects };
  },

  "GET /api/project"(p) {
    const id = Number(p.get("id"));
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
    if (!project) return { error: "not found" };
    const meetings = db
      .prepare(`SELECT m.id, m.title, m.started_at, m.duration_s, m.headline FROM meeting_projects mp JOIN meetings m ON m.id = mp.meeting_id WHERE mp.project_id = ? ORDER BY m.started_at DESC`)
      .all(id);
    const claims = (db
      .prepare(
        `SELECT c.id, c.kind, COALESCE(c.edited_body, c.body) AS body, c.done, c.quote, m.title AS meeting_title, m.id AS meeting_id, m.started_at,
           pe.id AS person_id, pe.team AS person_team
         FROM meeting_projects mp JOIN claims c ON c.meeting_id = mp.meeting_id JOIN meetings m ON m.id = mp.meeting_id
         LEFT JOIN people pe ON lower(pe.name) = lower(json_extract(COALESCE(c.edited_body, c.body), '$.owner'))
         WHERE mp.project_id = ? AND c.gate = 'passed' AND c.kind IN ('decision','action_item') ORDER BY m.started_at DESC`,
      )
      .all(id) as { body: string }[]).map((c) => ({ ...c, body: JSON.parse(c.body) }));
    const people = db
      .prepare(
        `SELECT pe.id, pe.name, pe.team, pp.added_via FROM project_people pp JOIN people pe ON pe.id = pp.person_id
         WHERE pp.project_id = ? ORDER BY pe.name COLLATE NOCASE`,
      )
      .all(id);
    // Speakers heard in filed meetings but not in the directory — a UI hint.
    const speakers = db
      .prepare(
        `SELECT DISTINCT u.speaker FROM meeting_projects mp JOIN utterances u ON u.meeting_id = mp.meeting_id
         WHERE mp.project_id = ? AND u.speaker IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM people pe WHERE lower(pe.name) = lower(u.speaker))`,
      )
      .all(id);
    const docs = db
      .prepare(`SELECT id, title, kind, filename, mime, summary, updated_at FROM documents WHERE project_id = ? ORDER BY updated_at DESC`)
      .all(id);
    const items = (db
      .prepare(
        `SELECT c.id, COALESCE(c.edited_body, c.body) AS body, c.done, c.person_id, c.document_id,
           pe.name AS person_name, d.title AS doc_title
         FROM claims c LEFT JOIN people pe ON pe.id = c.person_id LEFT JOIN documents d ON d.id = c.document_id
         WHERE c.project_id = ? AND c.kind = 'action_item' ORDER BY c.done ASC, c.id DESC`,
      )
      .all(id) as { body: string }[]).map((c) => ({ ...c, body: JSON.parse(c.body) }));
    const topics = db
      .prepare(
        `SELECT n.label, COUNT(DISTINCT e.meeting_id) c FROM meeting_projects mp
         JOIN edges e ON e.meeting_id = mp.meeting_id AND e.kind = 'mentions'
         JOIN nodes n ON n.id = e.dst AND n.kind = 'topic'
         WHERE mp.project_id = ? GROUP BY n.id ORDER BY c DESC, n.label LIMIT 8`,
      )
      .all(id);
    return { project, meetings, claims, people, speakers, docs, items, topics };
  },

  /**
   * Ask-this-project: answer a question from the project's own context —
   * filed meetings (headline/summary/decisions/action items), people, and
   * document text. Context-stuffed, no retrieval index: one project fits.
   */
  async "POST /api/project/ask"(p, body) {
    const { project_id, question } = (body ?? {}) as { project_id?: number; question?: string };
    if (!project_id || !question?.trim()) return { error: "missing fields" };
    if (!hasOpenAI()) return { error: "Set OPENAI_API_KEY in .env to enable project Q&A." };
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(project_id) as
      | { name: string; description: string | null }
      | undefined;
    if (!project) return { error: "not found" };

    const meetings = db
      .prepare(
        `SELECT m.id, m.title, m.started_at, m.headline, m.summary FROM meeting_projects mp
         JOIN meetings m ON m.id = mp.meeting_id WHERE mp.project_id = ? ORDER BY m.started_at DESC LIMIT 12`,
      )
      .all(project_id) as { title: string; started_at: number; headline: string | null; summary: string | null }[];
    const claims = (db
      .prepare(
        `SELECT c.kind, COALESCE(c.edited_body, c.body) AS body, c.done, m.title AS meeting_title
         FROM meeting_projects mp JOIN claims c ON c.meeting_id = mp.meeting_id JOIN meetings m ON m.id = mp.meeting_id
         WHERE mp.project_id = ? AND c.gate = 'passed' AND c.kind IN ('decision','action_item')`,
      )
      .all(project_id) as { kind: string; body: string; done: number | null; meeting_title: string }[])
      .map((c) => { try { return { ...c, body: JSON.parse(c.body) as { text?: string; task?: string; owner?: string } }; } catch { return null; } })
      .filter((c) => c !== null);
    const people = db
      .prepare(
        `SELECT pe.name, pe.team FROM project_people pp JOIN people pe ON pe.id = pp.person_id WHERE pp.project_id = ?`,
      )
      .all(project_id) as { name: string; team: string | null }[];
    const docsRaw = db
      .prepare(`SELECT id, title, filename, path, content, summary FROM documents WHERE project_id = ? ORDER BY updated_at DESC LIMIT 8`)
      .all(project_id) as { id: number; title: string; filename: string | null; path: string | null; content: string | null; summary: string | null }[];
    const docs = [];
    for (const d of docsRaw) docs.push(await ensureDocContext(d));

    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const ctx = [
      `# Project: ${project.name}`,
      project.description ? `Description: ${project.description}` : "",
      people.length ? `People: ${people.map((pe) => pe.name + (pe.team ? ` (${pe.team})` : "")).join(", ")}` : "",
      ...meetings.map((m) =>
        `## Meeting: ${m.title} (${day(m.started_at)})\n${m.headline ?? ""}\n${(m.summary ?? "").slice(0, 2500)}`.trim()),
      claims.length
        ? `## Decisions and action items\n` + claims.map((c) =>
            c.kind === "decision"
              ? `- Decision: ${c.body.text ?? ""} [${c.meeting_title}]`
              : `- Action item${c.done ? " (done)" : ""}: ${c.body.task ?? ""}${c.body.owner ? ` — owner ${c.body.owner}` : ""} [${c.meeting_title}]`,
          ).join("\n")
        : "",
      ...docs.map((d) =>
        `## Document: ${d.title}\n${d.summary ? `Summary: ${d.summary}\n` : ""}${(d.content ?? "(no extractable text)").slice(0, 9000)}`),
    ].filter(Boolean).join("\n\n");

    // Closed loop like every other model workflow: recorded, metered, and a
    // dead network is a failed run with a friendly error — never raw e.message.
    let failure: ReturnType<typeof reasonFrom> | null = null;
    return await recordRun(
      db,
      { kind: "project-ask", args: { project_id, q: question.trim().slice(0, 200) } },
      async (budget) => {
        try {
          budget.spendUnits(1);
          const out = (await chatJson({
            purpose: "project.ask",
            system:
              "You answer questions about one project workspace using ONLY the provided context: its filed " +
              "meetings, decisions, action items, people, and documents. Be concrete and cite facts from the " +
              "context. If the context does not contain the answer, say so plainly instead of guessing. " +
              'Reply with JSON: {"answer": string, "sources": string[]} where sources lists the meeting or ' +
              "document titles you drew the answer from (empty if none).",
            user: `Question: ${question.trim()}\n\nProject context:\n${ctx}`,
          })) as { answer?: unknown; sources?: unknown };
          if (typeof out.answer !== "string" || !out.answer.trim()) return { error: "The model returned no answer — try rephrasing." };
          return {
            answer: out.answer.trim(),
            sources: Array.isArray(out.sources) ? out.sources.filter((s): s is string => typeof s === "string").slice(0, 6) : [],
          };
        } catch (e) {
          failure = reasonFrom(e);
          return { error: publicReason(failure) };
        }
      },
      (r) => ({ outcome: (r as { error?: string }).error ? "failed" : "shipped", steps: [], failure }),
    );
  },

  "GET /api/people"() {
    return db
      .prepare(
        `SELECT pe.*, (SELECT COUNT(*) FROM project_people pp WHERE pp.person_id = pe.id) AS n_projects
         FROM people pe ORDER BY pe.name COLLATE NOCASE`,
      )
      .all();
  },


  "POST /api/project/person"(p, body) {
    const { project_id, person_id, name, team, remove } = (body ?? {}) as {
      project_id?: number; person_id?: number; name?: string; team?: string; remove?: boolean;
    };
    if (!project_id) return { error: "missing project_id" };
    let pid = person_id;
    if (!pid && name?.trim()) pid = (upsertPerson(name.trim(), team) as { id: number }).id;
    if (!pid) return { error: "missing person" };
    if (remove) db.prepare(`DELETE FROM project_people WHERE project_id = ? AND person_id = ?`).run(project_id, pid);
    else db.prepare(`INSERT INTO project_people (project_id, person_id, added_via) VALUES (?, ?, 'manual') ON CONFLICT DO NOTHING`).run(project_id, pid);
    return {
      ok: true,
      people: db
        .prepare(
          `SELECT pe.id, pe.name, pe.team, pp.added_via FROM project_people pp JOIN people pe ON pe.id = pp.person_id
           WHERE pp.project_id = ? ORDER BY pe.name COLLATE NOCASE`,
        )
        .all(project_id),
    };
  },

  /** Manual project action item. The receipt is the user (gate exempt, source='user'). */
  "POST /api/project/item"(p, body) {
    const { project_id, task, person_id, due, document_id } = (body ?? {}) as {
      project_id?: number; task?: string; person_id?: number; due?: string; document_id?: number;
    };
    if (!project_id || !task?.trim()) return { error: "missing fields" };
    const owner = person_id
      ? ((db.prepare(`SELECT name FROM people WHERE id = ?`).get(person_id) as { name: string } | undefined)?.name ?? null)
      : null;
    const bodyJson = JSON.stringify({ task: task.trim(), owner, due: due?.trim() || null });
    const r = db
      .prepare(
        `INSERT INTO claims (meeting_id, kind, body, gate, gate_reason, done, source, project_id, person_id, document_id)
         VALUES ('', 'action_item', ?, 'passed', 'user-created', 0, 'user', ?, ?, ?)`,
      )
      .run(bodyJson, project_id, person_id ?? null, document_id ?? null);
    return { ok: true, id: Number(r.lastInsertRowid) };
  },

  "POST /api/project/item/delete"(p, body) {
    const { id } = (body ?? {}) as { id?: number };
    if (!id) return { error: "missing id" };
    db.prepare(`DELETE FROM claims WHERE id = ? AND source = 'user' AND project_id IS NOT NULL`).run(id);
    return { ok: true };
  },

  /** Upload a file into a project's context. Base64 in JSON — localhost, small files. */
  async "POST /api/project/doc/upload"(p, body) {
    const { project_id, filename, mime, data_b64 } = (body ?? {}) as {
      project_id?: number; filename?: string; mime?: string; data_b64?: string;
    };
    if (!project_id || !filename?.trim() || !data_b64) return { error: "missing fields" };
    const ext = path.extname(filename).toLowerCase();
    if (!EXTRACTABLE.includes(ext)) return { error: "only pdf, txt, md and csv files for now" };
    const buf = Buffer.from(data_b64, "base64");
    if (buf.length > 10 * 1024 * 1024) return { error: "file too large (max 10MB)" };
    const content = await extractDocText(ext, buf);
    const summary = await summarizeDoc(db, filename.trim(), content);
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO documents (project_id, title, kind, filename, mime, content, summary, created_at, updated_at)
         VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project_id,
        filename.trim(),
        filename.trim(),
        mime ?? "application/octet-stream",
        content,
        summary,
        now,
        now,
      );
    const docId = Number(r.lastInsertRowid);
    const safe = `${docId}-${filename.trim().replace(/[^\w.-]+/g, "_")}`;
    writeFileSync(path.join(DOCS_DIR, safe), buf);
    db.prepare(`UPDATE documents SET path = ? WHERE id = ?`).run(path.join("data", "docs", safe), docId);
    return db.prepare(`SELECT id, title, kind, filename, mime, summary, updated_at FROM documents WHERE id = ?`).get(docId);
  },

  /** In-app markdown doc. Versioned like meeting notes. */
  "POST /api/project/doc"(p, body) {
    const { project_id, title, markdown } = (body ?? {}) as { project_id?: number; title?: string; markdown?: string };
    if (!project_id || !title?.trim()) return { error: "missing fields" };
    const now = Date.now();
    const r = db
      .prepare(`INSERT INTO documents (project_id, title, kind, content, created_at, updated_at) VALUES (?, ?, 'note', ?, ?, ?)`)
      .run(project_id, title.trim(), markdown ?? "", now, now);
    const docId = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO document_versions (document_id, markdown, source, created_at) VALUES (?, ?, 'initial', ?)`)
      .run(docId, markdown ?? "", now);
    return db.prepare(`SELECT * FROM documents WHERE id = ?`).get(docId);
  },

  "GET /api/doc"(p) {
    const id = Number(p.get("id"));
    const doc = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
    if (!doc) return { error: "not found" };
    const versions = db.prepare(`SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?`).get(id) as { n: number };
    return { doc, n_versions: versions.n };
  },

  "POST /api/doc/save"(p, body) {
    const { id, markdown, title } = (body ?? {}) as { id?: number; markdown?: string; title?: string };
    if (!id || typeof markdown !== "string") return { error: "missing fields" };
    const doc = db.prepare(`SELECT content FROM documents WHERE id = ?`).get(id) as { content: string | null } | undefined;
    if (!doc) return { error: "not found" };
    // Periodic baseline so an edit session always has a recent restore point.
    const last = db
      .prepare(`SELECT created_at FROM document_versions WHERE document_id = ? AND source = 'user' ORDER BY id DESC LIMIT 1`)
      .get(id) as { created_at: number } | undefined;
    if (!last || Date.now() - last.created_at > 300_000)
      db.prepare(`INSERT INTO document_versions (document_id, markdown, source, created_at) VALUES (?, ?, 'user', ?)`)
        .run(id, doc.content ?? "", Date.now());
    db.prepare(`UPDATE documents SET content = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ?`)
      .run(markdown, title?.trim() || null, Date.now(), id);
    return { ok: true };
  },

  "POST /api/doc/delete"(p, body) {
    const { id } = (body ?? {}) as { id?: number };
    if (!id) return { error: "missing id" };
    const doc = db.prepare(`SELECT path FROM documents WHERE id = ?`).get(id) as { path: string | null } | undefined;
    if (!doc) return { error: "not found" };
    if (doc.path) { try { const full = path.resolve(doc.path);
    if (!full.startsWith(DOCS_DIR + path.sep)) return { error: "path outside docs dir" };
    rmSync(path.resolve(full)); } catch { /* already gone */ } }
    db.prepare(`DELETE FROM document_versions WHERE document_id = ?`).run(id);
    db.prepare(`UPDATE claims SET document_id = NULL WHERE document_id = ?`).run(id);
    db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
    return { ok: true };
  },

  async "GET /api/upcoming"() {
    const manual = db.prepare(
      `SELECT u.*, p.name AS project_name FROM upcoming u LEFT JOIN projects p ON p.id = u.project_id
       WHERE u.at_ms > ? ORDER BY u.at_ms ASC LIMIT 6`,
    ).all(Date.now() - 3600_000) as { title: string; at_ms: number }[];
    if (!googleConnected() && !icsUrl(db)) return manual;
    try {
      const events = googleConnected() ? await upcomingEvents() : await icsUpcomingEvents(db);
      // merge, manual entries first on conflicts (same title + start)
      const seen = new Set(manual.map((m) => `${m.title}@${m.at_ms}`));
      const merged = [...manual, ...events.filter((e) => !seen.has(`${e.title}@${e.at_ms}`)).map((e, i) => ({ id: -1 - i, ...e, source: "google" }))];
      return merged.sort((a, b) => a.at_ms - b.at_ms).slice(0, 6);
    } catch (e) {
      // calendar hiccups must never break Home
      return manual;
    }
  },

  "GET /api/google/status"() {
    const via = googleConnected() ? "oauth" : icsUrl(db) ? "ics" : null;
    return { configured: googleConfigured(), connected: !!via, via };
  },

  // Calendar link (ICS): save the secret address after a test fetch, so a bad
  // paste fails here and not silently on Home. url: null/"" disconnects.
  async "POST /api/google/ics"(p, body) {
    const { url } = (body ?? {}) as { url?: string | null };
    if (!url) { setIcsUrl(db, null); return { ok: true, connected: false }; }
    if (!/^https:\/\//.test(url)) return { error: "that doesn't look like an https:// link" };
    setIcsUrl(db, url.trim());
    try {
      const events = await icsUpcomingEvents(db);
      // A Workspace admin can cap external sharing at free/busy — the feed
      // then carries only "Busy" blocks with no titles. Say so instead of
      // letting useless entries reach the Up-next list.
      const allBusy = events.length > 0 && events.every((e) => /^busy$/i.test(e.title));
      return { ok: true, connected: true, upcoming_48h: events.length, free_busy_only: allBusy };
    } catch (e) {
      setIcsUrl(db, null);
      log.warn("api.error", { route: "google/ics", reason: reasonFrom(e).code });
      return { error: 'couldn\'t read that calendar link — the address didn\'t answer with a calendar. Copy the "Secret address in iCal format" from Google Calendar settings and paste the whole URL.' };
    }
  },

  "POST /api/upcoming"(p, body) {
    const { title, at_ms, participants, remove_id, duration_minutes, project_id } = (body ?? {}) as { title?: string; at_ms?: number; participants?: string; remove_id?: number; duration_minutes?: number; project_id?: number | null };
    if (remove_id) { db.prepare(`DELETE FROM upcoming WHERE id = ?`).run(remove_id); return { ok: true }; }
    if (!title?.trim() || !at_ms) return { error: "missing fields" };
    const endMs = Number.isFinite(duration_minutes) && (duration_minutes as number) > 0
      ? at_ms + Math.round(duration_minutes as number) * 60_000
      : null;
    db.prepare(`INSERT INTO upcoming (title, at_ms, participants, end_ms, project_id) VALUES (?, ?, ?, ?, ?)`)
      .run(title.trim(), at_ms, participants ?? null, endMs, project_id ?? null);
    return { ok: true };
  },

  /** Retag an already-scheduled meeting to a thread (project_id null = untag). */
  "POST /api/upcoming/tag"(p, body) {
    const { id, project_id } = (body ?? {}) as { id?: number; project_id?: number | null };
    if (!id || id < 0) return { error: "missing id" };
    const row = db.prepare(`SELECT id FROM upcoming WHERE id = ?`).get(id);
    if (!row) return { error: "not found" };
    db.prepare(`UPDATE upcoming SET project_id = ? WHERE id = ?`).run(project_id ?? null, id);
    return { ok: true, project_id: project_id ?? null };
  },

  /**
   * A thread's loose ends, split open/done — the prep an upcoming meeting
   * tagged to that thread shows before you walk in.
   */
  "GET /api/project/loose"(p) {
    const id = Number(p.get("id"));
    if (!id) return { error: "missing id" };
    const rows = (db
      .prepare(
        `SELECT c.id, COALESCE(c.edited_body, c.body) AS body, c.done, m.title AS meeting_title, m.id AS meeting_id, m.started_at
         FROM meeting_projects mp JOIN claims c ON c.meeting_id = mp.meeting_id JOIN meetings m ON m.id = mp.meeting_id
         WHERE mp.project_id = ? AND c.kind = 'action_item' AND c.gate = 'passed'
         ORDER BY m.started_at DESC, c.id DESC`,
      )
      .all(id) as { id: number; body: string; done: number; meeting_title: string; meeting_id: string }[])
      .map((c) => {
        let b: { task?: string; owner?: string } = {};
        try { b = JSON.parse(c.body) as { task?: string; owner?: string }; } catch { /* legacy row */ }
        return { id: c.id, task: b.task ?? "", owner: b.owner ?? null, done: !!c.done, meeting_title: c.meeting_title, meeting_id: c.meeting_id };
      });
    return { open: rows.filter((r) => !r.done), done: rows.filter((r) => r.done) };
  },

  /** Prep for an upcoming meeting: what the brain knows about its participants. */
  "GET /api/prep"(p) {
    const names = (p.get("people") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!names.length) return { open: [], recent: [] };
    const like = names.map(() => `u.speaker = ?`).join(" OR ");
    const recent = db
      .prepare(
        `SELECT DISTINCT m.id, m.title, m.started_at FROM utterances u JOIN meetings m ON m.id = u.meeting_id
         WHERE ${like} ORDER BY m.started_at DESC LIMIT 4`,
      )
      .all(...names);
    const open = (db
      .prepare(
        `SELECT COALESCE(c.edited_body, c.body) AS body, c.quote, m.title AS meeting_title, m.id AS meeting_id FROM claims c JOIN meetings m ON m.id = c.meeting_id
         WHERE c.kind='action_item' AND c.gate='passed' AND c.done=0 ORDER BY m.started_at DESC LIMIT 30`,
      )
      .all() as { body: string }[])
      .map((c) => ({ ...c, body: JSON.parse(c.body) }))
      .filter((c: any) => names.some((n) => (c.body.owner ?? "").toLowerCase() === n.toLowerCase()))
      .slice(0, 5);
    return { open, recent };
  },

  "POST /api/notes"(p, body) {
    const { id, notes } = (body ?? {}) as { id?: string; notes?: string };
    if (!id) return { error: "missing id" };
    db.prepare(`UPDATE meetings SET my_notes = ? WHERE id = ?`).run(notes ?? "", id);
    // Periodic user baseline so AI rewrites always have a recent restore point.
    if (notes?.trim()) {
      const last = db
        .prepare(`SELECT created_at FROM notes_versions WHERE meeting_id = ? AND source = 'user' ORDER BY id DESC LIMIT 1`)
        .get(id) as { created_at: number } | undefined;
      if (!last || Date.now() - last.created_at > 300_000)
        db.prepare(`INSERT INTO notes_versions (meeting_id, markdown, source, created_at) VALUES (?, ?, 'user', ?)`)
          .run(id, notes, Date.now());
    }
    return { ok: true };
  },

  "POST /api/todo"(p, body) {
    const { id, done } = (body ?? {}) as { id?: number; done?: boolean };
    if (id == null) return { error: "missing id" };
    db.prepare(`UPDATE claims SET done = ? WHERE id = ? AND kind = 'action_item'`).run(done ? 1 : 0, id);
    return { ok: true };
  },

  // ── Needle: conversations threaded through every meeting ──────────────
  "GET /api/needle/conversations"() {
    return db.prepare(
      `SELECT c.id, c.title, c.project_id, c.created_at,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS n_messages
       FROM conversations c ORDER BY c.id DESC LIMIT 30`,
    ).all();
  },

  "POST /api/needle/new"(p, body) {
    const { title, project_id, seed } = (body ?? {}) as {
      title?: string; project_id?: number;
      seed?: { question: string; content: string; payload?: object };
    };
    const name = (title ?? seed?.question ?? "New thread").slice(0, 80);
    db.prepare("INSERT INTO conversations (title, project_id, created_at) VALUES (?, ?, ?)")
      .run(name, project_id ?? null, Date.now());
    const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    if (seed) {
      // Spotlight handoff: the palette answer (with its retrieved chunks)
      // becomes the first exchange, so follow-ups ground against it.
      const ins = db.prepare("INSERT INTO messages (conversation_id, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?)");
      ins.run(id, "user", seed.question, null, Date.now());
      ins.run(id, "assistant", seed.content, JSON.stringify(seed.payload ?? {}), Date.now());
    }
    return { id };
  },

  "GET /api/needle/messages"(p) {
    const id = Number(p.get("id"));
    return (db.prepare("SELECT id, role, content, payload FROM messages WHERE conversation_id = ? ORDER BY id").all(id) as { payload: string | null }[])
      .map((m) => ({ ...m, payload: m.payload ? JSON.parse(m.payload) : null }));
  },

  async "POST /api/needle/send"(p, body) {
    const { conversation_id, text } = (body ?? {}) as { conversation_id?: number; text?: string };
    if (!conversation_id || !text?.trim()) return { error: "missing conversation_id or text" };
    // Closed loop around the chat turn; the payload's own exit is the outcome.
    return await recordRun(
      db,
      { kind: "needle", args: { conversation_id, q: text.trim() } },
      (budget) => converse(db, conversation_id, text.trim(), budget),
      (r) => {
        const exit = ((r as { payload?: { exit?: string } })?.payload?.exit ?? "shipped") as Outcome | "budget";
        return { outcome: exit === "budget" ? "deadline" : exit, steps: [], failure: null };
      },
    );
  },

  // ── Speaker identification ─────────────────────────────────────────────
  "GET /api/speaker/status"(p) {
    const id = p.get("id");
    if (!id) return { error: "missing id" };
    const run = db.prepare("SELECT * FROM diarize_runs WHERE meeting_id = ?").get(id) ?? null;
    const speakers = db.prepare(
      `SELECT speaker, count(*) AS lines, min(offset_s) AS first_at,
        (SELECT text FROM utterances u2 WHERE u2.meeting_id = u.meeting_id AND u2.speaker = u.speaker ORDER BY idx LIMIT 1) AS first_line
       FROM utterances u WHERE meeting_id = ? AND speaker IS NOT NULL GROUP BY speaker ORDER BY lines DESC`,
    ).all(id);
    return { run, speakers };
  },

  async "POST /api/speaker/retry"(p, body) {
    const { id } = (body ?? {}) as { id?: string };
    if (!id) return { error: "missing id" };
    db.prepare("DELETE FROM diarize_runs WHERE meeting_id = ?").run(id);
    await diarizeMeeting(db, pyaiKey(), id);
    return db.prepare("SELECT * FROM diarize_runs WHERE meeting_id = ?").get(id) ?? { error: "no run recorded" };
  },

  "POST /api/speaker/rename"(p, body) {
    const { meeting_id, from, to } = (body ?? {}) as { meeting_id?: string; from?: string; to?: string };
    if (!meeting_id || !from?.trim() || !to?.trim()) return { error: "missing meeting_id, from or to" };
    const clean = to.trim().slice(0, 60);
    const n = db.prepare("UPDATE utterances SET speaker = ? WHERE meeting_id = ? AND speaker = ?").run(clean, meeting_id, from.trim());
    if (!n.changes) return { error: `no lines by "${from}" in this meeting` };
    upsertPerson(clean);
    rederiveMeeting(db, meeting_id); // entities/graph/search pick the name up — zero paid calls
    return { ok: true, lines: n.changes };
  },

  "POST /api/meeting/rename"(p, body) {
    const { id, title } = (body ?? {}) as { id?: string; title?: string };
    if (!id || !title?.trim()) return { error: "missing id or title" };
    db.prepare("UPDATE meetings SET title = ? WHERE id = ?").run(title.trim().slice(0, 120), id);
    // Both indexes must learn the new name: legacy `search` (reindexMeeting)
    // and the chunk index that /api/search actually queries (indexMeeting).
    reindexMeeting(db, id);
    indexMeeting(db, id);
    return { ok: true };
  },

  "POST /api/needle/rename"(p, body) {
    const { id, title } = (body ?? {}) as { id?: number; title?: string };
    if (!id || !title?.trim()) return { error: "missing id or title" };
    db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title.trim().slice(0, 80), id);
    return { ok: true };
  },

  "POST /api/needle/delete"(p, body) {
    const { id } = (body ?? {}) as { id?: number };
    if (!id) return { error: "missing id" };
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return { ok: true };
  },

  /** git-style branch: copy a thread so a new line of questioning can
   *  diverge while the original stays intact. */
  "POST /api/needle/fork"(p, body) {
    const { conversation_id } = (body ?? {}) as { conversation_id?: number };
    if (!conversation_id) return { error: "missing conversation_id" };
    const src = db.prepare("SELECT title, project_id FROM conversations WHERE id = ?").get(conversation_id) as
      | { title: string; project_id: number | null }
      | undefined;
    if (!src) return { error: "no such thread" };
    db.prepare("INSERT INTO conversations (title, project_id, created_at) VALUES (?, ?, ?)")
      .run(`⑂ ${src.title.replace(/^⑂ /, "")}`.slice(0, 80), src.project_id, Date.now());
    const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    const msgs = db.prepare("SELECT role, content, payload FROM messages WHERE conversation_id = ? ORDER BY id")
      .all(conversation_id) as { role: string; content: string; payload: string | null }[];
    const ins = db.prepare("INSERT INTO messages (conversation_id, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const m of msgs) ins.run(id, m.role, m.content, m.payload, Date.now());
    return { id, copied: msgs.length };
  },

  /** Decision lineage: for each decision in this meeting, its look-alike
   *  decisions from other meetings, oldest first — the seam's re-stitches.
   *  Similarity is plain token Jaccard; no model call, instant. */
  "GET /api/decision/lineage"(p) {
    const meetingId = p.get("meeting_id");
    const rows = db.prepare(
      `SELECT c.id, c.meeting_id, c.body, c.edited_body, m.title, m.started_at
       FROM claims c JOIN meetings m ON m.id = c.meeting_id
       WHERE c.kind = 'decision' AND c.gate = 'passed'`,
    ).all() as { id: number; meeting_id: string; body: string; edited_body: string | null; title: string; started_at: number }[];
    const STOP = new Set("a an and are as at be but by for from has have in is it its of on or our that the their they this to was we will with".split(" "));
    const toks = rows.map((r) => {
      let text = "";
      try { text = String(JSON.parse(r.edited_body ?? r.body).text ?? ""); } catch { /* malformed body: no lineage */ }
      const set = new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
      return { text, set };
    });
    const sim = (a: Set<string>, b: Set<string>) => {
      if (!a.size || !b.size) return 0;
      let hit = 0;
      for (const w of a) if (b.has(w)) hit++;
      return hit / (a.size + b.size - hit);
    };
    const item = (k: number) => ({ claim_id: rows[k].id, meeting_id: rows[k].meeting_id, meeting_title: rows[k].title, started_at: rows[k].started_at, text: toks[k].text });
    // No meeting_id: every chain in the whole brain, for thread pages —
    // lineage follows a decision wherever it was made, across threads.
    if (!meetingId) {
      const grouped = rows.map(() => false);
      const chains: ReturnType<typeof item>[][] = [];
      rows.forEach((r, i) => {
        if (grouped[i]) return;
        grouped[i] = true;
        const chain = [i];
        rows.forEach((o, j) => {
          if (!grouped[j] && o.meeting_id !== r.meeting_id && sim(toks[i].set, toks[j].set) >= 0.25) { grouped[j] = true; chain.push(j); }
        });
        if (chain.length > 1) chains.push(chain.map(item).sort((a, b) => a.started_at - b.started_at));
      });
      return { chains };
    }
    const out: Record<number, ReturnType<typeof item>[]> = {};
    rows.forEach((r, i) => {
      if (r.meeting_id !== meetingId) return;
      const chain = rows
        .map((o, j) => ({ o, j, s: i === j ? 1 : sim(toks[i].set, toks[j].set) }))
        .filter((x) => x.j === i || (x.s >= 0.25 && x.o.meeting_id !== r.meeting_id))
        .map((x) => item(x.j));
      if (chain.length > 1) out[r.id] = chain.sort((a, b) => a.started_at - b.started_at);
    });
    return out;
  },

  /** Re-run the full pipeline over a stored meeting. Idempotent; keeps corrections. */
  async "POST /api/meeting/regenerate"(p, body) {
    const { id } = (body ?? {}) as { id?: string };
    if (!id) return { error: "missing id" };
    return await regenerateMeeting(id);
  },

  /** Run history: every AI workflow that touched this meeting, newest first. */
  "GET /api/runs"(p) {
    const id = p.get("meeting_id") ?? "";
    return { runs: listRuns(db, id, Math.min(Number(p.get("limit") ?? 10) || 10, 50)).map(forUi) };
  },

  /**
   * The retry button. Every run record carries its kind and args, so any run
   * that didn't ship can be re-dispatched — same work, fresh budget, and the
   * new attempt leaves its own record.
   */
  async "POST /api/run/retry"(p, body) {
    const { id } = (body ?? {}) as { id?: number };
    if (!id) return { error: "missing id" };
    const run = getRun(db, id);
    if (!run) return { error: "run not found" };
    const args = (run.args ?? {}) as Record<string, unknown>;
    const refine = typeof args.refine === "string" ? args.refine : undefined;
    switch (run.kind) {
      case "process-meeting":
        return await regenerateMeeting(run.meetingId);
      case "notes": {
        const out = await ensureNotes(db, run.meetingId, { force: true, refine });
        return { ok: !out.error, outline: out.outline, error: out.error, runId: out.runId };
      }
      case "handoff": {
        if (typeof args.handoffId !== "string") return { error: "run has no handoff to retry" };
        const out = await runHandoff(db, { meetingId: run.meetingId, handoffId: args.handoffId, refine });
        return { ok: !out.error, run: out.run, error: out.error, runId: out.runId };
      }
      case "cross-handoff": {
        if (typeof args.handoffId !== "string") return { error: "run has no handoff to retry" };
        const out = await runCrossHandoff(db, {
          handoffId: args.handoffId,
          meetingIds: Array.isArray(args.meetingIds) ? (args.meetingIds as string[]) : undefined,
          refine,
        });
        return { ok: !out.error, run: out.run, error: out.error, runId: out.runId };
      }
      case "ask": {
        if (typeof args.q !== "string") return { error: "run has no question to retry" };
        const q = args.q;
        return await recordRun(
          db,
          { kind: "ask", args: { q } },
          (budget) => ask(db, q, { budget }),
          (r) => ({
            outcome: r.exit as Outcome,
            steps: r.steps,
            failure: r.exit === "shipped" ? null : firstFailure(r.steps),
          }),
        );
      }
      default:
        return { error: `a ${run.kind} run is retried from where it started (the chat)` };
    }
  },

  /** Direct edit of one summary bullet (or the overview). Versioned. */
  "POST /api/summary/edit"(p, body) {
    const { meeting_id, path: bulletPath, text } = (body ?? {}) as { meeting_id?: string; path?: string; text?: string };
    if (!meeting_id || !bulletPath || typeof text !== "string" || !text.trim()) return { error: "missing fields" };
    const row = db.prepare(`SELECT summary_json FROM meetings WHERE id = ?`).get(meeting_id) as
      | { summary_json: string | null }
      | undefined;
    if (!row?.summary_json) return { error: "no structured summary" };
    const summary = JSON.parse(row.summary_json) as StructuredSummary;
    if (bulletPath === "overview") {
      summary.overview = text.trim();
    } else {
      const b = bulletAt(summary, bulletPath);
      if (!b) return { error: "bad path" };
      b.text = text.trim();
      b.edited = true;
    }
    db.prepare(
      `INSERT INTO summary_versions (meeting_id, json, source, created_at) VALUES (?, ?, 'edited', ?)`,
    ).run(meeting_id, row.summary_json, Date.now());
    db.prepare(`UPDATE meetings SET summary_json = ? WHERE id = ?`).run(JSON.stringify(summary), meeting_id);
    reindexMeeting(db, meeting_id);
    return { ok: true };
  },

  /** Everywhere a wrong text appears — proposed edits, nothing applied. */
  "POST /api/correction/preview"(p, body) {
    const { meeting_id, from_text, to_text } = (body ?? {}) as { meeting_id?: string; from_text?: string; to_text?: string };
    if (!meeting_id || !from_text?.trim() || !to_text?.trim()) return { error: "missing fields" };
    return { occurrences: findOccurrences(db, meeting_id, from_text.trim(), to_text.trim()) };
  },

  /** Apply the accepted subset of a previewed correction. */
  "POST /api/correction/apply"(p, body) {
    const { meeting_id, from_text, to_text, refs, persist_global } = (body ?? {}) as {
      meeting_id?: string; from_text?: string; to_text?: string; refs?: string[]; persist_global?: boolean;
    };
    if (!meeting_id || !from_text?.trim() || !to_text?.trim() || !Array.isArray(refs)) return { error: "missing fields" };
    return applyCorrection(db, meeting_id, refs, {
      from: from_text.trim(),
      to: to_text.trim(),
      persistGlobal: persist_global !== false,
    });
  },



  /** Ask-me chat: grounded answers; may rewrite the notes when asked. */
  async "POST /api/chat"(p, body) {
    const { meeting_id, message, history, notes } = (body ?? {}) as {
      meeting_id?: string; message?: string;
      history?: { role: "user" | "assistant"; content: string }[]; notes?: string;
    };
    if (!meeting_id || !message?.trim()) return { error: "missing fields" };
    // "draft the follow-up email" is a handoff request, not a question. Routing
    // is keyword-based on purpose: an unmatched message falls through to
    // grounded Q&A, which is the safe default.
    const wanted = matchHandoff(message.trim());
    if (wanted) {
      const out =
        wanted.scope === "cross-meeting"
          ? await runCrossHandoff(db, { handoffId: wanted.id })
          : await runHandoff(db, { meetingId: meeting_id, handoffId: wanted.id });
      if (out.run) return { handoff: out.run };
      // Couldn't run it (no transcript, no model): say so rather than silently
      // answering a different question.
      if (out.error) return { error: out.error };
    }
    if (!hasOpenAI()) return { error: "OPENAI_API_KEY not configured — chat needs it" };
    const utterances = meetingTranscript(meeting_id);
    if (!utterances.length) return { error: "no transcript yet" };
    // Closed loop like every other workflow: recorded, and a dead network is a
    // failed run with a friendly error — never a 500, never a raw stack.
    let failure: ReturnType<typeof reasonFrom> | null = null;
    return await recordRun(
      db,
      { kind: "chat", meetingId: meeting_id, args: { q: message.trim().slice(0, 200) } },
      async (budget) => {
        try {
          return await chatAboutMeeting(db, meeting_id, message.trim(), history ?? [], notes ?? "", utterances, budget);
        } catch (e) {
          failure = reasonFrom(e);
          return { error: publicReason(failure) };
        }
      },
      (r) => ({
        outcome: (r as { error?: string }).error ? "failed" : "shipped",
        steps: [],
        failure,
      }),
    );
  },

  /** One-shot correction: every occurrence (exact + similar spellings) fixed now. */
  "POST /api/correction/auto"(p, body) {
    const { meeting_id, from_text, to_text, exclude } = (body ?? {}) as {
      meeting_id?: string; from_text?: string; to_text?: string;
      exclude?: { notes?: boolean; utterance_idx?: number };
    };
    if (!meeting_id || !from_text?.trim() || !to_text?.trim()) return { error: "missing fields" };
    const occurrences = findOccurrences(db, meeting_id, from_text.trim(), to_text.trim()).filter((o) => {
      if (exclude?.notes && o.ref.startsWith("meeting_field:my_notes#")) return false;
      if (exclude?.utterance_idx !== undefined && o.ref.startsWith(`utterance:${exclude.utterance_idx}#`)) return false;
      return true;
    });
    const exact = occurrences.filter((o) => o.match === "exact").length;
    const result = applyCorrection(db, meeting_id, occurrences.map((o) => o.ref), {
      from: from_text.trim(), to: to_text.trim(), persistGlobal: true,
    });
    return { ...result, breakdown: { exact, fuzzy: occurrences.length - exact } };
  },

  "POST /api/correction/undo"(p, body) {
    const { event_id } = (body ?? {}) as { event_id?: number };
    if (!event_id) return { error: "missing event_id" };
    return undoCorrection(db, event_id);
  },

  /** Edit one transcript line; a name swap inside it propagates everywhere else. */
  "POST /api/utterance/edit"(p, body) {
    const { meeting_id, idx, text } = (body ?? {}) as { meeting_id?: string; idx?: number; text?: string };
    if (!meeting_id || idx === undefined || typeof text !== "string" || !text.trim()) return { error: "missing fields" };
    const row = db
      .prepare(`SELECT text FROM utterances WHERE meeting_id = ? AND idx = ?`)
      .get(meeting_id, idx) as { text: string } | undefined;
    if (!row) return { error: "not found" };
    db.prepare(`UPDATE utterances SET text = ? WHERE meeting_id = ? AND idx = ?`).run(text.trim(), meeting_id, idx);
    reindexMeeting(db, meeting_id);
    const swap = detectWordSwap(row.text, text.trim());
    let correction = null;
    if (swap) {
      const occurrences = findOccurrences(db, meeting_id, swap.from, swap.to).filter(
        (o) => !o.ref.startsWith(`utterance:${idx}#`),
      );
      if (occurrences.length) {
        const res = applyCorrection(db, meeting_id, occurrences.map((o) => o.ref), {
          from: swap.from, to: swap.to, persistGlobal: true,
        });
        correction = { ...res, from: swap.from, to: swap.to };
      }
    }
    return { ok: true, correction };
  },

  
  // ── Grounded notes & handoffs ──────────────────────────────────────────
  // The outline auto-generates; handoffs never do. Everything below returns
  // segment ids so the UI can point at the transcript line behind each claim.

  /** The themed outline, generating it on first open if the meeting has none. */
  async "GET /api/outline"(p) {
    const id = p.get("id");
    if (!id) return { error: "missing id" };
    const m = meetingMeta(db, id);
    if (!m) return { error: "not found" };
    const existing = readOutline(db, id);
    // Notes write themselves — but never over the founder's own page. If they
    // have typed notes and no outline yet, the notes block shows their writing
    // and waits for "Structure my notes"; if the page is empty, we fill it.
    const rough = ((db.prepare(`SELECT my_notes FROM meetings WHERE id = ?`).get(id) as { my_notes: string | null } | undefined)?.my_notes ?? "").trim();
    const generate = p.get("generate") !== "0" && !rough;
    // Self-heal: an EMPTY outline nobody edited, whose statements were
    // extracted from a different transcript (it grew, or was near-blank at the
    // time), is a stale artefact — regenerate rather than show it forever. A
    // fresh extraction stores the current fingerprint, so a transcript that
    // genuinely yields nothing re-runs once, not on every open.
    const emptyStale =
      !!existing &&
      !existing.edited &&
      !existing.notes?.themes?.length &&
      !existing.notes?.summary?.text &&
      m.segments.length > 0 &&
      readStatements(db, id)?.fingerprint !== transcriptFingerprint(m.segments);
    // Two tabs opening the same meeting must not pay for two generations, so
    // in-flight work is shared rather than duplicated.
    const result =
      (existing && !emptyStale) || !generate
        ? { outline: existing }
        : await (outlining.get(id) ?? track(id, ensureNotes(db, id, { force: emptyStale })));
    return {
      outline: result.outline,
      error: result.error,
      runId: (result as { runId?: number }).runId,
      meeting_type: m.type,
      participants: m.participants,
      catalog: handoffCatalog(m.type),
      model: modelInfo(),
      // Notes and handoffs go through the pluggable adapter; chat always talks
      // to OpenAI, and the composer bar names the model doing the talking.
      chat: { provider: "openai", model: openaiModel(), available: hasOpenAI() },
      handoffs: listHandoffRuns(db, id),
    };
  },

  /**
   * "Structure my notes": build the grounded outline. Explicit user action.
   * `mode` sets the meeting type first (it changes both the themes the compose
   * pass reaches for and which handoff is suggested), and `hints` passes the
   * founder's own rough notes in as steering — never as a source.
   */
  async "POST /api/outline/generate"(p, body) {
    const { id, force, refine, mode, hints } = (body ?? {}) as {
      id?: string; force?: boolean; refine?: string; mode?: string; hints?: string;
    };
    if (!id) return { error: "missing id" };
    if (mode && MEETING_TYPES.includes(mode)) db.prepare(`UPDATE meetings SET meeting_type = ? WHERE id = ?`).run(mode, id);
    const out = await ensureNotes(db, id, {
      force: force !== false,
      refine: refine?.trim() || undefined,
      hints,
    });
    const m = meetingMeta(db, id);
    return {
      outline: out.outline,
      error: out.error,
      runId: out.runId,
      meeting_type: m?.type,
      catalog: m ? handoffCatalog(m.type) : [],
    };
  },

  /** Save a human edit to the outline. Markdown in, tree out, versioned. */
  "POST /api/outline/edit"(p, body) {
    const { id, markdown } = (body ?? {}) as { id?: string; markdown?: string };
    if (!id || typeof markdown !== "string") return { error: "missing fields" };
    const outline = saveOutlineEdit(db, id, markdown);
    if (!outline) return { error: "no outline to edit yet" };
    return { outline };
  },

  /** Run one handoff for one meeting. Called from a chip, the slash menu or chat. */
  async "POST /api/handoff/run"(p, body) {
    const { meeting_id, handoff_id, refine } = (body ?? {}) as {
      meeting_id?: string; handoff_id?: string; refine?: string;
    };
    if (!meeting_id || !handoff_id) return { error: "missing fields" };
    const out = await runHandoff(db, { meetingId: meeting_id, handoffId: handoff_id, refine: refine?.trim() || undefined });
    return { run: out.run, error: out.error, runId: out.runId };
  },

  /** The cross-meeting handoff: collated customer feedback. */
  async "POST /api/handoff/cross"(p, body) {
    const { handoff_id, meeting_ids, refine } = (body ?? {}) as {
      handoff_id?: string; meeting_ids?: string[]; refine?: string;
    };
    const out = await runCrossHandoff(db, {
      handoffId: handoff_id ?? "collated_feedback",
      meetingIds: Array.isArray(meeting_ids) ? meeting_ids : undefined,
      refine: refine?.trim() || undefined,
    });
    return { run: out.run, error: out.error, runId: out.runId };
  },

  "GET /api/handoff/cross"() {
    return { runs: listCrossMeetingRuns(db), candidates: customerMeetingIds(db) };
  },

  "POST /api/handoff/edit"(p, body) {
    const { id, markdown } = (body ?? {}) as { id?: number; markdown?: string };
    if (!id || typeof markdown !== "string") return { error: "missing fields" };
    const run = saveHandoffEdit(db, id, markdown);
    return run ? { run } : { error: "not found" };
  },

  "POST /api/handoff/delete"(p, body) {
    const { id } = (body ?? {}) as { id?: number };
    if (!id) return { error: "missing id" };
    deleteHandoffRun(db, id);
    return { ok: true };
  },

  /**
   * Why an output looks the way it does: prompt version, validator failures,
   * and the statements extraction refused. Local debugging surface, no model call.
   */
  "GET /api/grounding/debug"(p) {
    const id = p.get("id");
    if (!id) return { error: "missing id" };
    const statements = readStatements(db, id);
    const outline = readOutline(db, id);
    return {
      model: modelInfo(),
      statements: statements
        ? { count: statements.statements.length, promptVersion: statements.promptVersion, dropped: statements.dropped, items: statements.statements }
        : null,
      outline: outline
        ? {
            promptVersion: outline.promptVersion,
            needsReview: outline.needsReview,
            dropped: outline.dropped,
            failures: outline.failures,
            edited: outline.edited,
          }
        : null,
      handoffs: listHandoffRuns(db, id).map((r) => ({
        id: r.id,
        handoffId: r.handoffId,
        promptVersion: r.promptVersion,
        needsReview: r.needsReview,
        dropped: r.dropped,
        failures: r.failures,
        edited: r.edited,
      })),
    };
  },

  /** Override the derived meeting type — it decides which handoff is suggested. */
  "POST /api/meeting/type"(p, body) {
    const { id, type } = (body ?? {}) as { id?: string; type?: string };
    if (!id || !type) return { error: "missing fields" };
    if (!MEETING_TYPES.includes(type)) return { error: `type must be one of ${MEETING_TYPES.join(", ")}` };
    db.prepare(`UPDATE meetings SET meeting_type = ? WHERE id = ?`).run(type, id);
    const m = meetingMeta(db, id);
    return { ok: true, meeting_type: m?.type ?? type, catalog: handoffCatalog(m?.type ?? "team") };
  },
};

/** The handoff taxonomy, as accepted over the wire. */
const MEETING_TYPES = ["investor", "vendor", "customer", "team", "one_on_one"];

const regenerating = new Set<string>();

/**
 * What a run record looks like on screen. System internals — failure details,
 * step logs, codes — never leave the server on this path; the browser gets the
 * outcome, a human phrase for the failure, spend, and enough identity to
 * retry. The full record stays queryable in the runs table for debugging.
 */
function forUi(r: RunRecord) {
  return {
    id: r.id,
    kind: r.kind,
    outcome: r.outcome,
    failureText: publicReason(r.failure),
    startedAt: r.startedAt,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    costUsd: r.costUsd,
  };
}

/** Full-pipeline re-run, shared by the regenerate endpoint and the run retry button. */
async function regenerateMeeting(id: string) {
  if (regenerating.has(id)) return { error: "already regenerating" };
  const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as
    | { id: string; title: string; mode: string; started_at: number }
    | undefined;
  if (!meeting) return { error: "not found" };
  const utterances = db
    .prepare(`SELECT speaker, speaker_role, text, offset_s, duration_s FROM utterances WHERE meeting_id = ? ORDER BY idx`)
    .all(id) as Utterance[];
  if (!utterances.length) return { error: "no transcript to regenerate from" };
  regenerating.add(id);
  try {
    const { exit, steps, stored } = await processMeeting(db, pyaiKey(), {
      id: meeting.id,
      title: meeting.title,
      mode: meeting.mode,
      startedAt: meeting.started_at,
      utterances,
    });
    // Step metadata only crosses the wire — reason details stay in the run record.
    return { ok: true, exit, steps: steps.map((s) => ({ name: s.name, status: s.status, attempts: s.attempts, ms: s.ms, code: s.reason?.code })), stored };
  } finally {
    regenerating.delete(id);
  }
}

/** In-flight outline generations, keyed by meeting: one model call, many waiters. */
const outlining = new Map<string, ReturnType<typeof ensureNotes>>();
function track(id: string, work: ReturnType<typeof ensureNotes>) {
  outlining.set(id, work);
  void work.finally(() => outlining.delete(id)).catch(() => {});
  return work;
}

function upsertPerson(name: string, team?: string, notes?: string) {
  db.prepare(`INSERT INTO people (name, team, notes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING`)
    .run(name, team?.trim() || null, notes?.trim() || null, Date.now());
  if (team?.trim()) db.prepare(`UPDATE people SET team = ? WHERE name = ? COLLATE NOCASE`).run(team.trim(), name);
  if (notes?.trim()) db.prepare(`UPDATE people SET notes = ? WHERE name = ? COLLATE NOCASE`).run(notes.trim(), name);
  return db.prepare(`SELECT * FROM people WHERE name = ? COLLATE NOCASE`).get(name);
}

/** Filing a meeting pulls its known speakers into the project's people. */
function linkMeetingPeople(meetingId: string, projectId: number) {
  const speakers = db
    .prepare(`SELECT DISTINCT speaker FROM utterances WHERE meeting_id = ? AND speaker IS NOT NULL`)
    .all(meetingId) as { speaker: string }[];
  for (const { speaker } of speakers) {
    const person = db.prepare(`SELECT id FROM people WHERE name = ? COLLATE NOCASE`).get(speaker) as { id: number } | undefined;
    if (person)
      db.prepare(`INSERT INTO project_people (project_id, person_id, added_via) VALUES (?, ?, 'meeting') ON CONFLICT DO NOTHING`)
        .run(projectId, person.id);
  }
}

/**
 * Backfill for docs uploaded before extraction existed: pull text out of the
 * saved file and summarize it, persisting both. No-op when already populated.
 */
async function ensureDocContext<T extends { id: number; title: string; filename: string | null; path: string | null; content: string | null; summary: string | null }>(doc: T): Promise<T> {
  let { content, summary } = doc;
  if (!content && doc.path) {
    const full = path.resolve(doc.path);
    if (full.startsWith(DOCS_DIR + path.sep) && existsSync(full)) {
      const ext = path.extname(doc.filename ?? full).toLowerCase();
      content = await extractDocText(ext, readFileSync(full));
      if (content) db.prepare(`UPDATE documents SET content = ? WHERE id = ?`).run(content, doc.id);
    }
  }
  if (!summary && content) {
    summary = await summarizeDoc(db, doc.title, content);
    if (summary) db.prepare(`UPDATE documents SET summary = ? WHERE id = ?`).run(summary, doc.id);
  }
  return { ...doc, content, summary };
}

/** Transcript for a meeting — the live session's finals while recording, else the DB. */
function meetingTranscript(id: string): Utterance[] {
  if (live?.meetingId === id) return live.transcript;
  return db
    .prepare(`SELECT speaker, speaker_role, text, offset_s, duration_s FROM utterances WHERE meeting_id = ? ORDER BY idx`)
    .all(id) as Utterance[];
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const key = `${req.method} ${url.pathname}`;

  // Google OAuth
  if (key === "GET /api/google/connect") {
    if (!googleConfigured()) {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    res.writeHead(302, { Location: authUrl() });
    res.end();
    return;
  }
  if (key === "GET /oauth2/callback") {
    const code = url.searchParams.get("code");
    try {
      if (!code) throw new Error(url.searchParams.get("error") ?? "no code returned");
      await exchangeCode(code);
      res.writeHead(302, { Location: "/?google=connected" });
    } catch (e) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<p>Google connection failed: ${e instanceof Error ? e.message : e}</p><p><a href="/">Back to Threadline</a></p>`);
      return;
    }
    res.end();
    return;
  }

  // Live transcript stream (SSE)
  if (key === "GET /api/record/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const e of recentEvents) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const send = (e: LiveEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    sseClients.add(send);
    req.on("close", () => sseClients.delete(send));
    return;
  }

  // Raw document download — the one non-JSON API route.
  if (key === "GET /api/doc/file") {
    const id = Number(url.searchParams.get("id"));
    const doc = db.prepare(`SELECT path, mime, filename FROM documents WHERE id = ?`).get(id) as
      | { path: string | null; mime: string | null; filename: string | null }
      | undefined;
    const full = doc?.path ? path.resolve(doc.path) : null;
    if (!full || !full.startsWith(DOCS_DIR) || !existsSync(full)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": doc!.mime ?? "application/octet-stream",
      "Content-Disposition": `inline; filename="${(doc!.filename ?? "file").replace(/[^\w.-]+/g, "_")}"`,
    });
    res.end(readFileSync(full));
    return;
  }

  if (api[key]) {
    let body: unknown = null;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "null"); } catch { body = null; }
    }
    try {
      const out = await api[key](url.searchParams, body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e) {
      // The user never sees internals; the log gets the whole thing — the
      // classified reason for branching/grepping, the stack for reading.
      // Code + stack only — a Reason's detail can carry meeting text, and the
      // log file must be safe to paste into a bug report.
      log.error("api.error", { route: key, reason: reasonFrom(e).code, stack: e instanceof Error ? e.stack : String(e) });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "something went wrong" }));
    }
    return;
  }

  // static
  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = path.join(PUBLIC, path.normalize(file));
  if (full.startsWith(PUBLIC) && existsSync(full)) {
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream",
      // Local dev app: the UI changes constantly, stale caches cost debugging hours.
      "Cache-Control": "no-store",
    });
    res.end(readFileSync(full));
    return;
  }
  res.writeHead(404);
  res.end("not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Threadline running → http://localhost:${PORT}`);
});
