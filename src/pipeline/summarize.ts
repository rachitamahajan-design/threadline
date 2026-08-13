/**
 * Second-pass summarizer: turn a transcript + Recap's rough draft into the
 * structured document defined in lib/summary.ts.
 *
 * The harness around the weak model:
 *   - the exact JSON schema lives in the prompt
 *   - output is validated; validator errors are fed back into one retry
 *   - anchored bullets are grounded against the transcript afterwards
 */
import { chatJSON, flattenTranscript } from "../lib/openai.js";
import { validateSummary, groundSummary, type StructuredSummary } from "../lib/summary.js";
import { retry, type Budget, type StepRecord } from "../lib/harness.js";
import type { Utterance, RecapRecord } from "../lib/pyai.js";

const SYSTEM = `You restructure raw meeting material into a precise, well-organized summary document.

Reply with JSON exactly matching this schema:
{
  "schema_version": 1,
  "overview": string,          // 2-4 sentence prose overview of the meeting
  "sections": [
    {
      "title": string,
      "bullets": [{"text": string, "offset_s": number, "quote": string}],
      "subsections": [{"title": string, "bullets": [...]}]   // optional, max depth 2
    }
  ]
}

Rules:
- Use this fixed section order, omitting any section with nothing to say:
  "Discussion" (one subsection per topic actually discussed), "Decisions",
  "Action Items", "Risks & Concerns", "Open Questions".
- Every bullet in Discussion, Decisions and Risks MUST carry "offset_s" taken
  from the [Ns] markers in the transcript, and SHOULD carry a short verbatim
  "quote" from that moment. Never invent offsets or quotes.
- Action Item bullets name the owner exactly as they are named in the
  transcript, e.g. "Rachita: send the pricing deck by Friday".
- Only state facts supported by the transcript. The draft material may be
  wrong — the transcript is the source of truth. Prefer the transcript's
  spelling of names.
- Be specific: numbers, names, dates over vague phrasing. No filler bullets.`;

export async function structureSummary(
  budget: Budget,
  utterances: Utterance[],
  recap: RecapRecord | null,
): Promise<{ value: StructuredSummary | null; ungrounded: number; record: StepRecord }> {
  const transcript = flattenTranscript(utterances);
  const draft = recap
    ? "Draft material from a first-pass model (restructure it, do not trust it):\n" +
      JSON.stringify(
        {
          tldr: recap.tldr,
          summary: recap.summary ?? recap.summary_draft,
          key_decisions: recap.key_decisions,
          action_items: recap.action_items,
          risk_signals: recap.risk_signals,
          next_steps: recap.next_steps,
        },
        null,
        1,
      )
    : "No draft material available — work from the transcript alone.";

  const result = await retry(
    "summary:structure",
    budget,
    async (_attempt, lastError) => {
      const feedback = lastError
        ? `\n\nYour previous reply was rejected: ${lastError}\nFix these problems and reply with valid JSON only.`
        : "";
      const raw = await chatJSON(SYSTEM + feedback, `Transcript:\n${transcript}\n\n${draft}`);
      budget.spendUnits(1);
      const errors = validateSummary(raw);
      if (errors.length > 0) throw new Error(`schema validation failed: ${errors.slice(0, 5).join("; ")}`);
      return raw as StructuredSummary;
    },
    { max: 2 },
  );

  if (!result.value) return { value: null, ungrounded: 0, record: result.record };
  const { summary, ungrounded } = groundSummary(result.value, utterances);
  return { value: summary, ungrounded, record: result.record };
}
