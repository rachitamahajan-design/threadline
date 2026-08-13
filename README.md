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

Prerequisite: whatever app owns the `npm run dev` process needs Screen Recording
and Microphone permission (System Settings → Privacy & Security), fully
restarted after granting.

## Local-first, actually

Audio goes to exactly one place: the speech API you configured. Everything
else — transcripts, notes, the graph, search — lives in a SQLite file on your
machine. No bot joins your call. Teams that ban cloud notetakers can self-host
this.

Runs on [PyAI](https://pyai.com) — one key, `curl -X POST
https://api.pyai.com/v1/sandbox/keys` to mint one free.

## License

[MIT](LICENSE)
