/**
 * The correction engine: fix a model mistake once, propagate it everywhere.
 *
 *   preview: findOccurrences() scans every store that can carry the wrong
 *            text (transcript, claims, structured summary, meeting fields,
 *            graph nodes) — exact word-boundary hits plus fuzzy hits for
 *            STT spelling variants ("Vaheeda" for "Vahida").
 *   apply:   applyCorrection() rewrites only the occurrences the user
 *            accepted, in one transaction, then reindexes search and
 *            remembers the fix in the corrections dictionary.
 *   forward: applyDictionary() rewrites utterance text before extraction,
 *            so regenerates and future meetings never repeat the mistake.
 */
import { DatabaseSync } from "node:sqlite";
import { slug, upsertNode } from "../lib/db.js";
import { reindexMeeting } from "./extract.js";
import { bulletAt, walkBullets, type StructuredSummary } from "../lib/summary.js";
import type { Utterance } from "../lib/pyai.js";

export type Occurrence = {
  target: "utterance" | "claim" | "summary" | "node" | "meeting_field";
  /** Deterministic address: "<target>:<key>#<field>#<matched token>". */
  ref: string;
  field: string;
  /** The exact text that matched — from_text itself, or a fuzzy variant. */
  token: string;
  snippet: string;
  match: "exact" | "fuzzy";
};

const wordRegex = (token: string) =>
  new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");

/** Fuzzy candidates: capitalized tokens within a small edit distance of `from`. */
function fuzzyVariants(text: string, from: string, to: string): string[] {
  const maxDist = from.length <= 5 ? 1 : 2;
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z]{2,}\b/g)) {
    const w = m[0];
    const lw = w.toLowerCase();
    if (lw === from.toLowerCase() || lw === to.toLowerCase()) continue;
    if (editDistance(lw, from.toLowerCase()) <= maxDist) seen.add(w);
  }
  return [...seen];
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3; // early out, we never need > 2
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = prev[j];
      prev[j] = cur;
    }
  }
  return prev[b.length];
}

function snippetAround(text: string, token: string): string {
  const i = text.toLowerCase().indexOf(token.toLowerCase());
  if (i < 0) return text.slice(0, 80);
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + token.length + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** All matches (exact + fuzzy) of the correction inside one text field. */
function matchesIn(text: string | null, from: string, to: string): { token: string; match: "exact" | "fuzzy" }[] {
  if (!text) return [];
  const out: { token: string; match: "exact" | "fuzzy" }[] = [];
  if (wordRegex(from).test(text)) out.push({ token: from, match: "exact" });
  for (const v of fuzzyVariants(text, from, to)) out.push({ token: v, match: "fuzzy" });
  return out;
}

/** Every place the wrong text appears for this meeting. Applies nothing. */
export function findOccurrences(db: DatabaseSync, meetingId: string, from: string, to: string): Occurrence[] {
  const out: Occurrence[] = [];
  const add = (target: Occurrence["target"], key: string | number, field: string, text: string | null) => {
    for (const m of matchesIn(text, from, to))
      out.push({
        target,
        ref: `${target}:${key}#${field}#${m.token}`,
        field,
        token: m.token,
        snippet: snippetAround(text!, m.token),
        match: m.match,
      });
  };

  const utts = db
    .prepare("SELECT idx, text FROM utterances WHERE meeting_id = ? ORDER BY idx")
    .all(meetingId) as { idx: number; text: string }[];
  for (const u of utts) add("utterance", u.idx, "text", u.text);

  const claims = db
    .prepare("SELECT id, body, edited_body, quote FROM claims WHERE meeting_id = ?")
    .all(meetingId) as { id: number; body: string; edited_body: string | null; quote: string | null }[];
  for (const c of claims) {
    add("claim", c.id, "body", c.edited_body ?? c.body);
    add("claim", c.id, "quote", c.quote);
  }

  const meeting = db
    .prepare("SELECT title, headline, summary, summary_json, my_notes FROM meetings WHERE id = ?")
    .get(meetingId) as
    | { title: string; headline: string | null; summary: string | null; summary_json: string | null; my_notes: string | null }
    | undefined;
  if (meeting) {
    if (meeting.summary_json) {
      try {
        const s = JSON.parse(meeting.summary_json) as StructuredSummary;
        add("summary", "overview", "overview", s.overview);
        walkBullets(s, (b, path) => {
          add("summary", path, "text", b.text);
          if (b.quote) add("summary", path, "quote", b.quote);
        });
      } catch {
        /* unreadable summary_json — nothing to offer */
      }
    }
    for (const field of ["title", "headline", "summary", "my_notes"] as const)
      add("meeting_field", field, field, meeting[field]);
  }

  const nodes = db
    .prepare(
      `SELECT DISTINCT n.id, n.label FROM nodes n
       JOIN edges e ON (e.src = n.id OR e.dst = n.id)
       WHERE e.meeting_id = ? AND n.kind != 'meeting'`,
    )
    .all(meetingId) as { id: string; label: string }[];
  for (const n of nodes) add("node", n.id, "label", n.label);

  return out;
}

/** Before-values captured per correction so it can be undone verbatim. */
type CorrectionSnapshot = {
  utterances: { idx: number; text: string }[];
  claims: { id: number; edited_body: string | null; quote: string | null; source: string }[];
  summary_json: string | null;
  meeting_fields: Record<string, string | null>;
  nodes: { id: string; kind: string; label: string }[];
  edges: { src: string; dst: string; kind: string; meeting_id: string | null }[];
};

export function applyCorrection(
  db: DatabaseSync,
  meetingId: string,
  acceptedRefs: string[],
  opts: { from: string; to: string; persistGlobal: boolean },
): { applied: number; eventId: number | null } {
  const accepted = new Set(acceptedRefs);
  const occurrences = findOccurrences(db, meetingId, opts.from, opts.to).filter((o) => accepted.has(o.ref));
  if (occurrences.length === 0) return { applied: 0, eventId: null };

  const sub = (text: string, token: string) => text.replace(wordRegex(token), opts.to);
  const snapshot: CorrectionSnapshot = {
    utterances: [], claims: [], summary_json: null, meeting_fields: {}, nodes: [], edges: [],
  };

  db.exec("BEGIN");
  try {
    let summaryTouched = false;
    let summary: StructuredSummary | null = null;
    const meeting = db
      .prepare("SELECT summary_json FROM meetings WHERE id = ?")
      .get(meetingId) as { summary_json: string | null } | undefined;
    if (meeting?.summary_json) {
      try {
        summary = JSON.parse(meeting.summary_json) as StructuredSummary;
      } catch {
        summary = null;
      }
    }

    const seen = new Set<string>();
    const captureOnce = (kind: string, key: string, fn: () => void) => {
      const k = `${kind}:${key}`;
      if (!seen.has(k)) { seen.add(k); fn(); }
    };
    if (meeting) snapshot.summary_json = meeting.summary_json;

    for (const o of occurrences) {
      const [, keyAndRest] = o.ref.split(/:(.*)/s);
      const key = keyAndRest.split("#")[0];

      if (o.target === "utterance") {
        const row = db
          .prepare("SELECT text FROM utterances WHERE meeting_id = ? AND idx = ?")
          .get(meetingId, Number(key)) as { text: string } | undefined;
        if (row) {
          captureOnce("utt", key, () => snapshot.utterances.push({ idx: Number(key), text: row.text }));
          db.prepare("UPDATE utterances SET text = ? WHERE meeting_id = ? AND idx = ?").run(
            sub(row.text, o.token),
            meetingId,
            Number(key),
          );
        }
      } else if (o.target === "claim") {
        const row = db
          .prepare("SELECT body, edited_body, quote, source FROM claims WHERE id = ?")
          .get(Number(key)) as { body: string; edited_body: string | null; quote: string | null; source: string } | undefined;
        if (!row) continue;
        captureOnce("claim", key, () =>
          snapshot.claims.push({ id: Number(key), edited_body: row.edited_body, quote: row.quote, source: row.source }));
        if (o.field === "body") {
          // Rewrite every string value in the JSON; body stays pristine as evidence.
          const body = JSON.parse(row.edited_body ?? row.body) as Record<string, unknown>;
          for (const [k, v] of Object.entries(body)) if (typeof v === "string") body[k] = sub(v, o.token);
          db.prepare("UPDATE claims SET edited_body = ?, source = 'correction' WHERE id = ?").run(
            JSON.stringify(body),
            Number(key),
          );
        } else if (o.field === "quote" && row.quote) {
          // Quote must track the corrected transcript or the grounding gate breaks.
          db.prepare("UPDATE claims SET quote = ?, source = 'correction' WHERE id = ?").run(
            sub(row.quote, o.token),
            Number(key),
          );
        }
      } else if (o.target === "summary" && summary) {
        if (key === "overview") {
          summary.overview = sub(summary.overview, o.token);
        } else {
          const b = bulletAt(summary, key);
          if (b) {
            if (o.field === "text") b.text = sub(b.text, o.token);
            if (o.field === "quote" && b.quote) b.quote = sub(b.quote, o.token);
            b.edited = true;
          }
        }
        summaryTouched = true;
      } else if (o.target === "meeting_field") {
        const row = db
          .prepare(`SELECT ${key} AS v FROM meetings WHERE id = ?`)
          .get(meetingId) as { v: string | null } | undefined;
        if (row?.v != null) {
          captureOnce("field", key, () => { snapshot.meeting_fields[key] = row.v; });
          db.prepare(`UPDATE meetings SET ${key} = ? WHERE id = ?`).run(sub(row.v, o.token), meetingId);
        }
      } else if (o.target === "node") {
        captureOnce("node", key, () => {
          const n = db.prepare("SELECT id, kind, label FROM nodes WHERE id = ?").get(key) as
            | { id: string; kind: string; label: string }
            | undefined;
          if (n) {
            snapshot.nodes.push(n);
            snapshot.edges.push(
              ...(db
                .prepare("SELECT src, dst, kind, meeting_id FROM edges WHERE src = ? OR dst = ?")
                .all(key, key) as CorrectionSnapshot["edges"]),
            );
          }
        });
        mergeNode(db, key, opts.to);
      }
    }

    if (summaryTouched && summary) {
      db.prepare(
        "INSERT INTO summary_versions (meeting_id, json, source, created_at) VALUES (?, ?, 'correction', ?)",
      ).run(meetingId, meeting!.summary_json!, Date.now());
      db.prepare("UPDATE meetings SET summary_json = ? WHERE id = ?").run(JSON.stringify(summary), meetingId);
    }

    reindexMeeting(db, meetingId);

    db.prepare(
      "INSERT INTO corrections (from_text, to_text, kind, scope, created_at) VALUES (?, ?, 'name', ?, ?) ON CONFLICT DO NOTHING",
    ).run(opts.from, opts.to, opts.persistGlobal ? "global" : `meeting:${meetingId}`, Date.now());

    const ev = db
      .prepare(
        "INSERT INTO correction_events (meeting_id, from_text, to_text, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(meetingId, opts.from, opts.to, JSON.stringify(snapshot), Date.now());

    db.exec("COMMIT");
    return { applied: occurrences.length, eventId: Number(ev.lastInsertRowid) };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Restore every value a correction touched, verbatim. One transaction. */
export function undoCorrection(db: DatabaseSync, eventId: number): { restored: boolean } {
  const ev = db
    .prepare("SELECT meeting_id, from_text, to_text, payload FROM correction_events WHERE id = ?")
    .get(eventId) as { meeting_id: string; from_text: string; to_text: string; payload: string } | undefined;
  if (!ev) return { restored: false };
  const snap = JSON.parse(ev.payload) as CorrectionSnapshot;

  db.exec("BEGIN");
  try {
    for (const u of snap.utterances)
      db.prepare("UPDATE utterances SET text = ? WHERE meeting_id = ? AND idx = ?").run(u.text, ev.meeting_id, u.idx);
    for (const c of snap.claims)
      db.prepare("UPDATE claims SET edited_body = ?, quote = ?, source = ? WHERE id = ?").run(
        c.edited_body, c.quote, c.source, c.id,
      );
    if (snap.summary_json !== null)
      db.prepare("UPDATE meetings SET summary_json = ? WHERE id = ?").run(snap.summary_json, ev.meeting_id);
    for (const [field, value] of Object.entries(snap.meeting_fields))
      if (["title", "headline", "summary", "my_notes"].includes(field))
        db.prepare(`UPDATE meetings SET ${field} = ? WHERE id = ?`).run(value, ev.meeting_id);
    // Un-merge nodes: recreate the old node, restore its exact edge rows, and
    // drop the merged-in edges that only existed because of the correction.
    for (const n of snap.nodes) {
      db.prepare("INSERT INTO nodes (id, kind, label) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").run(
        n.id, n.kind, n.label,
      );
      const newId = upsertNode(db, n.kind, ev.to_text);
      for (const e of snap.edges) {
        // Delete the rewritten twin on the new node, then restore the original.
        db.prepare("DELETE FROM edges WHERE src = ? AND dst = ? AND kind = ?").run(
          e.src === n.id ? newId : e.src, e.dst === n.id ? newId : e.dst, e.kind,
        );
        db.prepare(
          "INSERT OR IGNORE INTO edges (src, dst, kind, meeting_id) VALUES (?, ?, ?, ?)",
        ).run(e.src, e.dst, e.kind, e.meeting_id);
      }
      // If the merged node was created by this correction and now has no edges, sweep it.
      db.prepare(
        "DELETE FROM nodes WHERE id = ? AND id NOT IN (SELECT src FROM edges UNION SELECT dst FROM edges)",
      ).run(newId);
    }
    db.prepare("DELETE FROM corrections WHERE from_text = ? AND to_text = ?").run(ev.from_text, ev.to_text);
    db.prepare("DELETE FROM correction_events WHERE id = ?").run(eventId);
    reindexMeeting(db, ev.meeting_id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { restored: true };
}

/**
 * Detect "the user swapped one word/name for another" in an edit. Returns the
 * swap when exactly one contiguous token run differs and it looks like a name
 * fix, else null. Conservative: ordinary prose edits must not fire this.
 */
export function detectWordSwap(before: string, after: string): { from: string; to: string } | null {
  if (before === after || !before || !after) return null;
  if (Math.abs(before.length - after.length) > 40) return null;
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const from = a.slice(start, endA + 1).join("").trim();
  const to = b.slice(start, endB + 1).join("").trim();
  if (!from || !to || from === to) return null;
  if (from.includes("\n") || to.includes("\n")) return null;
  if (from.length > 40 || to.length > 40) return null;
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  if (words(from).length > 3 || words(to).length > 3) return null;
  // Name-shaped: replacement starts uppercase, and the two differ but resemble
  // each other (a respelling) or are both single capitalized tokens.
  const capitalized = /^[A-Z]/.test(to) && /^[A-Z]/.test(from);
  if (!capitalized) return null;
  return { from, to };
}

/** Rename = merge: move the old node's edges onto the new node, then drop it. */
function mergeNode(db: DatabaseSync, oldId: string, newLabel: string) {
  const old = db.prepare("SELECT kind FROM nodes WHERE id = ?").get(oldId) as { kind: string } | undefined;
  if (!old) return;
  const newId = upsertNode(db, old.kind, newLabel);
  if (newId === oldId) return;
  db.prepare(
    "INSERT OR IGNORE INTO edges (src, dst, kind, meeting_id) SELECT ?, dst, kind, meeting_id FROM edges WHERE src = ?",
  ).run(newId, oldId);
  db.prepare(
    "INSERT OR IGNORE INTO edges (src, dst, kind, meeting_id) SELECT src, ?, kind, meeting_id FROM edges WHERE dst = ?",
  ).run(newId, oldId);
  db.prepare("DELETE FROM edges WHERE src = ? OR dst = ?").run(oldId, oldId);
  db.prepare("DELETE FROM nodes WHERE id = ?").run(oldId);
}

/**
 * Rewrite utterance text through the corrections dictionary. Runs before
 * extraction so the summarizer never sees a mistake the user already fixed.
 */
export function applyDictionary(db: DatabaseSync, meetingId: string, utterances: Utterance[]): Utterance[] {
  const rules = db
    .prepare("SELECT from_text, to_text FROM corrections WHERE scope = 'global' OR scope = ?")
    .all(`meeting:${meetingId}`) as { from_text: string; to_text: string }[];
  if (rules.length === 0) return utterances;
  return utterances.map((u) => {
    let text = u.text;
    for (const r of rules) text = text.replace(wordRegex(r.from_text), r.to_text);
    const speaker = u.speaker ? rewriteName(u.speaker, rules) : u.speaker;
    return text === u.text && speaker === u.speaker ? u : { ...u, text, speaker };
  });
}

function rewriteName(name: string, rules: { from_text: string; to_text: string }[]): string {
  for (const r of rules) name = name.replace(wordRegex(r.from_text), r.to_text);
  return name;
}

// slug is imported for callers that need to predict merged node ids in tests
export { slug as nodeSlug };
