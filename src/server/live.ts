/**
 * Live meeting session. Two Hear WebSockets — one per audio channel — give us
 * speaker separation with no diarization step:
 *   channel 0 (system audio) → "Them" → Recap role customer
 *   channel 1 (microphone)   → "You"  → Recap role agent
 *
 * Frames from the capture helper: [1B channel][4B LE length][PCM16 @16kHz].
 * Silence keeps flowing from both sources, which Hear needs for endpointing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import WebSocket from "ws";
import type { DatabaseSync } from "node:sqlite";
import { streamUrl, type Utterance } from "../lib/pyai.js";
import { processMeeting } from "../pipeline/extract.js";

export type LiveEvent =
  | { type: "status"; message: string }
  | { type: "partial"; speaker: "You" | "Them"; text: string; utteranceId: string }
  | { type: "final"; speaker: "You" | "Them"; text: string; offsetS: number; durationS: number }
  | { type: "stopped"; meetingId: string; exit: string }
  | { type: "error"; message: string };

const SPEAKER: Record<number, "Them" | "You"> = { 0: "Them", 1: "You" };
const ROLE: Record<string, "agent" | "customer"> = { You: "agent", Them: "customer" };

export class LiveSession {
  private helper: ChildProcess | null = null;
  private sockets: (WebSocket | null)[] = [null, null];
  private listeners = new Set<(e: LiveEvent) => void>();
  private finals: Utterance[] = [];
  private startedAt = 0;
  private stopping = false;
  readonly meetingId: string;

  constructor(
    private db: DatabaseSync,
    private apiKey: string,
    readonly title: string,
    readonly mode: string,
  ) {
    this.meetingId = `meeting_live_${Date.now()}`;
  }

  onEvent(fn: (e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: LiveEvent) {
    for (const fn of this.listeners) fn(e);
  }

  start() {
    const bin = "capture/threadline-capture";
    if (!existsSync(bin)) {
      this.emit({ type: "error", message: "Capture helper not built. Run: npm run build:capture" });
      return;
    }
    this.startedAt = Date.now();
    for (const ch of [0, 1]) this.openSocket(ch);

    this.helper = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.helper.stderr!.on("data", (d: Buffer) =>
      this.emit({ type: "status", message: d.toString().trim() }));
    this.helper.on("exit", (code) => {
      if (!this.stopping) this.emit({ type: "error", message: `capture helper exited (${code})` });
    });

    // Parse the framed stream and route audio to the right socket.
    let buf = Buffer.alloc(0);
    this.helper.stdout!.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 5) {
        const channel = buf[0];
        const len = buf.readUInt32LE(1);
        if (buf.length < 5 + len) break;
        const pcm = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        const ws = this.sockets[channel];
        if (ws?.readyState === WebSocket.OPEN) ws.send(pcm);
      }
    });
  }

  private openSocket(channel: number) {
    const speaker = SPEAKER[channel];
    const ws = new WebSocket(streamUrl({ endpointingMs: 700 }), [`pyai-key.${this.apiKey}`]);
    this.sockets[channel] = ws;
    ws.on("open", () => this.emit({ type: "status", message: `${speaker} stream connected` }));
    ws.on("message", (raw) => {
      let msg: { type: string; text?: string; utterance_id?: string; t_ms?: number; audio_ms?: number };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "partial" && msg.text) {
        this.emit({ type: "partial", speaker, text: msg.text, utteranceId: msg.utterance_id ?? "" });
      } else if (msg.type === "final" && msg.text?.trim()) {
        const offsetS = Math.max(0, ((msg.t_ms ?? 0) - (msg.audio_ms ?? 0)) / 1000);
        const durationS = (msg.audio_ms ?? 0) / 1000;
        this.finals.push({ speaker, speaker_role: ROLE[speaker], text: msg.text, offset_s: offsetS, duration_s: durationS });
        this.emit({ type: "final", speaker, text: msg.text, offsetS, durationS });
      } else if (msg.type === "error") {
        this.emit({ type: "error", message: `${speaker} stream: ${JSON.stringify(msg)}` });
      }
    });
    ws.on("close", (code) => {
      // 1011 straight after a flushed final is a known benign close.
      if (!this.stopping && code !== 1000 && code !== 1011) {
        this.emit({ type: "status", message: `${speaker} stream closed (${code}), reconnecting` });
        setTimeout(() => { if (!this.stopping) this.openSocket(channel); }, 800);
      }
    });
    ws.on("error", (e) => this.emit({ type: "status", message: `${speaker} socket: ${e.message}` }));
  }

  /** Stop capture, flush finals, then run the extraction pipeline. */
  async stop(): Promise<{ meetingId: string; exit: string }> {
    this.stopping = true;
    for (const ws of this.sockets)
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "commit" }));
    this.helper?.stdin?.end();
    // Give commits a moment to come back as finals.
    await new Promise((r) => setTimeout(r, 1500));
    for (const ws of this.sockets) ws?.close(1000);
    this.helper?.kill("SIGTERM");

    this.finals.sort((a, b) => a.offset_s - b.offset_s);
    if (this.finals.length === 0) {
      this.emit({ type: "error", message: "No speech captured — nothing to process." });
      return { meetingId: this.meetingId, exit: "failed" };
    }
    const res = await processMeeting(this.db, this.apiKey, {
      id: this.meetingId,
      title: this.title,
      mode: this.mode,
      startedAt: this.startedAt,
      utterances: this.finals,
    });
    this.emit({ type: "stopped", meetingId: this.meetingId, exit: res.exit });
    return { meetingId: this.meetingId, exit: res.exit };
  }
}
