/**
 * OpenAI fallback provider. PyAI is primary; this path exists so a PyAI
 * outage degrades the product instead of killing it:
 *   - Whisper batch transcription over the locally-saved recording
 *   - chat-completions structured extraction standing in for Recap
 */
import type { Utterance, RecapRecord } from "./pyai.js";

const BASE = "https://api.openai.com/v1";

export function hasOpenAI() {
  return !!process.env.OPENAI_API_KEY;
}

/** Wrap raw PCM16 mono 16kHz in a WAV header so Whisper accepts it. */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Transcribe one channel's WAV; returns utterances with offsets. */
export async function whisperTranscribe(
  wav: Buffer,
  speaker: string,
  speakerRole: "agent" | "customer",
): Promise<Utterance[]> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`whisper fallback failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { segments?: { start: number; end: number; text: string }[] };
  return (data.segments ?? [])
    .filter((s) => s.text.trim())
    .map((s) => ({
      speaker,
      speaker_role: speakerRole,
      text: s.text.trim(),
      offset_s: s.start,
      duration_s: Math.max(0.3, s.end - s.start),
    }));
}

/** The chat model. Chat always talks to OpenAI; the composer bar names it. */
export function openaiModel(): string {
  return process.env.SUMMARIZER_MODEL ?? "gpt-4o-mini";
}

/** One JSON-mode chat call. Callers own the schema and validation. */
export async function chatJSON(system: string, user: string, model?: string): Promise<unknown> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model ?? openaiModel(),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai chat failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(data.choices[0].message.content);
}

/** Timestamped transcript in the `[Ns] speaker:` shape all prompts share. */
export function flattenTranscript(utterances: Utterance[]): string {
  return utterances
    .map((u) => `[${u.offset_s.toFixed(1)}s] ${u.speaker ?? u.speaker_role}: ${u.text}`)
    .join("\n");
}

/** Recap stand-in: structured extraction via chat completions. */
export async function openaiExtract(utterances: Utterance[]): Promise<RecapRecord> {
  const record = await chatJSON(
    "You extract structured meeting notes. Only include claims supported by the transcript. Reply with JSON: " +
      '{"tldr": string, "summary_draft": string, "key_decisions": string[], ' +
      '"action_items": [{"task": string, "owner": string|null, "due": string|null}], ' +
      '"risk_signals": [{"quote": string, "category": string, "severity": "low"|"medium"|"high"}], ' +
      '"moments": [{"category": string, "offset_s": number, "description": string}]}. ' +
      "For moments, use the [Ns] markers for offset_s. Owners must be names heard in the meeting.",
    flattenTranscript(utterances),
    "gpt-4o-mini",
  );
  return record as RecapRecord;
}
