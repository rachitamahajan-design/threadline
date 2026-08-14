/**
 * Threadline MCP server — the meeting brain as live context for Claude.
 *
 *   claude mcp add threadline -- npx tsx /path/to/threadline/src/mcp/server.ts
 *
 * Read-only, stdio, fully local: needs NO API keys (search is FTS + graph,
 * zero network). Evidence, not transcripts — every tool result carries its
 * receipts (quote, meeting, timestamp); bulk verbatim transcript is never
 * exposed. The consuming Claude does the reasoning; these tools return data.
 *
 * Deliberately does NOT import server/index.ts (HTTP server, key checks,
 * hotkey daemon). Only the pure read layer.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "../lib/db.js";
import { retrieve } from "../pipeline/retrieve.js";
import { readOutline } from "../lib/store.js";
import { loadSegments, indexSegments, citedText } from "../lib/segments.js";
import { generateBrainMd, THREADLINE_ATTRIBUTION } from "../pipeline/brain-md.js";
import { brainCounts, listClaims, getEntity, backlinks, listMeetings } from "./queries.js";

const CONTRACT_VERSION = "1.0.0";

// A stdio server inherits whatever cwd the MCP client chose — resolve the
// repo root from this file's location so the right database always opens.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const db = openDb(path.join(ROOT, "data"));
db.exec("PRAGMA busy_timeout = 2000"); // polite coexistence with npm run dev

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }] });

const server = new McpServer({ name: "threadline-brain", version: CONTRACT_VERSION });

server.registerTool(
  "brain_info",
  { description: "What this brain contains and how to talk to it: contract version, counts, freshness. Call first." },
  async () => text({
    about: THREADLINE_ATTRIBUTION.replace(/^> /, ""),
    contract_version: CONTRACT_VERSION,
    exposure: "evidence-not-transcripts: receipted snippets, claims, entities, outlines; no bulk transcript access",
    ...brainCounts(db),
  }),
);

server.registerTool(
  "search_brain",
  {
    description: "Hybrid search (lexical + knowledge graph) across every meeting. Returns receipted snippets: text, meeting, timestamp.",
    inputSchema: { query: z.string(), top_n: z.number().int().min(1).max(20).optional() },
  },
  async ({ query, top_n }) => text(
    retrieve(db, query, top_n ?? 8).map((s) => ({
      text: s.text, kind: s.kind,
      meeting: s.meeting_title, meeting_id: s.meeting_id,
      date: new Date(s.started_at).toISOString().slice(0, 10),
      offset_s: s.offset_s, matched_via: s.arms,
    })),
  ),
);

server.registerTool(
  "list_claims",
  {
    description: "Complete, receipted list of decisions / action_items / risks across meetings. SQL-backed: nothing silently dropped.",
    inputSchema: {
      kind: z.enum(["decision", "action_item", "risk"]).optional(),
      open_only: z.boolean().optional(),
      since: z.string().optional().describe("ISO date — only meetings on/after this day"),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ kind, open_only, since, limit }) => text(
    listClaims(db, { kind, open_only, since_ms: since ? Date.parse(since) : undefined, limit }),
  ),
);

server.registerTool(
  "get_entity",
  {
    description: "A canonical topic/person: aliases, every receipted mention per meeting, related topics. Accepts an id (topic:anz-pricing) or a name (\"ANZ pricing\").",
    inputSchema: { name_or_id: z.string() },
  },
  async ({ name_or_id }) => {
    const e = getEntity(db, name_or_id);
    return text(e ?? { error: `no entity matching "${name_or_id}" — try search_brain first` });
  },
);

server.registerTool(
  "get_meeting",
  {
    description: "One meeting: summary, grounded outline (bullets cite [S###] segment ids), receipted claims, and which other meetings it threads to. No transcript.",
    inputSchema: { meeting_id: z.string() },
  },
  async ({ meeting_id }) => {
    const m = db.prepare("SELECT id, title, mode, started_at, duration_s, headline, summary FROM meetings WHERE id = ?").get(meeting_id) as Record<string, unknown> | undefined;
    if (!m) return text({ error: "no such meeting — use list_meetings" });
    const outline = readOutline(db, meeting_id);
    return text({
      ...m,
      date: new Date(m.started_at as number).toISOString().slice(0, 10),
      outline_markdown: outline?.markdown ?? null,
      outline_needs_review: outline?.needsReview ?? null,
      claims: listClaimsForMeeting(meeting_id),
      threaded_to: backlinks(db, meeting_id),
    });
  },
);

function listClaimsForMeeting(meetingId: string) {
  return (db.prepare(
    "SELECT kind, body, quote, offset_s, done FROM claims WHERE meeting_id = ? AND gate = 'passed'",
  ).all(meetingId) as { kind: string; body: string; quote: string | null; offset_s: number | null; done: number }[])
    .map((c) => ({ kind: c.kind, ...JSON.parse(c.body), receipt: { quote: c.quote, offset_s: c.offset_s }, done: !!c.done }));
}

server.registerTool(
  "list_meetings",
  {
    description: "Recent meetings: title, date, participants, decision/action counts.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
      since: z.string().optional().describe("ISO date"),
    },
  },
  async ({ limit, since }) => text(listMeetings(db, { limit, since_ms: since ? Date.parse(since) : undefined })),
);

server.registerTool(
  "get_evidence",
  {
    description: "Resolve cited [S###] segment ids from an outline back to the exact transcript lines behind them. Max 10 ids — targeted receipts, not transcript reading.",
    inputSchema: { meeting_id: z.string(), segment_ids: z.array(z.string()).max(10) },
  },
  async ({ meeting_id, segment_ids }) => {
    const index = indexSegments(loadSegments(db, meeting_id));
    return text(segment_ids.map((id) => ({ id, text: citedText(index, [id]) || "(unknown segment id)" })));
  },
);

server.registerTool(
  "refresh_brain_md",
  { description: "Regenerate data/BRAIN.md — the ~300-token index of everything this brain knows — and return it." },
  async () => text(generateBrainMd(db, path.join(ROOT, "data"))),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[threadline-mcp] ready — brain at ${path.join(ROOT, "data")} (contract ${CONTRACT_VERSION})`);
