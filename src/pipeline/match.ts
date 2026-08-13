/**
 * Project matching: which of the user's projects does this meeting belong to?
 *
 * The model only ever suggests — rows land in project_suggestions as
 * 'pending' and the user accepts or dismisses them on the meeting page.
 * A dismissed pair is never re-suggested (UNIQUE key + insert-or-nothing),
 * and reprocessing a meeting replaces only its still-pending suggestions.
 */
import { DatabaseSync } from "node:sqlite";
import { chatJSON } from "../lib/openai.js";
import { retry, type Budget, type StepRecord } from "../lib/harness.js";
import type { RecapRecord } from "../lib/pyai.js";
import type { MeetingInput } from "./extract.js";

const SYSTEM = `You match a meeting to existing projects in a personal workspace.

Suggest a project only when the meeting clearly concerns it — shared topic,
shared people, or work the project's documents and decisions describe. When
nothing matches, return an empty list. Never invent project ids.

Reply with JSON exactly matching this schema:
{
  "suggestions": [
    {"project_id": number, "confidence": number, "reason": string}
  ]
}

Rules:
- "confidence" is 0 to 1; only include suggestions you'd defend at 0.5+.
- "reason" is one short sentence citing the concrete overlap.`;

type ProjectContext = {
  id: number;
  name: string;
  description: string | null;
};

export async function suggestProjects(
  db: DatabaseSync,
  budget: Budget,
  m: MeetingInput,
  rec: RecapRecord | null,
): Promise<StepRecord | null> {
  // Regenerate replaces pending suggestions; accepted/dismissed are the
  // user's calls and persist.
  db.prepare(`DELETE FROM project_suggestions WHERE meeting_id = ? AND status = 'pending'`).run(m.id);

  // Candidates: projects the meeting isn't filed in and wasn't dismissed from.
  const candidates = db
    .prepare(
      `SELECT p.id, p.name, p.description FROM projects p
       WHERE p.id NOT IN (SELECT project_id FROM meeting_projects WHERE meeting_id = ?)
         AND p.id NOT IN (SELECT project_id FROM project_suggestions WHERE meeting_id = ? AND status = 'dismissed')`,
    )
    .all(m.id, m.id) as ProjectContext[];
  if (!candidates.length) return null;

  const projectContext = candidates.map((p) => ({
    project_id: p.id,
    name: p.name,
    description: p.description ?? undefined,
    people: (db
      .prepare(
        `SELECT pe.name FROM project_people pp JOIN people pe ON pe.id = pp.person_id
         WHERE pp.project_id = ? LIMIT 10`,
      )
      .all(p.id) as { name: string }[]).map((r) => r.name),
    documents: (db
      .prepare(`SELECT title, content FROM documents WHERE project_id = ? ORDER BY updated_at DESC LIMIT 5`)
      .all(p.id) as { title: string; content: string | null }[]).map((d) => ({
      title: d.title,
      excerpt: d.content?.slice(0, 300) ?? undefined,
    })),
    recent_decisions: (db
      .prepare(
        `SELECT COALESCE(c.edited_body, c.body) AS body FROM meeting_projects mp
         JOIN claims c ON c.meeting_id = mp.meeting_id JOIN meetings mt ON mt.id = mp.meeting_id
         WHERE mp.project_id = ? AND c.kind = 'decision' AND c.gate = 'passed'
         ORDER BY mt.started_at DESC LIMIT 5`,
      )
      .all(p.id) as { body: string }[]).map((r) => {
      try { return (JSON.parse(r.body) as { text?: string }).text ?? r.body; } catch { return r.body; }
    }),
  }));

  const meeting = db
    .prepare(`SELECT title, headline, summary FROM meetings WHERE id = ?`)
    .get(m.id) as { title: string; headline: string | null; summary: string | null } | undefined;
  const speakers = [...new Set(m.utterances.map((u) => u.speaker).filter(Boolean))];
  const meetingContext = {
    title: meeting?.title ?? m.title,
    headline: meeting?.headline ?? rec?.tldr ?? undefined,
    summary: (meeting?.summary ?? rec?.summary ?? rec?.summary_draft ?? "").slice(0, 3000) || undefined,
    speakers,
    decisions: rec?.key_decisions ?? [],
    action_items: (rec?.action_items ?? []).map((a) => a.task),
  };

  const validIds = new Set(candidates.map((c) => c.id));
  const result = await retry(
    "match:projects",
    budget,
    async (_attempt, lastError) => {
      const feedback = lastError
        ? `\n\nYour previous reply was rejected: ${lastError}\nFix these problems and reply with valid JSON only.`
        : "";
      const raw = (await chatJSON(
        SYSTEM + feedback,
        `Meeting:\n${JSON.stringify(meetingContext, null, 1)}\n\nProjects:\n${JSON.stringify(projectContext, null, 1)}`,
      )) as { suggestions?: unknown };
      budget.spendUnits(1);
      if (!Array.isArray(raw.suggestions)) throw new Error("missing suggestions array");
      return raw.suggestions
        .filter(
          (s): s is { project_id: number; confidence: number; reason?: string } =>
            !!s && typeof s === "object" &&
            validIds.has((s as { project_id?: unknown }).project_id as number) &&
            typeof (s as { confidence?: unknown }).confidence === "number",
        )
        .filter((s) => s.confidence >= 0.5);
    },
    { max: 2 },
  );

  if (result.value) {
    const ins = db.prepare(
      `INSERT INTO project_suggestions (meeting_id, project_id, confidence, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING`,
    );
    for (const s of result.value) ins.run(m.id, s.project_id, s.confidence, s.reason ?? null, Date.now());
  }
  return result.record;
}
