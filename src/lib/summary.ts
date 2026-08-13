/**
 * The structured summary document: what the user actually reads.
 *
 * The second-pass model is not trusted. Its output is validated against this
 * shape (errors are fed back into a retry), and every anchored bullet is
 * checked against the transcript with the same grounding gate claims face.
 * Bullets that fail stay visible but are marked ungrounded — receipts,
 * honestly shown.
 */
import { groundedIn } from "./harness.js";
import type { Utterance } from "./pyai.js";

export type SummaryBullet = {
  text: string;
  offset_s?: number;
  quote?: string;
  /** false = anchor failed the grounding gate; undefined = unanchored prose. */
  grounded?: boolean;
  /** true once a human has touched this bullet. */
  edited?: boolean;
};

export type SummarySection = {
  title: string;
  bullets: SummaryBullet[];
  subsections?: SummarySection[];
};

export type StructuredSummary = {
  schema_version: 1;
  overview: string;
  sections: SummarySection[];
};

/** Human-readable schema errors; empty array means valid. */
export function validateSummary(x: unknown): string[] {
  const errors: string[] = [];
  if (typeof x !== "object" || x === null) return ["response is not a JSON object"];
  const s = x as Record<string, unknown>;
  if (typeof s.overview !== "string" || !s.overview.trim()) errors.push("overview must be a non-empty string");
  if (!Array.isArray(s.sections) || s.sections.length === 0) {
    errors.push("sections must be a non-empty array");
    return errors;
  }
  s.sections.forEach((sec, i) => validateSection(sec, `sections[${i}]`, 0, errors));
  return errors;
}

function validateSection(sec: unknown, path: string, depth: number, errors: string[]) {
  if (typeof sec !== "object" || sec === null) {
    errors.push(`${path} is not an object`);
    return;
  }
  const o = sec as Record<string, unknown>;
  if (typeof o.title !== "string" || !o.title.trim()) errors.push(`${path}.title must be a non-empty string`);
  if (!Array.isArray(o.bullets)) {
    errors.push(`${path}.bullets must be an array`);
  } else {
    o.bullets.forEach((b, i) => {
      if (typeof b !== "object" || b === null) return errors.push(`${path}.bullets[${i}] is not an object`);
      const bb = b as Record<string, unknown>;
      if (typeof bb.text !== "string" || !bb.text.trim()) errors.push(`${path}.bullets[${i}].text must be a non-empty string`);
      if (bb.offset_s !== undefined && typeof bb.offset_s !== "number") errors.push(`${path}.bullets[${i}].offset_s must be a number`);
      if (bb.quote !== undefined && typeof bb.quote !== "string") errors.push(`${path}.bullets[${i}].quote must be a string`);
    });
  }
  if (o.subsections !== undefined) {
    if (depth >= 1) errors.push(`${path}.subsections exceeds max nesting depth of 2`);
    else if (!Array.isArray(o.subsections)) errors.push(`${path}.subsections must be an array`);
    else o.subsections.forEach((sub, i) => validateSection(sub, `${path}.subsections[${i}]`, depth + 1, errors));
  }
}

/**
 * Verify every anchored bullet against the transcript. Failing bullets keep
 * their text but get grounded:false; unanchored bullets are left undefined
 * (overview-style prose is allowed to exist without a receipt).
 */
export function groundSummary(
  summary: StructuredSummary,
  utterances: Utterance[],
): { summary: StructuredSummary; ungrounded: number } {
  const gate = groundedIn(utterances);
  let ungrounded = 0;
  const walk = (sections: SummarySection[]) => {
    for (const sec of sections) {
      for (const b of sec.bullets) {
        if (b.quote === undefined && b.offset_s === undefined) continue;
        const reason = gate({ quote: b.quote, offset_s: b.offset_s });
        b.grounded = reason === null;
        if (reason) ungrounded++;
      }
      if (sec.subsections) walk(sec.subsections);
    }
  };
  walk(summary.sections);
  return { summary, ungrounded };
}

/** Every bullet in document order, with its `path` address ("1.0.2" = sections[1].subsections[0].bullets[2]). */
export function walkBullets(
  summary: StructuredSummary,
  fn: (bullet: SummaryBullet, path: string) => void,
) {
  summary.sections.forEach((sec, i) => {
    sec.bullets.forEach((b, j) => fn(b, `${i}.${j}`));
    (sec.subsections ?? []).forEach((sub, k) => {
      sub.bullets.forEach((b, j) => fn(b, `${i}.${k}.${j}`));
    });
  });
}

/** Resolve a walkBullets path back to its bullet, or null. */
export function bulletAt(summary: StructuredSummary, path: string): SummaryBullet | null {
  const parts = path.split(".").map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) return summary.sections[parts[0]]?.bullets[parts[1]] ?? null;
  if (parts.length === 3) return summary.sections[parts[0]]?.subsections?.[parts[1]]?.bullets[parts[2]] ?? null;
  return null;
}
