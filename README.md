# Threadline

> **Working title — final name pending.** Local-first meeting brain. No bot in
> your call. Notes with receipts. A to-do list that writes itself. A graph of
> everything you've ever discussed.

Granola takes notes about your meeting. **Threadline takes your side in it.**

*(README under construction during the PyAI hackathon — killer screenshot,
5-minute setup and comparison table land here before launch.)*

## What works today

- **Notes with receipts** — every decision, risk and action item points at the
  line in the call where it was said. A claim with no proof never ships: it is
  blocked by a gate and recorded with the reason.
- **A to-do list that writes itself** — action items with owners and due dates,
  extracted from what people actually committed to.
- **The meeting graph** — every meeting is a node; people and topics wire them
  together automatically. Obsidian-brain, zero effort.
- **Search across every meeting you've ever had** — locally, on your laptop.

## Quick start

```bash
git clone <repo-url> && cd threadline
cp .env.example .env        # add your PyAI key — or mint a free sandbox one:
                            # curl -X POST https://api.pyai.com/v1/sandbox/keys
npm install
npm run demo                # processes 3 sample meetings, zero setup
```

## Record from anywhere (global hotkey)

Double-tap the **Fn** key from any app to start recording; double-tap again to
stop. The hotkey daemon starts with the server (`npm run dev`) — no setup.
Meetings you never name are titled automatically from their own content, and a
prompt lets you rename on the spot when you stop. Recordings under 15 seconds
are discarded as accidental taps.

The floating companion window (pops up when recording starts) stays on top of
every app with the timer, live line, and Stop — that's the everyday control
surface; the hotkey is a bonus.

Prerequisites for double-Fn: the app that owns `npm run dev` needs
**Accessibility** permission (the daemon prompts on first run), and the 🌐/Fn
key must be set to "Do Nothing" in System Settings → Keyboard (its default is
often "Show Emoji & Symbols", which swallows the tap; a logout may be needed
before the change takes effect). Capture itself needs Screen Recording +
Microphone for the same app.

## Give your Claude this brain (MCP)

Threadline ships a local [MCP](https://modelcontextprotocol.io) server, so any
Claude conversation can pull your meeting context live — search across every
meeting, list open action items, read a topic's full history — with receipts
on every result. Runs over stdio on your machine, needs **no API keys**, and
never exposes bulk transcripts: evidence only (quotes + timestamps).

**Claude Code:**

```bash
claude mcp add threadline -- npx tsx /path/to/threadline/src/mcp/server.ts
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "threadline": {
    "command": "npx",
    "args": ["tsx", "/path/to/threadline/src/mcp/server.ts"] } } }
```

Tools: `brain_info` (start here) · `search_brain` · `list_claims` ·
`get_entity` · `get_meeting` · `list_meetings` · `get_evidence` ·
`refresh_brain_md`. There is also `data/BRAIN.md` — a regenerated ~300-token
index of everything the brain knows (`npm run brain-md`), the cheapest way for
any agent to prime itself before querying.

## Local-first, actually

Audio goes to exactly one place: the speech API you configured. Everything
else — transcripts, notes, the graph, search — lives in a SQLite file on your
machine. No bot joins your call. Teams that ban cloud notetakers can self-host
this.

Runs on [PyAI](https://pyai.com) — one key, `curl -X POST
https://api.pyai.com/v1/sandbox/keys` to mint one free.

## Forking

Every AI workflow runs inside a closed-loop harness: config-driven models,
budgets and gates, silent aimed retries, four named outcomes, and crash-proof
run records. Before changing pipeline code, read [harnesses.md](harnesses.md) —
it maps the moving parts, the config surfaces, and the invariants a fork must
keep.

## License

[MIT](LICENSE)
