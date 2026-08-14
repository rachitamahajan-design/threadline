/** Regenerate data/BRAIN.md — the agent primer. `npm run brain-md` */
import { openDb } from "../lib/db.js";
import { generateBrainMd } from "../pipeline/brain-md.js";

const { path, markdown } = generateBrainMd(openDb());
console.log(`✓ ${path} (${markdown.split("\n").length} lines)`);
