/**
 * Local-first storage. One SQLite file in ./data — nothing leaves the laptop.
 * Uses node:sqlite (built into Node 22+) so setup needs zero native builds.
 *
 * The graph lives here too: meetings, people and topics are nodes; edges are
 * derived from extraction (same person, same topic, explicit reference).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type MeetingRow = {
  id: string;
  title: string;
  mode: string;
  started_at: number;
  duration_s: number;
  exit: string | null;
  headline: string | null;
  summary: string | null;
};

let db: DatabaseSync | null = null;

export function openDb(dir = "data"): DatabaseSync {
  if (db) return db;
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, "opengranola.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'discovery',
      started_at INTEGER NOT NULL,
      duration_s REAL NOT NULL DEFAULT 0,
      exit TEXT,
      headline TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS utterances (
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      idx INTEGER NOT NULL,
      speaker TEXT,
      speaker_role TEXT NOT NULL,
      text TEXT NOT NULL,
      offset_s REAL NOT NULL,
      duration_s REAL NOT NULL,
      PRIMARY KEY (meeting_id, idx)
    );

    -- Claims are everything extracted from a meeting: decisions, action items,
    -- risks, moments. Each carries its receipt (offset/quote) and gate status.
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      kind TEXT NOT NULL,             -- decision | action_item | risk | moment | objection
      body TEXT NOT NULL,             -- JSON payload (task/owner/due, or description)
      offset_s REAL,                  -- receipt: where in the call
      quote TEXT,                     -- receipt: what was actually said
      gate TEXT NOT NULL,             -- passed | blocked
      gate_reason TEXT,
      done INTEGER NOT NULL DEFAULT 0 -- for action items: the checkbox
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,            -- 'person:sharon' | 'topic:anz-pricing' | meeting id
      kind TEXT NOT NULL,             -- meeting | person | topic
      label TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edges (
      src TEXT NOT NULL REFERENCES nodes(id),
      dst TEXT NOT NULL REFERENCES nodes(id),
      kind TEXT NOT NULL,             -- mentions | attended | references
      meeting_id TEXT,
      PRIMARY KEY (src, dst, kind)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
      meeting_id UNINDEXED, kind, text
    );

    -- Failure invariant: every pipeline run leaves a record, success or not.
    -- (schema migrations happen below, after CREATEs)
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      exit TEXT NOT NULL,
      steps TEXT NOT NULL,            -- JSON StepRecord[]
      units_spent REAL NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meeting_projects (
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      PRIMARY KEY (meeting_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS upcoming (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      participants TEXT
    );
  `);
  // Additive migration: user-editable notes alongside the generated ones.
  try {
    db.exec("ALTER TABLE meetings ADD COLUMN my_notes TEXT");
  } catch {
    /* column already exists */
  }
  return db;
}

export function slug(kind: string, label: string) {
  return `${kind}:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

export function upsertNode(d: DatabaseSync, kind: string, label: string): string {
  const id = kind === "meeting" ? label : slug(kind, label);
  d.prepare("INSERT INTO nodes (id, kind, label) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").run(
    id,
    kind,
    label,
  );
  return id;
}

export function addEdge(d: DatabaseSync, src: string, dst: string, kind: string, meetingId?: string) {
  d.prepare(
    "INSERT INTO edges (src, dst, kind, meeting_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(src, dst, kind, meetingId ?? null);
}
