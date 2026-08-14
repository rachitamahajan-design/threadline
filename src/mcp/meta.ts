/**
 * Tool catalog for the in-app MCP setup page. Keep in sync with the
 * registerTool calls in server.ts (single UI consumer; descriptions here are
 * the user-facing phrasing, server.ts carries the agent-facing phrasing).
 */
export const MCP_TOOLS: { name: string; desc: string }[] = [
  { name: "brain_info", desc: "What the brain contains — counts, freshness, contract version" },
  { name: "search_brain", desc: "Search every meeting (lexical + knowledge graph), receipts on every hit" },
  { name: "list_claims", desc: "Complete list of decisions, action items or risks — nothing silently dropped" },
  { name: "get_entity", desc: "A topic or person: every mention across meetings, with quotes" },
  { name: "get_meeting", desc: "One meeting: summary, grounded outline, claims, related meetings" },
  { name: "list_meetings", desc: "Recent meetings with participants and counts" },
  { name: "get_evidence", desc: "The exact transcript lines behind cited [S###] receipts (max 10)" },
  { name: "refresh_brain_md", desc: "Regenerate data/BRAIN.md — the 300-token index of the whole brain" },
];
