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
import { ensureApiKey } from "../lib/firstrun.js";
import { processMeeting, reindexMeeting } from "../pipeline/extract.js";
import { findOccurrences, applyCorrection, undoCorrection, detectWordSwap } from "../pipeline/corrections.js";
import { enhanceNotes, structureNotes, chatAboutMeeting } from "../pipeline/notes.js";
import { bulletAt, type StructuredSummary } from "../lib/summary.js";
import { hasOpenAI } from "../lib/openai.js";
import type { Utterance } from "../lib/pyai.js";
import { googleConfigured, googleConnected, authUrl, exchangeCode, upcomingEvents } from "./google.js";
import { ask } from "../pipeline/ask.js";
import { converse } from "../pipeline/needle.js";

// tiny .env loader
for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const db = openDb();
const PORT = Number(process.env.PORT ?? 4640);
const PUBLIC = path.resolve("public");
const DOCS_DIR = path.resolve("data", "docs");

const apiKey = await ensureApiKey().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
let live: LiveSession | null = null;

// Global hotkey daemon (double-Fn toggles recording). Best-effort companion
// process; absence or permission problems must never affect the server.
import { spawn as spawnProc } from "node:child_process";
if (existsSync("capture/threadline-hotkey")) {
  const hk = spawnProc("capture/threadline-hotkey", [], { stdio: ["pipe", "ignore", "pipe"] });
  hk.stderr?.on("data", (d: Buffer) => console.log(d.toString().trim()));
  hk.on("error", () => console.log("[hotkey] failed to start"));
}
const sseClients = new Set<(e: LiveEvent) => void>();
const recentEvents: LiveEvent[] = [];

type Handler = (params: URLSearchParams, body: unknown) => unknown | Promise<unknown>;

const MEETING_LIST_SQL = `
  SELECT m.id, m.title, m.mode, m.started_at, m.duration_s, m.exit, m.headline,
    (SELECT COUNT(*) FROM claims c WHERE c.meeting_id = m.id AND c.kind='decision' AND c.gate='passed') AS n_decisions,
    (SELECT COUNT(*) FROM claims c WHERE c.meeting_id = m.id AND c.kind='action_item' AND c.gate='passed') AS n_actions,
    (SELECT GROUP_CONCAT(DISTINCT speaker) FROM utterances u WHERE u.meeting_id = m.id AND speaker IS NOT NULL) AS participants
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
    return db.prepare(MEETING_LIST_SQL).all();
  },

  "GET /api/meeting"(p) {
    const id = p.get("id")!;
    const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as
      | ({ summary_json: string | null } & Record<string, unknown>)
      | undefined;
    if (!meeting) return { error: "not found" };
    if (meeting.summary_json) {
      try { meeting.summary_json = JSON.parse(meeting.summary_json); } catch { meeting.summary_json = null; }
    }
    const utterances = db.prepare(`SELECT * FROM utterances WHERE meeting_id = ? ORDER BY idx`).all(id);
    const claims = (db.prepare(`SELECT * FROM claims WHERE meeting_id = ?`).all(id) as { body: string; edited_body: string | null }[]).map(
      (c) => ({ ...c, body: JSON.parse(c.edited_body ?? c.body) }),
    );
    const runs = (db.prepare(`SELECT * FROM runs WHERE meeting_id = ? ORDER BY id DESC LIMIT 1`).all(id) as { steps: string }[]).map(
      (r) => ({ ...r, steps: JSON.parse(r.steps) }),
    );
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
    return await ask(db, q);
  },

  "POST /api/record/start"(p, body) {
    if (live) return { error: "already recording" };
    const { title, mode, meeting_id } = (body ?? {}) as { title?: string; mode?: string; meeting_id?: string };
    recentEvents.length = 0;
    // Resume: keep recording into an existing meeting — new audio lands after
    // what's already there, and stop re-stitches the whole transcript.
    if (meeting_id) {
      const m = db.prepare(`SELECT id, title, mode FROM meetings WHERE id = ?`).get(meeting_id) as
        | { id: string; title: string; mode: string }
        | undefined;
      if (!m) return { error: "meeting not found" };
      const last = db
        .prepare(`SELECT COALESCE(MAX(offset_s + duration_s), 0) AS t FROM utterances WHERE meeting_id = ?`)
        .get(meeting_id) as { t: number };
      live = new LiveSession(db, apiKey, m.title, m.mode, { meetingId: m.id, offsetBase: last.t + 2 });
    } else {
      live = new LiveSession(db, apiKey, title?.trim() || `Meeting ${new Date().toLocaleString()}`, mode ?? "discovery");
    }
    live.onEvent((e) => {
      recentEvents.push(e);
      if (recentEvents.length > 200) recentEvents.shift();
      for (const send of sseClients) send(e);
    });
    live.start();
    return { ok: true, meetingId: live.meetingId };
  },

  async "POST /api/record/stop"() {
    if (!live) return { error: "not recording" };
    const s = live;
    live = null;
    return await s.stop();
  },

  /** Global-hotkey entry: one endpoint that starts or stops. */
  async "POST /api/record/toggle"() {
    if (live) {
      const s = live;
      live = null;
      return { action: "stopped", ...(await s.stop()) };
    }
    const title = `Quick capture ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    recentEvents.length = 0;
    live = new LiveSession(db, apiKey, title, "discovery");
    live.onEvent((e) => {
      recentEvents.push(e);
      if (recentEvents.length > 200) recentEvents.shift();
      for (const send of sseClients) send(e);
    });
    live.start();
    return { action: "started", meetingId: live.meetingId, title };
  },

  /** Mid-meeting notes: extract from the transcript so far, keep recording. */
  async "POST /api/record/notes"() {
    if (!live) return { error: "not recording" };
    const utts = live.snapshot();
    if (utts.length < 1) return { error: "Not enough speech yet — give it a minute." };
    const cid = `${live.meetingId}-sofar-${Date.now()}`;
    const durationS = Math.max(...utts.map((u) => u.offset_s + u.duration_s));
    try {
      const { triggerRecap, awaitRecap } = await import("../lib/pyai.js");
      await triggerRecap(apiKey, cid, utts, durationS);
      const r = await awaitRecap(apiKey, cid, 30_000);
      if (r.status !== "complete" || !r.record) throw new Error(r.error ?? "recap incomplete");
      return { record: r.record, lines: utts.length };
    } catch (e) {
      const { hasOpenAI, openaiExtract } = await import("../lib/openai.js");
      if (hasOpenAI()) {
        try { return { record: await openaiExtract(utts), lines: utts.length, engine: "fallback" }; } catch {}
      }
      return { error: `Notes engine unavailable: ${e instanceof Error ? e.message : e}` };
    }
  },

  "GET /api/record/state"() {
    return { recording: !!live, meetingId: live?.meetingId ?? null, title: live?.title ?? null };
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
      .prepare(`SELECT id, title, kind, filename, mime, updated_at FROM documents WHERE project_id = ? ORDER BY updated_at DESC`)
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

  "GET /api/people"() {
    return db
      .prepare(
        `SELECT pe.*, (SELECT COUNT(*) FROM project_people pp WHERE pp.person_id = pe.id) AS n_projects
         FROM people pe ORDER BY pe.name COLLATE NOCASE`,
      )
      .all();
  },

  "POST /api/person"(p, body) {
    const { name, team, notes } = (body ?? {}) as { name?: string; team?: string; notes?: string };
    if (!name?.trim()) return { error: "missing name" };
    return upsertPerson(name.trim(), team, notes);
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
  "POST /api/project/doc/upload"(p, body) {
    const { project_id, filename, mime, data_b64 } = (body ?? {}) as {
      project_id?: number; filename?: string; mime?: string; data_b64?: string;
    };
    if (!project_id || !filename?.trim() || !data_b64) return { error: "missing fields" };
    const ext = path.extname(filename).toLowerCase();
    if (![".pdf", ".txt", ".md"].includes(ext)) return { error: "only pdf, txt and md files for now" };
    const buf = Buffer.from(data_b64, "base64");
    if (buf.length > 10 * 1024 * 1024) return { error: "file too large (max 10MB)" };
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO documents (project_id, title, kind, filename, mime, content, created_at, updated_at)
         VALUES (?, ?, 'upload', ?, ?, ?, ?, ?)`,
      )
      .run(
        project_id,
        filename.trim(),
        filename.trim(),
        mime ?? "application/octet-stream",
        ext === ".pdf" ? null : buf.toString("utf8"),
        now,
        now,
      );
    const docId = Number(r.lastInsertRowid);
    const safe = `${docId}-${filename.trim().replace(/[^\w.-]+/g, "_")}`;
    writeFileSync(path.join(DOCS_DIR, safe), buf);
    db.prepare(`UPDATE documents SET path = ? WHERE id = ?`).run(path.join("data", "docs", safe), docId);
    return db.prepare(`SELECT id, title, kind, filename, mime, updated_at FROM documents WHERE id = ?`).get(docId);
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
    if (doc.path) { try { rmSync(path.resolve(doc.path)); } catch { /* already gone */ } }
    db.prepare(`DELETE FROM document_versions WHERE document_id = ?`).run(id);
    db.prepare(`UPDATE claims SET document_id = NULL WHERE document_id = ?`).run(id);
    db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
    return { ok: true };
  },

  async "GET /api/upcoming"() {
    const manual = db.prepare(`SELECT * FROM upcoming WHERE at_ms > ? ORDER BY at_ms ASC LIMIT 6`).all(Date.now() - 3600_000) as { title: string; at_ms: number }[];
    if (!googleConnected()) return manual;
    try {
      const events = await upcomingEvents();
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
    return { configured: googleConfigured(), connected: googleConnected() };
  },

  "POST /api/upcoming"(p, body) {
    const { title, at_ms, participants, remove_id } = (body ?? {}) as { title?: string; at_ms?: number; participants?: string; remove_id?: number };
    if (remove_id) { db.prepare(`DELETE FROM upcoming WHERE id = ?`).run(remove_id); return { ok: true }; }
    if (!title?.trim() || !at_ms) return { error: "missing fields" };
    db.prepare(`INSERT INTO upcoming (title, at_ms, participants) VALUES (?, ?, ?)`).run(title.trim(), at_ms, participants ?? null);
    return { ok: true };
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
    const { id, done } = body as { id: number; done: boolean };
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
    return await converse(db, conversation_id, text.trim());
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

  /** Re-run the full pipeline over a stored meeting. Idempotent; keeps corrections. */
  async "POST /api/meeting/regenerate"(p, body) {
    const { id } = (body ?? {}) as { id?: string };
    if (!id) return { error: "missing id" };
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
      const { exit, steps, stored } = await processMeeting(db, apiKey, {
        id: meeting.id,
        title: meeting.title,
        mode: meeting.mode,
        startedAt: meeting.started_at,
        utterances,
      });
      return { ok: true, exit, steps, stored };
    } finally {
      regenerating.delete(id);
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

  "GET /api/corrections"() {
    return db.prepare(`SELECT * FROM corrections ORDER BY created_at DESC`).all();
  },

  /** Live transcript so far — lets Enhance run mid-recording. */
  "GET /api/record/transcript"() {
    return { utterances: live?.transcript ?? [], recording: !!live, meetingId: live?.meetingId ?? null };
  },

  /** AI-polish the user's rough notes in place. Versioned. */
  async "POST /api/notes/enhance"(p, body) {
    const { id, notes } = (body ?? {}) as { id?: string; notes?: string };
    if (!id) return { error: "missing id" };
    if (!hasOpenAI()) return { error: "OPENAI_API_KEY not configured — enhance needs it" };
    const utterances = meetingTranscript(id);
    if (!utterances.length) return { error: "no transcript yet" };
    return await enhanceNotes(db, id, notes ?? "", utterances);
  },

  /** Full structured notes: sections, team-wise action items, person inference. */
  async "POST /api/notes/structure"(p, body) {
    const { id, notes } = (body ?? {}) as { id?: string; notes?: string };
    if (!id) return { error: "missing id" };
    if (!hasOpenAI()) return { error: "OPENAI_API_KEY not configured — structure needs it" };
    const utterances = meetingTranscript(id);
    if (!utterances.length) return { error: "no transcript yet" };
    const meeting = db.prepare(`SELECT title FROM meetings WHERE id = ?`).get(id) as { title: string } | undefined;
    return await structureNotes(db, id, notes ?? "", utterances, meeting?.title ?? "Meeting");
  },

  /** Ask-me chat: grounded answers; may rewrite the notes when asked. */
  async "POST /api/chat"(p, body) {
    const { meeting_id, message, history, notes } = (body ?? {}) as {
      meeting_id?: string; message?: string;
      history?: { role: "user" | "assistant"; content: string }[]; notes?: string;
    };
    if (!meeting_id || !message?.trim()) return { error: "missing fields" };
    if (!hasOpenAI()) return { error: "OPENAI_API_KEY not configured — chat needs it" };
    const utterances = meetingTranscript(meeting_id);
    if (!utterances.length) return { error: "no transcript yet" };
    return await chatAboutMeeting(db, meeting_id, message.trim(), history ?? [], notes ?? "", utterances);
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

  "POST /api/correction/delete"(p, body) {
    const { id } = (body ?? {}) as { id?: number };
    if (!id) return { error: "missing id" };
    db.prepare(`DELETE FROM corrections WHERE id = ?`).run(id);
    return { ok: true };
  },
};

const regenerating = new Set<string>();

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
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
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
