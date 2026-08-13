/**
 * Prompt templates, versioned.
 *
 * Every generated output records the exact template version that produced it
 * (`notes.compose@v1`), so a regression traced to a prompt change is a diff away
 * rather than an archaeology project. Bump `version` whenever the text changes
 * in a way that could move output; never edit a released template silently.
 *
 * The behavioural rules here (§4.3) are best-effort. The guarantees live in
 * lib/grounding.ts. When the two disagree, the code wins and this text is what
 * gets rewritten.
 */

export type PromptTemplate<V = Record<string, unknown>> = {
  id: string;
  version: number;
  /** One line on what changed, for the debug drawer. */
  note: string;
  build: (vars: V) => string;
};

/**
 * Bumped whenever GROUNDING_RULES changes. It rides in every prompt, so a single
 * edit there moves every output — the stamp has to say so without needing six
 * separate version bumps.
 */
export const GROUNDING_RULES_VERSION = 2;

/** The stamp shown on every output: template version + shared-rules version. */
export function promptRef(t: PromptTemplate<never> | PromptTemplate<any>): string {
  return `${t.id}@v${t.version}+r${GROUNDING_RULES_VERSION}`;
}

/** Shared by every compose pass. One copy, so no handoff quietly drifts. */
export const GROUNDING_RULES = `Grounding rules — these outrank anything else in this prompt:
- Use ONLY the supplied EXTRACTED_FACTS. Never add, infer, embellish or "helpfully" complete a thought.
- Carry each fact's source segment ids forward onto the line that uses it. A line with no source is thrown away by a validator before the user sees it.
- Numbers, prices, percentages, dates and quoted text must match the cited segment text exactly. If you cannot reproduce it exactly, leave it out.
- "Unknown" is a valid answer. If a topic was not discussed, omit it. Empty beats invented.
- Never invent attribution. If who said what is unclear, write "a participant".
- Do not describe mood, intent or enthusiasm. State what was said, not how it felt, unless you are quoting.
- Facts marked "heardPoorly": true are used exactly like any other fact — include them, do not soften them, do not add hedges. The app marks them for the reader on its own.
- Memory from other meetings (marked fromMemory) may only help you name a theme. It can never be a source for anything about THIS meeting.`;

// ── Pass 1: extraction ──────────────────────────────────────────────────────

export type ExtractVars = { transcript: string; participants: string; type: string };

export const EXTRACT_FACTS: PromptTemplate<ExtractVars> = {
  id: "facts.extract",
  version: 1,
  note: "atomic facts with segment ids and a kind; no synthesis",
  build: ({ transcript, participants, type }) => `You extract atomic facts from a meeting transcript. You do not summarise, interpret or write prose.

Each transcript line is prefixed with its segment id, like [S004]. Every fact you return must cite the segment ids it came from.

Return JSON:
{"facts": [{"text": string, "kind": "decision"|"action"|"number"|"quote"|"question"|"statement", "source": ["S004"], "speaker": string, "heardPoorly": boolean}]}

Rules:
- One fact per entry. If a line contains two facts, return two entries.
- "text" restates the fact in one plain sentence, using the speaker's own numbers, names and dates. Copy figures character-for-character.
- kind "number" for any price, quantity, percentage, metric or date. kind "quote" only when "text" is a verbatim span from ONE segment.
- kind "action" for something someone committed to do. Name the committer as "speaker" only if the transcript makes it explicit.
- "source" lists every segment the fact rests on, in order. Never cite a segment you did not use. Never invent an id.
- "heardPoorly": true when a cited line is marked "(heard poorly)".
- Extract nothing that is not in the transcript. No conclusions, no advice, no next steps nobody proposed.
- Skip small talk, scheduling chatter and filler.

PARTICIPANTS: ${participants}
MEETING_TYPE: ${type}

TRANSCRIPT:
${transcript}

Return JSON only.`,
};

// ── Pass 2: the notes outline (§5) ──────────────────────────────────────────

export type NotesVars = {
  participants: string;
  type: string;
  facts: string;
  memory?: string;
  /** The founder's own rough notes. Steering only — never a source. */
  hints?: string;
};

/**
 * What each kind of meeting is usually *about*. Suggestions for theme naming
 * only: a section with nothing behind it in the transcript must not appear, so
 * these can never become a checklist the model feels obliged to fill.
 */
const THEME_GUIDE: Record<string, string> = {
  investor: "traction and metrics quoted, pricing and GTM, asks and commitments, risks raised",
  vendor: "pricing, commercial terms, scope and integration, security and compliance, open questions",
  customer: "what they need, blockers and objections, how they work today, next steps",
  team: "decisions taken, blockers, timelines, ownership, open questions",
  one_on_one: "signals and examples, strengths shown, concerns and gaps, growth and next steps",
};

export const NOTES_COMPOSE: PromptTemplate<NotesVars> = {
  id: "notes.compose",
  version: 7,
  note: "v7: fixed readout sections, and owners are the doer not the asker",
  build: ({ participants, type, facts, memory, hints }) => `You produce grounded meeting notes for Threadline: a meeting readout, plus a short summary of it.
Structure: fixed top-level SECTIONS, each with BULLETS, and a 2-4 sentence summary that the reader sees first.
- Theme/sub-theme headers are topic labels only — they must not assert facts. "Pricing" is a good label; "Pricing moved to September" is not.
- Every LEAF bullet (a real point) must carry the source segment ids it rests on.
- Use ONLY facts present in EXTRACTED_FACTS. Do not add, infer, or embellish.
- Numbers, prices, dates, and quotes must match the source text exactly.
- If a topic wasn't discussed, leave it out. Empty is better than invented.

${GROUNDING_RULES}

Shape — write "themes" FIRST, then write "summary" from what you just wrote:
{"themes": [
  {"text": "Discussion", "children": [
    {"text": "<a topic actually discussed>", "children": [{"text": "A point that was made, with its numbers", "source": ["S004"]}]}
  ]},
  {"text": "Decisions", "children": [{"text": "What was decided", "source": ["S005"]}]},
  {"text": "Action items", "children": [{"text": "Rachita: send the tier model by end of month", "source": ["S006"]}]},
  {"text": "Risks & concerns", "children": [{"text": "The risk that was raised", "source": ["S008"]}]},
  {"text": "Open questions", "children": [{"text": "The question left unanswered", "source": ["S009"]}]}
 ],
 "summary": {"text": "2-4 sentences on what this meeting was and what came of it.", "source": ["S001","S005"]}}

Use exactly those five section names, in that order, and OMIT any section with nothing behind it. An empty section is never padded out.
- "Discussion" holds one sub-section per topic actually discussed, and the points sit under those. For a ${type} meeting those topics are usually about: ${THEME_GUIDE[type] ?? THEME_GUIDE.team} — use them only where this transcript supports them, and name each sub-section after what was actually said.
- "Decisions" is for things settled, not things considered.
- "Action items" bullets start with the owner exactly as PARTICIPANTS names them, then what they will do and when if a time was said: "Rachita: send the tier model by end of month". If nobody took it, start with "Unassigned:". Never invent an owner.
- The owner is whoever has to DO the thing, never whoever asked for it. "Send me the table" said by the investor is an action for the founder: write it as the founder's, from the doer's side ("Rachita: send the prospecting table"), not as the asker's.
- "Risks & concerns" is for risks someone actually raised, not risks you can foresee.
- "Open questions" is for questions asked and left unanswered in this meeting.
- Nest at most 3 levels deep (section → topic → point).

THE SUMMARY AND THE BULLETS HAVE DIFFERENT JOBS. Do not let one become an index of the other.
- The SUMMARY is the 30-second version: open with what was decided or what changed, with its figures. Never "the meeting covered several topics" or "the team discussed pricing".
- The BULLETS are the record. Each one is a complete statement that stands on its own if the summary were deleted, and it keeps the figures, names and dates its fact carries — copied exactly, which is always safe because the fact came from the transcript.
  fact:  "The prospecting table of two hundred fifty companies is in progress, I will share both by end of month."
  GOOD bullet:  "The prospecting table of two hundred fifty companies is in progress, to be shared by end of month"
  BAD bullet:   "Progress on prospecting table"        (a heading, not a fact)
  BAD bullet:   "ANZ pricing timeline"                 (names a topic, states nothing)
  BAD bullet:   "Latency reduction achieved"           (specifics deleted)
If a bullet would work as a heading in a table of contents, it is wrong: that text belongs in the theme label, and the bullet underneath it must say what was actually said.
- A node has EITHER "children" (making it a label) OR "source" (making it a claim). Never both, never neither.
- Order themes by how much of the meeting they took.

Never write a bullet of the form "X was discussed", "concerns were noted", "support was expressed", or "update on Y". Say what was actually said, in the words it was said in. Dropping the specifics is not "playing safe" — it deletes the only part worth reading.

PARTICIPANTS: ${participants}
MEETING_TYPE: ${type}
EXTRACTED_FACTS (json): ${facts}${memory ? `\nMEMORY (other meetings — for naming themes only, never a source): ${memory}` : ""}${
    hints
      ? `\nTHE FOUNDER'S OWN ROUGH NOTES (what they care about — use this to choose themes, ordering and emphasis ONLY. It is not a transcript and can never be cited or treated as fact):\n${hints}`
      : ""
  }

Return JSON matching the Notes schema (summary + themes: NoteBullet[]). No prose outside JSON.`,
};

// ── Retry and refine ────────────────────────────────────────────────────────

/**
 * The regeneration prompt. The validator's own words go back to the model —
 * a retry that isn't told what failed is just a second roll of the dice.
 */
export const REPAIR: PromptTemplate<{ failures: string; attempt: number }> = {
  id: "repair",
  version: 1,
  note: "validator failures appended verbatim to the compose prompt",
  build: ({ failures, attempt }) => `

YOUR PREVIOUS ANSWER WAS REJECTED by a deterministic validator. This is attempt ${attempt} of 3. Fix exactly these problems:
${failures}

How to fix, in order of preference:
1. If the claim is real, correct the citation or reproduce the number/quote exactly as the segment says it.
2. If you cannot support it from the supplied facts, DELETE the line. A shorter, true answer is the correct answer.
3. Never keep a line by softening it ("around", "roughly", "approximately") — that is still an invented number.
Return the complete corrected JSON. No prose outside JSON.`,
};

/** Free-text "Refine" from the user, appended to the compose prompt. */
export const REFINE: PromptTemplate<{ instruction: string }> = {
  id: "refine",
  version: 1,
  note: "user tweak, subordinate to the grounding rules",
  build: ({ instruction }) => `

The user asked for this adjustment: "${instruction}"
Apply it to wording, ordering, grouping and level of detail only. It does not license new claims: every line still needs a source from EXTRACTED_FACTS, and if the request cannot be satisfied from those facts, satisfy as much as you can and leave the rest out.`,
};

/** Advisory entailment spot-check (§4.2, optional). Never blocks on its own. */
export const ENTAIL: PromptTemplate<{ claims: string }> = {
  id: "entail.spotcheck",
  version: 1,
  note: "per-leaf supported? yes/no; advisory only",
  build: ({ claims }) => `For each numbered claim below, answer whether the cited transcript segments SUPPORT it.
Support means: a careful reader of only those segments would agree the claim is true. Extra detail in the claim that the segments do not contain means unsupported.

Return JSON: {"verdicts": [{"i": number, "supported": boolean, "why": string}]}
Answer "supported": false when unsure. Judge only support, not style.

${claims}`,
};
