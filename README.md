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
npm install
npm run dev                 # → http://localhost:4640
```

Open the app and follow the **onboarding wizard** — it opens itself on a fresh
install (and lives under the profile chip → *Start onboarding* afterwards). It
mints a free PyAI sandbox key for you (or takes one you paste), walks through
building the capture engine and macOS permissions, connects your calendar, and
can load 3 sample meetings so every view has something to show. Keys are saved
to `.env` and applied immediately — no restart needed.

Prefer the terminal? `cp .env.example .env`, add `PYAI_API_KEY`, then
`npm run demo` processes the same 3 sample meetings end to end.

## Record from anywhere (global shortcut)

Bind a macOS Shortcut to `scripts/record-toggle.sh` (the in-app **Set-up
Shortcut** button walks you through it) and press it from any app to start
recording; press it again to stop. Meetings you never name are titled
automatically from their own content, and a prompt lets you rename on the spot
when you stop. Recordings under 15 seconds are discarded as accidental taps.

Multi-party calls get automatic **speaker identification**: after each
recording, the room's audio is diarized (a PyAI batch job on the locally saved
tape) and split into Speaker 1/2/3 — the other side's channel on calls, or the
mic channel for in-person meetings where everyone shares one microphone (name
your own voice too; there's no voice recognition, so nobody is auto-identified). Name each one once on the meeting
page and it propagates everywhere — transcript, entities, graph, search.
Resumed recordings aren't supported yet; too-short recordings are skipped.

A native floating panel (built with the capture helper, started with the
server) appears on top of every app whenever a recording is live — whoever
started it — with the timer and a Stop button, and disappears when the take
ends. Inside the web app there's also a browser pop-out companion with the
live line and an Ask box.

Capture needs **Screen Recording + Microphone** permission for the app that
owns `npm run dev`; the panel itself needs no permissions.

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
