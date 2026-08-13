/**
 * Threadline local server. Serves the UI and a small JSON API over the local
 * SQLite database. Localhost only — nothing is exposed to the network.
 *
 *   npm run dev   →  http://localhost:4640
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.js";
import { LiveSession, type LiveEvent } from "./live.js";
import { ensureApiKey } from "../lib/firstrun.js";
import { googleConfigured, googleConnected, authUrl, exchangeCode, upcomingEvents } from "./google.js";

// tiny .env loader
for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const db = openDb();
const PORT = Number(process.env.PORT ?? 4640);
const PUBLIC = path.resolve("public");

const apiKey = await ensureApiKey().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
let live: LiveSession | null = null;
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
        `SELECT c.id, c.body, c.quote, c.offset_s, c.done, m.title AS meeting_title, m.id AS meeting_id, m.started_at
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
                (SELECT COUNT(*) FROM claims WHERE kind='action_item' AND gate='passed' AND done=0) AS open_actions,
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
    const meeting = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id);
    if (!meeting) return { error: "not found" };
    const utterances = db.prepare(`SELECT * FROM utterances WHERE meeting_id = ? ORDER BY idx`).all(id);
    const claims = (db.prepare(`SELECT * FROM claims WHERE meeting_id = ?`).all(id) as { body: string }[]).map(
      (c) => ({ ...c, body: JSON.parse(c.body) }),
    );
    const runs = (db.prepare(`SELECT * FROM runs WHERE meeting_id = ? ORDER BY id DESC LIMIT 1`).all(id) as { steps: string }[]).map(
      (r) => ({ ...r, steps: JSON.parse(r.steps) }),
    );
    // backlinks: other meetings sharing a person/topic node with this one
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
         WHERE e1.meeting_id = ? AND n.kind != 'meeting'`,
      )
      .all(id, id);
    return { meeting, utterances, claims, runs: runs[0] ?? null, backlinks };
  },

  "GET /api/graph"() {
    const nodes = db.prepare(`SELECT n.*, (SELECT title FROM meetings WHERE id = n.id) AS meeting_title FROM nodes n`).all();
    const edges = db.prepare(`SELECT * FROM edges`).all();
    return { nodes, edges };
  },

  "GET /api/search"(p) {
    const q = (p.get("q") ?? "").trim();
    if (!q) return [];
    const safe = q.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
    if (!safe) return [];
    return db
      .prepare(
        `SELECT DISTINCT m.id, m.title, m.started_at, snippet(search, 2, '<b>', '</b>', '…', 12) AS hit
         FROM search s JOIN meetings m ON m.id = s.meeting_id
         WHERE search MATCH ? ORDER BY rank LIMIT 20`,
      )
      .all(safe.split(/\s+/).map((w) => `"${w}"`).join(" OR "));
  },

  "POST /api/record/start"(p, body) {
    if (live) return { error: "already recording" };
    const { title, mode } = (body ?? {}) as { title?: string; mode?: string };
    recentEvents.length = 0;
    live = new LiveSession(db, apiKey, title?.trim() || `Meeting ${new Date().toLocaleString()}`, mode ?? "discovery");
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

  "GET /api/record/state"() {
    return { recording: !!live, meetingId: live?.meetingId ?? null, title: live?.title ?? null };
  },

  "GET /api/projects"() {
    return db
      .prepare(
        `SELECT p.id, p.name,
          (SELECT COUNT(*) FROM meeting_projects mp WHERE mp.project_id = p.id) AS n_meetings,
          (SELECT COUNT(*) FROM meeting_projects mp JOIN claims c ON c.meeting_id = mp.meeting_id
             WHERE mp.project_id = p.id AND c.kind='action_item' AND c.gate='passed' AND c.done=0) AS n_open
         FROM projects p ORDER BY p.created_at DESC`,
      )
      .all();
  },

  "POST /api/project"(p, body) {
    const { name } = (body ?? {}) as { name?: string };
    if (!name?.trim()) return { error: "missing name" };
    db.prepare(`INSERT INTO projects (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING`).run(name.trim(), Date.now());
    return db.prepare(`SELECT id, name FROM projects WHERE name = ?`).get(name.trim());
  },

  "POST /api/project/assign"(p, body) {
    const { project_id, meeting_id, remove } = (body ?? {}) as { project_id?: number; meeting_id?: string; remove?: boolean };
    if (!project_id || !meeting_id) return { error: "missing ids" };
    if (remove) db.prepare(`DELETE FROM meeting_projects WHERE project_id = ? AND meeting_id = ?`).run(project_id, meeting_id);
    else db.prepare(`INSERT INTO meeting_projects (meeting_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(meeting_id, project_id);
    return { ok: true };
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
        `SELECT c.id, c.kind, c.body, c.done, c.quote, m.title AS meeting_title, m.id AS meeting_id, m.started_at
         FROM meeting_projects mp JOIN claims c ON c.meeting_id = mp.meeting_id JOIN meetings m ON m.id = mp.meeting_id
         WHERE mp.project_id = ? AND c.gate = 'passed' AND c.kind IN ('decision','action_item') ORDER BY m.started_at DESC`,
      )
      .all(id) as { body: string }[]).map((c) => ({ ...c, body: JSON.parse(c.body) }));
    const people = db
      .prepare(
        `SELECT DISTINCT u.speaker FROM meeting_projects mp JOIN utterances u ON u.meeting_id = mp.meeting_id
         WHERE mp.project_id = ? AND u.speaker IS NOT NULL`,
      )
      .all(id);
    return { project, meetings, claims, people };
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
        `SELECT c.body, c.quote, m.title AS meeting_title, m.id AS meeting_id FROM claims c JOIN meetings m ON m.id = c.meeting_id
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
    return { ok: true };
  },

  "POST /api/todo"(p, body) {
    const { id, done } = body as { id: number; done: boolean };
    db.prepare(`UPDATE claims SET done = ? WHERE id = ? AND kind = 'action_item'`).run(done ? 1 : 0, id);
    return { ok: true };
  },
};

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
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream" });
    res.end(readFileSync(full));
    return;
  }
  res.writeHead(404);
  res.end("not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Threadline running → http://localhost:${PORT}`);
});
