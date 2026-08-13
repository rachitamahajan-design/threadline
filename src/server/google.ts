/**
 * Google Calendar connection. Local-first: the OAuth token lives in a file
 * on this machine (data/google-token.json, gitignored) and calendar data is
 * fetched directly from Google to this laptop — no middleman server.
 *
 * Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env (a Google Cloud
 * OAuth "Web application" client with redirect http://localhost:4640/oauth2/callback).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const TOKEN_PATH = "data/google-token.json";
const REDIRECT = "http://localhost:4640/oauth2/callback";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

type Token = { access_token: string; refresh_token?: string; expires_at: number };

export function googleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleConnected() {
  return existsSync(TOKEN_PATH);
}

export function authUrl() {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(code: string): Promise<void> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  mkdirSync("data", { recursive: true });
  writeFileSync(
    TOKEN_PATH,
    JSON.stringify({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000 }),
  );
}

async function accessToken(): Promise<string> {
  const t = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as Token;
  if (Date.now() < t.expires_at - 60_000) return t.access_token;
  if (!t.refresh_token) throw new Error("google session expired — reconnect");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: t.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  const d = (await res.json()) as { access_token: string; expires_in: number };
  const next: Token = { ...t, access_token: d.access_token, expires_at: Date.now() + d.expires_in * 1000 };
  writeFileSync(TOKEN_PATH, JSON.stringify(next));
  return next.access_token;
}

export type CalEvent = { title: string; at_ms: number; end_ms: number; participants: string };

/** Next upcoming events from the primary calendar. */
export async function upcomingEvents(maxResults = 6): Promise<CalEvent[]> {
  const token = await accessToken();
  const q = new URLSearchParams({
    timeMin: new Date(Date.now() - 5 * 60_000).toISOString(),
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`calendar fetch failed: ${res.status}`);
  const d = (await res.json()) as {
    items?: { summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string }; attendees?: { email: string; displayName?: string; self?: boolean }[] }[];
  };
  return (d.items ?? [])
    .filter((e) => e.start?.dateTime) // skip all-day events
    .map((e) => ({
      title: e.summary ?? "(untitled)",
      at_ms: new Date(e.start!.dateTime!).getTime(),
      end_ms: e.end?.dateTime ? new Date(e.end.dateTime).getTime() : 0,
      participants: (e.attendees ?? [])
        .filter((a) => !a.self)
        .map((a) => a.displayName ?? a.email.split("@")[0])
        .join(", "),
    }));
}
