/**
 * First-run key minting. If no PYAI_API_KEY is configured, mint a free
 * sandbox key (no login, no card) and write it to .env.
 *
 * The mint endpoint is rate-limited per office network and can be disabled on
 * some deployments, so both failure modes degrade to a clear instruction
 * instead of a crash — the harness way.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = process.env.PYAI_BASE_URL ?? "https://api.pyai.com/v1";

/**
 * Persist a single env var to ./.env and apply it to the running process.
 * Values must be single-line: the boot-time .env parser is line-based.
 */
export function writeEnvVar(name: string, value: string): void {
  if (!/^[A-Z_]+$/.test(name)) throw new Error(`invalid env var name: ${name}`);
  if (!value || /\s/.test(value)) throw new Error(`${name} value must be non-empty with no whitespace`);
  const line = `${name}=${value}`;
  const prior = existsSync(".env") ? readFileSync(".env", "utf8") : "";
  const next = new RegExp(`^${name}=.*$`, "m").test(prior)
    ? prior.replace(new RegExp(`^${name}=.*$`, "m"), line)
    : (prior && !prior.endsWith("\n") ? prior + "\n" : prior) + line + "\n";
  writeFileSync(".env", next);
  process.env[name] = value;
}

export async function ensureApiKey(): Promise<string> {
  if (process.env.PYAI_API_KEY) return process.env.PYAI_API_KEY;

  console.log("No PyAI key found — minting a free sandbox key…");
  const res = await fetch(`${BASE}/sandbox/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "threadline" }),
  });

  if (res.ok) {
    const d = (await res.json()) as { api_key: string; expires_at?: number };
    writeEnvVar("PYAI_API_KEY", d.api_key);
    const until = d.expires_at ? ` (valid until ${new Date(d.expires_at).toLocaleString()})` : "";
    console.log(`✓ Sandbox key minted and saved to .env${until}. Note: sandbox keys cap at ~10 audio-minutes/day — create a free account at https://console.pyai.com for real use.`);
    return d.api_key;
  }

  const detail = await res.json().catch(() => null) as { detail?: string } | null;
  if (res.status === 429) {
    throw new Error(
      `Sandbox key limit reached for this network. Create a free key at https://console.pyai.com and put it in .env as PYAI_API_KEY=… ${detail?.detail ?? ""}`,
    );
  }
  throw new Error(
    `Could not mint a sandbox key (HTTP ${res.status}). Create one at https://console.pyai.com and add it to .env. ${detail?.detail ?? ""}`,
  );
}
