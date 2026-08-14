# Threadline

![Threadline — your meeting brain, threaded across every conversation](docs/hero.png)

**Granola takes notes about your meeting. Threadline takes your side in it.**

Local-first meeting brain. No bot in your call — audio is captured on your
laptop, both sides, from any app, with a double-tap of `fn`. Every meeting
becomes notes with receipts, a to-do list that writes itself, and a node in a
3D atlas of everything you've ever discussed.

## Why it's different

- **No bot joins the call** — capture is native (system audio + mic), so your
  customer never sees "Threadline Notetaker has joined". Works with Zoom,
  Meet, Teams, phone calls through your speakers, or a room full of people.
- **Notes with receipts** — every decision, risk and action item points at the
  exact transcript line it came from. A claim with no proof never ships: a
  grounding gate blocks it, the run is recorded with the reason, and the
  meeting honestly says *partial* instead of bluffing.
- **A to-do list that writes itself** — loose ends with owners pulled from
  what people actually committed to, threaded across meetings, stitched closed
  with a needle when you tick them.
- **Threads** — tag meetings to a thread (Pricing v3, Hiring, …) and every
  upcoming meeting preps itself: what's still open vs done across that
  thread's whole history. Ask questions scoped to one thread's repo, live,
  mid-call, from the floating companion.
- **The Brain** — a rotating atlas of meetings, people and topics. Spotlight a
  word to collapse the graph to what mentions it; export any node as a
  grounded context `.md` for whatever LLM you use.
- **Local-first, actually** — audio goes to exactly one place: the speech API
  you configured. Transcripts, notes, graph and search live in a SQLite file
  on your machine. Teams that ban cloud notetakers can run this.

![Notes with receipts — every claim cites its transcript line](docs/receipts.png)

![The Brain — your meetings as an atlas](docs/brain-atlas.png)

Prefer daylight? There's a warm light theme too — the toggle lives next to
your name.

![Home, light theme](docs/home-light.png)

## Quick start (five minutes, honestly)

```bash
git clone https://github.com/rachitamahajan-design/threadline && cd threadline
npm install
npm run dev                 # → http://localhost:4640
```

The **onboarding wizard** opens itself on a fresh install: it mints a free
PyAI sandbox key (or takes one you paste), builds the native capture helper,
walks through the two macOS permissions, connects your calendar (paste one
iCal link — no OAuth setup), and can seed sample meetings so every view has
something to show. Keys land in `.env` and apply immediately.

Prefer the terminal? `cp .env.example .env`, add `PYAI_API_KEY`, then
`npm run demo` processes the sample meetings end to end — extraction, gates,
receipts, graph — exactly like recorded audio.

## Record from anywhere

Double-tap `fn` (or bind a macOS Shortcut to `scripts/record-toggle.sh`) from
any app: a native floating panel appears with the timer and a Stop button, and
the browser companion pops out with the live transcript, a mode picker, a
thread picker, and an Ask box that answers from that thread's history while
you're still on the call. Meetings you never name title themselves from their
own content; takes under 15 seconds are discarded as accidental taps.

Multi-party calls get **speaker identification** after each take: the saved
tape is diarized (PyAI batch job) and split into Speaker 1/2/3 — the far side
on calls, the mic channel for in-person rooms, both for hybrid. Name each
voice once and it propagates through transcript, entities, graph and search;
the notes rebuild themselves against the diarized transcript.

Capture needs **Screen Recording + Microphone** permission for the app that
owns `npm run dev`; the global hotkey needs **Accessibility**.

## Give your Claude this brain (MCP)

Threadline ships a local [MCP](https://modelcontextprotocol.io) server, so any
MCP client — Claude Code, Claude Desktop, Cursor — can pull your meeting
context live: search across every meeting, list open action items, read a
topic's full history, with receipts on every result. Runs over stdio on your
machine, needs **no API keys**, and never exposes bulk transcripts: evidence
only (quotes + timestamps).

**Claude Code:**

```bash
claude mcp add threadline -- npx tsx "/path/to/threadline/src/mcp/server.ts"
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

## Share what the brain knows

Any Needle conversation exports as a branded card — PNG for Slack, or a PDF
whose GitHub link actually clicks and whose clone command is selectable text.
A Brain spotlight exports as a looping GIF with a grounded summary. Decisions
draw their own lineage as a git-style commit graph across threads.

![A shared Needle thread — receipts included](docs/share-card.png)

## Built on PyAI, with an honest harness

Speech runs on [PyAI](https://pyai.com) — live streaming transcription on
every recording, batch diarization after it, Recap extraction on stop. One
key; `npm run demo` mints a free sandbox key itself. If PyAI is unreachable,
the locally saved tape falls back to a second provider automatically — an
outage degrades the product instead of killing it.

Every AI workflow runs inside a closed-loop harness: config-driven models,
budgets and gates, silent aimed retries, four named outcomes
(shipped / partial / failed / skipped), and crash-proof run records. Before
changing pipeline code, read [harnesses.md](harnesses.md) — it maps the moving
parts and the invariants a fork must keep.

## License

[MIT](LICENSE)
