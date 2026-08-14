/**
 * The entailment gate: §4.2's model-based pass, blocking by default.
 *
 * It exists because the deterministic validators have one blind spot they
 * cannot close: a claim with no figures and no quotes, cited to a real segment
 * that does not support it ("strong hire", "they are ready to buy"). Substring
 * matching cannot see that.
 *
 * Whether a doubted leaf is DELETED or merely flagged is config, not code —
 * gates.entailment in agents.json:
 *   "blocking"   unsupported leaves are pruned before the user sees them
 *   "advisory"   unsupported leaves get a quiet lowConfidence marker
 *   "off"        the pass does not run
 *
 * One asymmetry survives every mode: if the CHECKER itself fails (transport,
 * bad JSON), nothing is deleted — output the checker never judged is marked
 * needs-review instead. Deleting on a checker crash would hand a dead model
 * exactly the authority this pipeline is built to withhold.
 */
import { chatJson } from "../lib/model.js";
import { ENTAIL, promptRef } from "../lib/prompts.js";
import { citedText, type Segment } from "../lib/segments.js";
import { isLeaf, walkBullets, type NoteBullet, type Notes } from "../lib/outline.js";
import type { Failure, GroundingContext } from "../lib/grounding.js";
import { gatePolicy, type EntailmentMode } from "../lib/config.js";
import { reasonFrom, type Reason } from "../lib/reasons.js";

export type EntailVerdict = { path: string; text: string; supported: boolean; why: string };

/** Config first; the legacy ENTAIL_SPOTCHECK=1 env still forces it on (advisory). */
export function entailmentMode(): EntailmentMode {
  const mode = gatePolicy().entailment;
  if (mode === "off" && process.env.ENTAIL_SPOTCHECK === "1") return "advisory";
  return mode;
}

export function spotcheckEnabled(): boolean {
  return entailmentMode() !== "off";
}

/** Unsupported verdicts as gate failures, ready for repairNotes to prune. */
export function entailmentFailures(verdicts: EntailVerdict[]): Failure[] {
  return verdicts
    .filter((v) => !v.supported)
    .map((v) => ({
      path: v.path,
      rule: "entailment-unsupported" as const,
      detail: `${v.path} ("${v.text.slice(0, 80)}") is not supported by its own citations${v.why ? `: ${v.why}` : ""}. Restate only what the cited segments say, or delete the line.`,
    }));
}

/**
 * Ask the model, once, whether each leaf is supported by its own citations.
 * Returns the doubted leaves. Any transport or shape failure returns nothing
 * plus the structured reason — the caller decides whether unchecked output
 * ships clean (advisory) or ships marked needs-review (blocking). It never
 * deletes on a checker failure.
 */
export async function spotcheckNotes(
  notes: Notes,
  ctx: GroundingContext,
  opts: { max?: number } = {},
): Promise<{ verdicts: EntailVerdict[]; promptVersion: string; flagged: number; error?: Reason }> {
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
  } catch (e) {
    return { ...empty, error: reasonFrom(e) };
  }
  const list = (raw as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(list)) return { ...empty, error: { code: "schema-invalid", detail: "entailment checker returned no verdicts array" } };

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
