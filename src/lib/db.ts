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
  summary_json: string | null;
};

let db: DatabaseSync | null = null;

export function openDb(dir = "data"): DatabaseSync {
  if (db) return db;
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  // FK clauses are documentation, not enforcement (node:sqlite enforces by
  // default): derived rows are cleaned up manually, and project-level action
  // items use meeting_id='' as a deliberate "no meeting" sentinel.
  db = new DatabaseSync(path.join(dir, "opengranola.db"), { enableForeignKeyConstraints: false });
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
  // Additive migrations: structured summary + human corrections layer.
  try {
    db.exec("ALTER TABLE meetings ADD COLUMN summary_json TEXT");
  } catch {
    /* column already exists */
  }
  try {
    db.exec("ALTER TABLE claims ADD COLUMN edited_body TEXT");
  } catch {
    /* column already exists */
  }
  try {
    db.exec("ALTER TABLE claims ADD COLUMN source TEXT DEFAULT 'model'");
  } catch {
    /* column already exists */
  }
  db.exec(`
    -- Every summary the user sees is recoverable: generation, edits and
    -- corrections all snapshot here before overwriting summary_json.
    CREATE TABLE IF NOT EXISTS summary_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      json TEXT NOT NULL,
      source TEXT NOT NULL,            -- generated | edited | correction
      created_at INTEGER NOT NULL
    );

    -- The corrections dictionary: "Vahida" → "Rachita", remembered so future
    -- meetings (and regenerates) never repeat a mistake the user already fixed.
    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_text TEXT NOT NULL,
      to_text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'name',     -- name | term
      scope TEXT NOT NULL DEFAULT 'global',  -- 'global' | 'meeting:<id>'
      created_at INTEGER NOT NULL,
      UNIQUE(from_text, to_text, scope)
    );

    -- The user's notes document is never lost: every AI rewrite and user
    -- baseline snapshots here first.
    CREATE TABLE IF NOT EXISTS notes_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      markdown TEXT NOT NULL,
      source TEXT NOT NULL,          -- user | enhance | structure | chat | undo
      created_at INTEGER NOT NULL
    );

    -- Auto-applied corrections are undoable: before-values captured per event.
    CREATE TABLE IF NOT EXISTS correction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      from_text TEXT NOT NULL,
      to_text TEXT NOT NULL,
      payload TEXT NOT NULL,         -- JSON before-values per applied ref
      created_at INTEGER NOT NULL
    );
  `);
  // Projects as workspaces: people directory, documents, and confirm-to-file
  // meeting suggestions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      team TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_people (
      project_id INTEGER NOT NULL REFERENCES projects(id),
      person_id INTEGER NOT NULL REFERENCES people(id),
      added_via TEXT NOT NULL DEFAULT 'manual',  -- manual | meeting
      PRIMARY KEY (project_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      kind TEXT NOT NULL,             -- upload | note
      filename TEXT,                  -- uploads: original name
      mime TEXT,
      path TEXT,                      -- uploads: data/docs/<id>-<safe-name>
      content TEXT,                   -- text content; NULL when not extractable (pdf)
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Same invariant as notes_versions: a doc is never lost to an overwrite.
    CREATE TABLE IF NOT EXISTS document_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id),
      markdown TEXT NOT NULL,
      source TEXT NOT NULL,           -- initial | user
      created_at INTEGER NOT NULL
    );

    -- The model only suggests; the user files. A dismissed pair is never
    -- re-suggested (UNIQUE key + insert-or-nothing).
    CREATE TABLE IF NOT EXISTS project_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      confidence REAL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | dismissed
      created_at INTEGER NOT NULL,
      UNIQUE(meeting_id, project_id)
    );
  `);
  try {
    db.exec("ALTER TABLE projects ADD COLUMN description TEXT");
  } catch {
    /* column already exists */
  }
  // Project-level manual action items live in claims (meeting_id='' sentinel).
  try {
    db.exec("ALTER TABLE claims ADD COLUMN project_id INTEGER");
  } catch {
    /* column already exists */
  }
  try {
    db.exec("ALTER TABLE claims ADD COLUMN person_id INTEGER");
  } catch {
    /* column already exists */
  }
  try {
    db.exec("ALTER TABLE claims ADD COLUMN document_id INTEGER");
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
