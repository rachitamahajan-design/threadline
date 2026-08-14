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
import { existsSync, mkdirSync, createWriteStream, readFileSync, type WriteStream } from "node:fs";
import WebSocket from "ws";
import { hasOpenAI, pcm16ToWav, whisperTranscribe } from "../lib/openai.js";
import type { DatabaseSync } from "node:sqlite";
import { streamUrl, type Utterance } from "../lib/pyai.js";
import { processMeeting } from "../pipeline/extract.js";

export type LiveEvent =
  | { type: "status"; message: string }
  | { type: "partial"; speaker: "You" | "Them"; text: string; utteranceId: string }
  | { type: "final"; speaker: "You" | "Them"; text: string; offsetS: number; durationS: number }
  | { type: "stopped"; meetingId: string; exit: string; reason?: string }
  | { type: "error"; message: string };

const SPEAKER: Record<number, "Them" | "You"> = { 0: "Them", 1: "You" };
const ROLE: Record<string, "agent" | "customer"> = { You: "agent", Them: "customer" };

export class LiveSession {
  private helper: ChildProcess | null = null;
  private sockets: (WebSocket | null)[] = [null, null];
  /** Audio always lands on disk too, so a PyAI outage never loses a meeting. */
  private tapes: (WriteStream | null)[] = [null, null];
  private audioBytes = [0, 0];
  private lastStreamError: string | null = null;
  private listeners = new Set<(e: LiveEvent) => void>();
  private finals: Utterance[] = [];
  private startedAt = 0;
  private stopping = false;
  readonly meetingId: string;

  /** New utterances land after everything already recorded (resume support). */
  private offsetBase = 0;
  private reconnects = [0, 0]; // capped per channel — a refused stream must not loop forever
  private resuming = false;
  private tapeSuffix = "";

  constructor(
    private db: DatabaseSync,
    private apiKey: string,
    readonly title: string,
    readonly mode: string,
    resume?: { meetingId: string; offsetBase: number },
  ) {
    this.meetingId = resume?.meetingId ?? `meeting_live_${Date.now()}`;
    this.offsetBase = resume?.offsetBase ?? 0;
    this.resuming = !!resume;
    this.tapeSuffix = resume ? `-s${Date.now()}` : "";
  }

  onEvent(fn: (e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: LiveEvent) {
    for (const fn of this.listeners) fn(e);
  }

  /** Finals so far — lets the UI enhance notes before the meeting is stitched. */
  get transcript(): Utterance[] {
    return [...this.finals].sort((a, b) => a.offset_s - b.offset_s);
  }

  start() {
    const bin = "capture/threadline-capture";
    if (!existsSync(bin)) {
      this.emit({ type: "error", message: "Capture helper not built. Run: npm run build:capture" });
      return;
    }
    this.startedAt = Date.now();
    // Stub row so notes autosave works from the first second of recording;
    // processMeeting's upsert fills in the rest at stop time.
    this.db
      .prepare(
        `INSERT INTO meetings (id, title, mode, started_at, duration_s) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(this.meetingId, this.title, this.mode, this.startedAt);
    mkdirSync("data/recordings", { recursive: true });
    for (const ch of [0, 1]) {
      this.tapes[ch] = createWriteStream(`data/recordings/${this.meetingId}${this.tapeSuffix}-ch${ch}.pcm`);
      this.openSocket(ch);
    }

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
        this.tapes[channel]?.write(pcm);
        this.audioBytes[channel] += pcm.length;
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
        const offsetS = this.offsetBase + Math.max(0, ((msg.t_ms ?? 0) - (msg.audio_ms ?? 0)) / 1000);
        const durationS = (msg.audio_ms ?? 0) / 1000;
        if (speaker === "Them") {
          this.themRecent.push({ text: msg.text, at: Date.now() });
          if (this.themRecent.length > 30) this.themRecent.shift();
        }
        // Echo gate: a mic line that repeats a recent system-audio line is the
        // speakers leaking into the mic, not the user talking. Block it.
        if (speaker === "You" && this.isEcho(msg.text)) {
          this.emit({ type: "status", message: `echo gate blocked a duplicated mic line` });
          return;
        }
        this.finals.push({ speaker, speaker_role: ROLE[speaker], text: msg.text, offset_s: offsetS, duration_s: durationS });
        this.emit({ type: "final", speaker, text: msg.text, offsetS, durationS });
      } else if (msg.type === "error") {
        this.lastStreamError = `${speaker} stream: ${JSON.stringify(msg)}`;
        this.emit({ type: "error", message: this.lastStreamError });
      }
    });
    ws.on("close", (code) => {
      // 1011 straight after a flushed final is a known benign close.
      if (!this.stopping && code !== 1000 && code !== 1011) {
        // Capped with backoff: an auth-refused stream used to reconnect every
        // 800ms for the whole meeting. Audio still tapes to disk regardless,
        // so giving up here loses nothing — Whisper fallback covers stop().
        if (++this.reconnects[channel] > 5) {
          this.lastStreamError = `${speaker} stream refused ${this.reconnects[channel] - 1} reconnects (last close ${code}) — check your PyAI key`;
          this.emit({ type: "error", message: this.lastStreamError });
          return;
        }
        const delay = 800 * 2 ** (this.reconnects[channel] - 1);
        this.emit({ type: "status", message: `${speaker} stream closed (${code}), reconnecting in ${Math.round(delay / 1000)}s (${this.reconnects[channel]}/5)` });
        setTimeout(() => { if (!this.stopping) this.openSocket(channel); }, delay);
      }
    });
    ws.on("error", (e) => {
      this.lastStreamError = `${speaker} socket: ${e.message}`;
      this.emit({ type: "status", message: this.lastStreamError });
    });
  }

  /** True if this mic text substantially overlaps a recent "Them" line. */
  private isEcho(text: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
    const words = norm(text);
    if (words.length < 4) return false;
    const cutoff = Date.now() - 20_000;
    for (const f of this.themRecent) {
      if (f.at < cutoff) continue;
      const theirs = new Set(norm(f.text));
      const hits = words.filter((w) => theirs.has(w)).length;
      if (hits / words.length >= 0.6) return true;
    }
    return false;
  }
  private themRecent: { text: string; at: number }[] = [];

  /** Mode / topic chosen mid-recording; applied when the meeting is stitched. */
  pendingMode: string | null = null;
  pendingTopicId: number | null = null;
  setMeta(meta: { mode?: string; topicId?: number }) {
    if (meta.mode) this.pendingMode = meta.mode;
    if (meta.topicId != null) this.pendingTopicId = meta.topicId;
  }

  /** The transcript captured so far, for mid-meeting notes. */
  /** Stop capture, flush finals, then run the extraction pipeline. */
  async stop(): Promise<{ meetingId: string; exit: string; reason?: string }> {
    this.stopping = true;
    for (const ws of this.sockets)
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "commit" }));
    this.helper?.stdin?.end();
    // Give commits a moment to come back as finals.
    await new Promise((r) => setTimeout(r, 1500));
    for (const ws of this.sockets) ws?.close(1000);
    this.helper?.kill("SIGTERM");

    for (const t of this.tapes) t?.end();

    this.finals.sort((a, b) => a.offset_s - b.offset_s);
    if (this.finals.length === 0 && hasOpenAI()) {
      // PyAI produced nothing (outage, dead key) — fall back to Whisper over the tape.
      this.emit({ type: "status", message: "PyAI produced no transcript — falling back to Whisper over the saved recording" });
      try {
        for (const [ch, speaker] of [[0, "Them"], [1, "You"]] as const) {
          const pcm = readFileSync(`data/recordings/${this.meetingId}${this.tapeSuffix}-ch${ch}.pcm`);
          if (pcm.length < 16000) continue; // under half a second of audio
          const utts = await whisperTranscribe(pcm16ToWav(pcm), speaker, ROLE[speaker]);
          this.finals.push(...utts.map((u) => ({ ...u, offset_s: this.offsetBase + u.offset_s })));
        }
        this.finals.sort((a, b) => a.offset_s - b.offset_s);
        if (this.finals.length) this.emit({ type: "status", message: `Whisper fallback recovered ${this.finals.length} lines` });
      } catch (e) {
        this.emit({ type: "status", message: `Whisper fallback failed: ${e instanceof Error ? e.message : e}` });
      }
    }
    if (this.finals.length === 0) {
      // Same symptom, three causes — name the one that actually happened.
      const totalAudio = this.audioBytes[0] + this.audioBytes[1];
      let reason: string;
      if (totalAudio < 32_000) {
        // under ~1s of audio across both channels: capture never really ran
        reason =
          "No audio reached the app. Check Microphone and Screen Recording permissions (System Settings → Privacy & Security), then fully restart the app you run Threadline from.";
      } else if (this.lastStreamError) {
        reason = `Audio was captured (${Math.round(totalAudio / 32_000)}s) but transcription failed: ${this.lastStreamError}. The recording is saved and can be processed once the service is reachable.`;
      } else {
        reason = "Audio was captured but no speech was recognized — the recording may be silence or too quiet.";
      }
      this.emit({ type: "error", message: reason });
      if (this.resuming) return { meetingId: this.meetingId, exit: "failed", reason }; // prior content stays
      // The stub row: keep it only if the user typed notes worth keeping.
      const stub = this.db.prepare("SELECT my_notes FROM meetings WHERE id = ?").get(this.meetingId) as
        | { my_notes: string | null }
        | undefined;
      if (stub && !stub.my_notes?.trim()) {
        this.db.prepare("DELETE FROM notes_versions WHERE meeting_id = ?").run(this.meetingId);
        this.db.prepare("DELETE FROM meetings WHERE id = ?").run(this.meetingId);
      } else if (stub) {
        this.db.prepare("UPDATE meetings SET exit = 'failed' WHERE id = ?").run(this.meetingId);
      }
      return { meetingId: this.meetingId, exit: "failed", reason };
    }

    // Fat-finger guard: a hotkey double-tap or accidental toggle produces a
    // few seconds of ambient audio that would otherwise become a junk meeting,
    // complete with hallucinated-from-silence claims polluting the brain.
    // Under 15s of captured audio on a fresh (non-resume) recording → discard
    // with a named reason instead of processing. Deliberate short dictations
    // survive by being >15s or by resuming an existing meeting.
    const totalAudioS = (this.audioBytes[0] + this.audioBytes[1]) / 64_000;
    if (!this.resuming && totalAudioS < 15) {
      const reason = `Recording too short (${Math.max(1, Math.round(totalAudioS))}s) — discarded. Hold the recording for at least 15 seconds to keep it.`;
      this.emit({ type: "error", message: reason });
      const stub = this.db.prepare("SELECT my_notes FROM meetings WHERE id = ?").get(this.meetingId) as
        | { my_notes: string | null }
        | undefined;
      if (stub && !stub.my_notes?.trim()) {
        this.db.prepare("DELETE FROM notes_versions WHERE meeting_id = ?").run(this.meetingId);
        this.db.prepare("DELETE FROM meetings WHERE id = ?").run(this.meetingId);
      } else if (stub) {
        this.db.prepare("UPDATE meetings SET exit = 'failed' WHERE id = ?").run(this.meetingId);
      }
      return { meetingId: this.meetingId, exit: "discarded", reason };
    }

    // Resuming an earlier meeting: this session's finals extend what's stored.
    let utterances = this.finals;
    if (this.resuming) {
      const existing = this.db
        .prepare(
          "SELECT speaker, speaker_role, text, offset_s, duration_s FROM utterances WHERE meeting_id = ? ORDER BY idx",
        )
        .all(this.meetingId) as Utterance[];
      utterances = [...existing, ...this.finals];
    }
    const res = await processMeeting(this.db, this.apiKey, {
      id: this.meetingId,
      title: this.title,
      mode: this.pendingMode ?? this.mode,
      startedAt: this.startedAt,
      utterances,
    });
    if (this.pendingMode) this.db.prepare("UPDATE meetings SET mode = ? WHERE id = ?").run(this.pendingMode, this.meetingId);
    if (this.pendingTopicId != null)
      this.db.prepare("INSERT INTO meeting_projects (meeting_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(this.meetingId, this.pendingTopicId);
    this.emit({ type: "stopped", meetingId: this.meetingId, exit: res.exit });
    return { meetingId: this.meetingId, exit: res.exit };
  }
}
