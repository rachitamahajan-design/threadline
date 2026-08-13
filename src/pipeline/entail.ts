/**
 * The entailment spot-check: §4.2's optional, model-based pass.
 *
 * ADVISORY ONLY, and off unless ENTAIL_SPOTCHECK=1. It exists because the
 * deterministic validators have one blind spot they cannot close: a claim with
 * no figures and no quotes, cited to a real segment that does not support it
 * ("strong hire", "they are ready to buy"). Substring matching cannot see that.
 *
 * Its verdicts therefore never delete anything. A leaf the checker doubts is
 * marked lowConfidence, which the UI shows as a quiet marker. Trusting a weak
 * model to *remove* content would hand it exactly the authority this whole
 * pipeline is built to withhold.
 */
import { chatJson } from "../lib/model.js";
import { ENTAIL, promptRef } from "../lib/prompts.js";
import { citedText, type Segment } from "../lib/segments.js";
import { isLeaf, walkBullets, type NoteBullet, type Notes } from "../lib/outline.js";
import type { GroundingContext } from "../lib/grounding.js";

export type EntailVerdict = { path: string; text: string; supported: boolean; why: string };

export function spotcheckEnabled(): boolean {
  return process.env.ENTAIL_SPOTCHECK === "1";
}

/**
 * Ask the model, once, whether each leaf is supported by its own citations.
 * Returns the doubted leaves. Any transport or shape failure returns nothing —
 * an advisory pass that fails must not degrade the output it was checking.
 */
export async function spotcheckNotes(
  notes: Notes,
  ctx: GroundingContext,
  opts: { max?: number } = {},
): Promise<{ verdicts: EntailVerdict[]; promptVersion: string; flagged: number }> {
  const leaves: { path: string; leaf: NoteBullet }[] = [];
  walkBullets(notes, (b, path) => {
    if (isLeaf(b) && b.source?.length) leaves.push({ path, leaf: b });
  });
  const batch = leaves.slice(0, opts.max ?? 25);
  const empty = { verdicts: [] as EntailVerdict[], promptVersion: promptRef(ENTAIL), flagged: 0 };
  if (!batch.length) return empty;

  const claims = batch
    .map(({ leaf }, i) => `${i + 1}. CLAIM: ${leaf.text}\n   SEGMENTS: ${quoteCited(ctx, leaf.source!)}`)
    .join("\n\n");

  let raw: unknown;
  try {
    raw = await chatJson({ purpose: "entail.spotcheck", temperature: 0, system: ENTAIL.build({ claims }), user: "Judge each claim." });
  } catch {
    return empty;
  }
  const list = (raw as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(list)) return empty;

  const verdicts: EntailVerdict[] = [];
  let flagged = 0;
  for (const v of list) {
    const o = (v ?? {}) as Record<string, unknown>;
    const i = Number(o.i) - 1;
    const entry = batch[i];
    if (!entry || typeof o.supported !== "boolean") continue;
    verdicts.push({
      path: entry.path,
      text: entry.leaf.text,
      supported: o.supported,
      why: typeof o.why === "string" ? o.why : "",
    });
    if (!o.supported) {
      entry.leaf.lowConfidence = true;
      flagged++;
    }
  }
  return { verdicts, promptVersion: promptRef(ENTAIL), flagged };
}

function quoteCited(ctx: GroundingContext, ids: string[]): string {
  const text = citedText(ctx.index, ids);
  const segs = ids.map((id) => ctx.index.get(id)).filter((s): s is Segment => !!s);
  return segs.length ? segs.map((s) => `[${s.id}] ${s.speaker}: ${s.text}`).join(" | ") : text;
}
