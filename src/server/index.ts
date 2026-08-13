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
    const meetings = db
      .prepare(`SELECT id, title, mode, started_at, duration_s, exit, headline FROM meetings ORDER BY started_at DESC LIMIT 10`)
      .all();
    return { todos, meetings };
  },

  "GET /api/meetings"() {
    return db.prepare(`SELECT id, title, mode, started_at, duration_s, exit, headline FROM meetings ORDER BY started_at DESC`).all();
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
