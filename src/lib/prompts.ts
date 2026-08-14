/**
 * Prompt templates, versioned — and loaded from config/prompts.json.
 *
 * The TEXT of every prompt is config: editing what the model is told is a JSON
 * edit, no rebuild. What stays in code is the part that has to be code — which
 * variables exist, how conditional blocks (memory, hints) are assembled, and
 * the version stamp every output records (`notes.compose@v7+r2`), so a
 * regression traced to a prompt change is a diff away rather than an
 * archaeology project. Bump a template's `version` in the JSON whenever its
 * text changes in a way that could move output; never edit a released template
 * silently.
 *
 * The behavioural rules in the templates are best-effort. The guarantees live
 * in lib/grounding.ts. When the two disagree, the code wins and the JSON is
 * what gets rewritten.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export type PromptTemplate<V = Record<string, unknown>> = {
  id: string;
  version: number;
  /** One line on what changed, for the debug drawer. */
  note: string;
  build: (vars: V) => string;
};

type PromptFile = {
  grounding_rules: { version: number; text: string };
  theme_guide: Record<string, string>;
  templates: Record<string, { version: number; note: string; text: string }>;
};

function loadPromptFile(): PromptFile {
  const p = path.join(process.cwd(), "config", "prompts.json");
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PromptFile;
  } catch (e) {
    throw new Error(`config/prompts.json is missing or invalid (${e instanceof Error ? e.message : e}) — prompts are config and the app cannot run without them`);
  }
}

const FILE = loadPromptFile();

function template(id: string): { version: number; note: string; text: string } {
  const t = FILE.templates[id];
  if (!t) throw new Error(`config/prompts.json has no template "${id}"`);
  return t;
}

/** {{var}} interpolation. Unknown vars become empty strings, never leak braces. */
function fill(text: string, vars: Record<string, string | number | undefined>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ""));
}

/**
 * Bumped (in config/prompts.json) whenever the grounding rules change. They
 * ride in every prompt, so a single edit there moves every output — the stamp
 * has to say so without needing six separate version bumps.
 */
export const GROUNDING_RULES_VERSION = FILE.grounding_rules.version;

/** Shared by every compose pass. One copy, so no handoff quietly drifts. */
export const GROUNDING_RULES = FILE.grounding_rules.text;

/** The stamp shown on every output: template version + shared-rules version. */
export function promptRef(t: PromptTemplate<never> | PromptTemplate<any>): string {
  return `${t.id}@v${t.version}+r${GROUNDING_RULES_VERSION}`;
}

// ── Pass 1: extraction ──────────────────────────────────────────────────────

export type ExtractVars = { transcript: string; participants: string; type: string };

export const EXTRACT_STATEMENTS: PromptTemplate<ExtractVars> = {
  id: "statements.extract",
  ...pick("statements.extract"),
  build: (vars) => fill(template("statements.extract").text, vars),
};

// ── Pass 2: the notes outline (§5) ──────────────────────────────────────────

export type NotesVars = {
  participants: string;
  type: string;
  statements: string;
  memory?: string;
  /** The founder's own rough notes. Steering only — never a source. */
  hints?: string;
};

export const NOTES_COMPOSE: PromptTemplate<NotesVars> = {
  id: "notes.compose",
  ...pick("notes.compose"),
  build: ({ participants, type, statements, memory, hints }) =>
    fill(template("notes.compose").text, {
      participants,
      type,
      statements,
      groundingRules: GROUNDING_RULES,
      // What each kind of meeting is usually *about* — theme-naming suggestions
      // only. A section with nothing behind it in the transcript must not
      // appear, so these can never become a checklist the model feels obliged
      // to fill.
      themeGuide: FILE.theme_guide[type] ?? FILE.theme_guide.team,
      memoryBlock: memory ? `\nMEMORY (other meetings — for naming themes only, never a source): ${memory}` : "",
      hintsBlock: hints
        ? `\nTHE FOUNDER'S OWN ROUGH NOTES (what they care about — use this to choose themes, ordering and emphasis ONLY. It is not a transcript and can never be cited or treated as fact):\n${hints}`
        : "",
    }),
};

// ── Retry and refine ────────────────────────────────────────────────────────

/**
 * The regeneration prompt. The validator's own words go back to the model —
 * a retry that isn't told what failed is just a second roll of the dice.
 */
export const REPAIR: PromptTemplate<{ failures: string; attempt: number }> = {
  id: "repair",
  ...pick("repair"),
  build: (vars) => fill(template("repair").text, vars),
};

/** Free-text "Refine" from the user, appended to the compose prompt. */
export const REFINE: PromptTemplate<{ instruction: string }> = {
  id: "refine",
  ...pick("refine"),
  build: (vars) => fill(template("refine").text, vars),
};

/** Per-leaf entailment check (§4.2). Blocking or advisory per gates config. */
export const ENTAIL: PromptTemplate<{ claims: string }> = {
  id: "entail.spotcheck",
  ...pick("entail.spotcheck"),
  build: (vars) => fill(template("entail.spotcheck").text, vars),
};

function pick(id: string): { version: number; note: string } {
  const t = template(id);
  return { version: t.version, note: t.note };
}
