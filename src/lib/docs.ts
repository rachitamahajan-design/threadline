/**
 * Document text extraction + summarization.
 *
 * Uploads become searchable project context: pdf/txt/md/csv are converted to
 * plain text at upload time, then a one-paragraph model summary is stored on
 * the document row. Both steps degrade to null on failure — a doc with no
 * extractable text still uploads fine, it just contributes only its title.
 */
import { createRequire } from "node:module";
import { chatJSON, hasOpenAI } from "./openai.js";

// pdf-parse is CommonJS; the /lib path skips its demo-mode entry point.
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
  buf: Buffer,
) => Promise<{ text?: string }>;

export const EXTRACTABLE = [".pdf", ".txt", ".md", ".csv"];

/** Plain text from an uploaded file, or null when nothing is extractable. */
export async function extractDocText(ext: string, buf: Buffer): Promise<string | null> {
  if ([".txt", ".md", ".csv"].includes(ext)) {
    const text = buf.toString("utf8").trim();
    return text || null;
  }
  if (ext === ".pdf") {
    try {
      const out = await pdfParse(buf);
      const text = out.text?.trim();
      return text || null;
    } catch {
      return null; // scanned/encrypted pdf — keep the file, skip the text
    }
  }
  return null;
}

/** One-paragraph summary of a document, or null (no key / no text / model hiccup). */
export async function summarizeDoc(title: string, text: string | null): Promise<string | null> {
  if (!hasOpenAI() || !text?.trim()) return null;
  try {
    const out = (await chatJSON(
      "You summarize a document that was added to a project workspace as context. " +
        "Write 2-3 plain sentences capturing what the document is and its most decision-relevant " +
        "facts or numbers, so a teammate knows when to open it. No preamble, no markdown. " +
        'Reply with JSON: {"summary": string}',
      `Document title: ${title}\n\nContent:\n${text.slice(0, 24000)}`,
    )) as { summary?: unknown };
    return typeof out.summary === "string" && out.summary.trim() ? out.summary.trim() : null;
  } catch {
    return null;
  }
}
