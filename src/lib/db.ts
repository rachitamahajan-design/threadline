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
  // ── The brain: canonical entities ──────────────────────────────────────
  // `nodes`/`edges` above are a DERIVED PROJECTION of what follows. Canonical
  // truth lives here, so the same topic said two ways is one thing with two
  // aliases — which is what makes "which meetings discussed X" answerable.
  // Every alias and every mention carries the reason it was attached, so a
  // merge is auditable the same way a claim is.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,            -- 'topic:anz-pricing' — stable forever
      kind TEXT NOT NULL,             -- person | topic
      label TEXT NOT NULL,            -- best-known surface form
      created_at INTEGER NOT NULL,
      merged_into TEXT REFERENCES entities(id),  -- tombstone, never deleted
      pinned INTEGER NOT NULL DEFAULT 0          -- a human ruled; don't override
    );

    -- Every surface form ever seen, with the matcher that attached it.
    CREATE TABLE IF NOT EXISTS entity_aliases (
      entity_id TEXT NOT NULL REFERENCES entities(id),
      norm TEXT NOT NULL,             -- normalize(alias) — the join key
      alias TEXT NOT NULL,            -- raw form as extracted
      matcher TEXT NOT NULL,          -- alias | slug | lexical | manual | seed
      score REAL NOT NULL,
      reason TEXT NOT NULL,           -- receipt for THIS alias, as a sentence
      created_at INTEGER NOT NULL,
      PRIMARY KEY (entity_id, norm)
    );

    -- One row per (entity, meeting) sighting. Same gate vocabulary as claims.
    CREATE TABLE IF NOT EXISTS entity_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      claim_id INTEGER,
      surface TEXT NOT NULL,
      offset_s REAL,                  -- receipt: where in the call
      quote TEXT,                     -- receipt: what was actually said
      source TEXT NOT NULL,           -- coverage_gap | decision | action | ngram | speaker
      matcher TEXT NOT NULL,
      score REAL NOT NULL,
      gate TEXT NOT NULL DEFAULT 'passed',
      gate_reason TEXT,
      UNIQUE (entity_id, meeting_id, surface)
    );

    -- Retrieval chunks: the unit of search. A window of adjacent utterances
    -- (so a question and its answer land in one chunk), plus one chunk per
    -- passed claim and one per meeting summary. start_offset_s is the
    -- deep-link anchor the old meeting-level search never had.
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      kind TEXT NOT NULL,             -- window | claim | summary
      src_id INTEGER NOT NULL,        -- window: first utterance idx; claim: claims.id; summary: 0
      start_offset_s REAL NOT NULL,
      end_offset_s REAL NOT NULL,
      speakers TEXT,
      text TEXT NOT NULL,
      UNIQUE (meeting_id, kind, src_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON chunks(meeting_id, kind);

    -- External-content FTS over chunks: porter stemming ("migrations" now
    -- matches "migration"), prefix index for typeahead, and triggers keep it
    -- in sync so the duplicate-rows-on-reprocess bug class cannot recur.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
      text, speakers,
      content='chunks', content_rowid='id',
      tokenize='porter unicode61 remove_diacritics 2',
      prefix='2 3 4'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunk_fts(rowid, text, speakers) VALUES (new.id, new.text, new.speakers);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunk_fts(chunk_fts, rowid, text, speakers) VALUES('delete', old.id, old.text, old.speakers);
    END;

    -- Needle: conversations with the brain. Messages carry their receipts and
    -- the chunk ids they retrieved, so later turns ground against the union of
    -- everything the conversation has already seen.
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      project_id INTEGER,             -- optional scope
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,             -- user | assistant
      content TEXT NOT NULL,          -- user text, or assistant summary
      payload TEXT,                   -- assistant: JSON {points, blocked, mode, exit, chunk_ids}
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

    CREATE INDEX IF NOT EXISTS idx_alias_norm       ON entity_aliases(norm);
    CREATE INDEX IF NOT EXISTS idx_mentions_entity  ON entity_mentions(entity_id, meeting_id);
    CREATE INDEX IF NOT EXISTS idx_mentions_meeting ON entity_mentions(meeting_id, gate);
    CREATE INDEX IF NOT EXISTS idx_entities_kind    ON entities(kind, merged_into);

    -- No index existed on any table before this line. These are the columns the
    -- cross-meeting queries actually filter and join on.
    CREATE INDEX IF NOT EXISTS idx_edges_dst        ON edges(dst, kind);
    CREATE INDEX IF NOT EXISTS idx_edges_meeting    ON edges(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_claims_meeting   ON claims(meeting_id, kind, gate);
    CREATE INDEX IF NOT EXISTS idx_claims_todos     ON claims(kind, gate, done);
    CREATE INDEX IF NOT EXISTS idx_utt_speaker      ON utterances(speaker);
    CREATE INDEX IF NOT EXISTS idx_runs_meeting     ON runs(meeting_id, id DESC);
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
  // Additive migration: a meeting's length as the user says it is. NULL means
  // "nobody told us" — the list SQL then falls back to the transcript's own
  // last offset, so a duration always shows.
  try {
    db.exec("ALTER TABLE meetings ADD COLUMN duration_minutes INTEGER");
  } catch {
    /* column already exists */
  }
  // Additive migration: manually-added upcoming meetings can carry an end,
  // the same way Google events do.
  try {
    db.exec("ALTER TABLE upcoming ADD COLUMN end_ms INTEGER");
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
  // STT confidence per line. Absent means "no reason to doubt it" (1.0); when the
  // speech module starts reporting it, claims resting only on poorly-heard lines
  // get flagged instead of silently trusted.
  try {
    db.exec("ALTER TABLE utterances ADD COLUMN confidence REAL");
  } catch {
    /* column already exists */
  }
  // The handoff taxonomy (investor | vendor | customer | team | one_on_one).
  // Nullable: it is normally derived from `mode`, and only stored when the user
  // overrides it — a derived value that gets written down starts to drift.
  try {
    db.exec("ALTER TABLE meetings ADD COLUMN meeting_type TEXT");
  } catch {
    /* column already exists */
  }

  // ── Grounded notes & handoffs ────────────────────────────────────────────
  // Extraction is cached per meeting because every handoff composes from the
  // same fact list; regenerating a handoff must not re-pay for pass 1 or,
  // worse, compose from a *different* set of facts than the notes did.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_facts (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
      json TEXT NOT NULL,             -- Fact[]
      dropped TEXT,                   -- JSON: facts the sanitiser refused, with reasons
      prompt_version TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- The themed outline: always-on notes. One current row per meeting, with
    -- every previous state recoverable, same invariant as notes_versions.
    CREATE TABLE IF NOT EXISTS note_outlines (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
      json TEXT NOT NULL,             -- Notes { themes: NoteBullet[] }
      prompt_version TEXT NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      failures TEXT,                  -- JSON Failure[] from the last validation
      dropped INTEGER NOT NULL DEFAULT 0,
      edited INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outline_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,
      json TEXT NOT NULL,
      source TEXT NOT NULL,           -- generated | user | refine | regenerate
      created_at INTEGER NOT NULL
    );

    -- One row per Handoff the user actually asked for. Nothing here is ever
    -- created by the pipeline on its own.
    CREATE TABLE IF NOT EXISTS handoff_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL,       -- '' for cross-meeting runs
      scope_ids TEXT,                 -- JSON meeting ids for cross-meeting runs
      handoff_id TEXT NOT NULL,
      json TEXT NOT NULL,             -- the structured output
      markdown TEXT NOT NULL,         -- clipboard form at generation time
      prompt_version TEXT NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0,
      failures TEXT,
      edited INTEGER NOT NULL DEFAULT 0,
      edited_markdown TEXT,           -- the user's version; never clobbered silently
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_handoff_meeting ON handoff_runs(meeting_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_outline_versions ON outline_versions(meeting_id, id DESC);
  `);

  migrateEdgesPk(db);

  return db;
}

/**
 * The edges PK was (src,dst,kind), which excludes meeting_id — so a second
 * meeting's evidence for the same pair was silently dropped by ON CONFLICT.
 * That makes per-meeting evidence unrepresentable, which the brain needs.
 *
 * meeting_id becomes NOT NULL DEFAULT '' deliberately: the backlink query in
 * server/index.ts compares `e2.meeting_id != e1.meeting_id`, and in SQL
 * `NULL != x` is NULL, not true — so nullable meeting_ids silently drop rows.
 */
function migrateEdgesPk(d: DatabaseSync) {
  const done = d.prepare("SELECT value FROM meta WHERE key = 'edges_pk_v2'").get();
  if (done) return;
  d.exec(`
    BEGIN;
    CREATE TABLE IF NOT EXISTS edges_v2 (
      src TEXT NOT NULL REFERENCES nodes(id),
      dst TEXT NOT NULL REFERENCES nodes(id),
      kind TEXT NOT NULL,
      meeting_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (src, dst, kind, meeting_id)
    );
    INSERT OR IGNORE INTO edges_v2 (src, dst, kind, meeting_id)
      SELECT src, dst, kind, COALESCE(meeting_id, '') FROM edges;
    DROP TABLE edges;
    ALTER TABLE edges_v2 RENAME TO edges;
    CREATE INDEX IF NOT EXISTS idx_edges_dst     ON edges(dst, kind);
    CREATE INDEX IF NOT EXISTS idx_edges_meeting ON edges(meeting_id);
    INSERT INTO meta (key, value) VALUES ('edges_pk_v2', '1');
    COMMIT;
  `);
}

export function slug(kind: string, label: string) {
  return `${kind}:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/**
 * `canonical` is what lets a node's label improve over time. Without it the
 * first casing ever seen wins forever, so a canonical entity could never
 * correct the label of a node seeded from a worse surface form.
 */
export function upsertNode(
  d: DatabaseSync,
  kind: string,
  label: string,
  opts: { id?: string; canonical?: boolean } = {},
): string {
  const id = opts.id ?? (kind === "meeting" ? label : slug(kind, label));
  d.prepare(
    opts.canonical
      ? "INSERT INTO nodes (id, kind, label) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label"
      : "INSERT INTO nodes (id, kind, label) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).run(id, kind, label);
  return id;
}

export function addEdge(d: DatabaseSync, src: string, dst: string, kind: string, meetingId?: string) {
  d.prepare(
    "INSERT INTO edges (src, dst, kind, meeting_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(src, dst, kind, meetingId ?? null);
}
