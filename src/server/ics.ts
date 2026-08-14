/**
 * Calendar link (ICS) connection — the OAuth-free way to hook up Google
 * Calendar. Every Google calendar exposes a private read-only "Secret address
 * in iCal format" (Settings → Integrate calendar); pasting that one URL needs
 * no Google Cloud project, no consent screen, no credentials. Local-first:
 * the URL lives in the local meta table and the feed is fetched directly
 * from this machine. The URL is a credential — never log or echo it back.
 */
import type { DatabaseSync } from "node:sqlite";

export type CalEvent = { title: string; at_ms: number; end_ms: number; participants: string };

const META_KEY = "gcal_ics_url";

export function icsUrl(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY) as { value: string } | undefined;
  return row?.value || null;
}

export function setIcsUrl(db: DatabaseSync, url: string | null) {
  if (!url) db.prepare("DELETE FROM meta WHERE key = ?").run(META_KEY);
  else db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(META_KEY, url);
}

/** Upcoming events from the ICS feed — same window the OAuth path uses. */
export async function icsUpcomingEvents(db: DatabaseSync, maxResults = 6): Promise<CalEvent[]> {
  const url = icsUrl(db);
  if (!url) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`ics fetch failed: ${res.status}`);
    const text = await res.text();
    if (text.length > 5_000_000) throw new Error("ics feed too large");
    const now = Date.now();
    return parseIcs(text, now - 5 * 60_000, now + 48 * 3600_000).slice(0, maxResults);
  } finally {
    clearTimeout(timer);
  }
}

// ── parsing ────────────────────────────────────────────────────────────────

/** Wall-clock time in an IANA zone → epoch ms (single-pass offset lookup). */
function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const p = Object.fromEntries(dtf.formatToParts(new Date(wall)).map((x) => [x.type, x.value]));
    const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - wall;
    return wall - offset;
  } catch {
    return wall; // unknown zone — treat as UTC rather than dropping the event
  }
}

/** Parse one ICS date-time value. Returns null for all-day (VALUE=DATE) values. */
function parseIcsDate(value: string, params: Record<string, string>): number | null {
  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) return null; // all-day
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === "Z") return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (params.TZID) return zonedToEpoch(+y, +mo, +d, +h, +mi, +s, params.TZID);
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(); // floating → server-local
}

type Prop = { params: Record<string, string>; value: string };

function parseProp(line: string): [string, Prop] | null {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const [name, ...paramParts] = line.slice(0, i).split(";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return [name.toUpperCase(), { params, value: line.slice(i + 1) }];
}

const unescapeText = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

/**
 * VEVENTs whose start falls inside [winStart, winEnd], recurring rules
 * expanded. Honors FREQ=DAILY/WEEKLY(+BYDAY)/MONTHLY, INTERVAL, UNTIL, COUNT
 * and EXDATE; rarer RRULE parts are ignored rather than guessed. All-day and
 * cancelled events are skipped, matching the OAuth path.
 */
export function parseIcs(text: string, winStart: number, winEnd: number): CalEvent[] {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/); // unfold, then split
  const out: CalEvent[] = [];
  let ev: Record<string, Prop> | null = null;
  let exdates: number[] = [];
  let attendees: string[] = [];

  const flush = (e: Record<string, Prop>) => {
    if (e.STATUS?.value === "CANCELLED") return;
    const start = e.DTSTART ? parseIcsDate(e.DTSTART.value, e.DTSTART.params) : null;
    if (start == null) return; // all-day or unparseable
    const end = e.DTEND ? parseIcsDate(e.DTEND.value, e.DTEND.params) : null;
    const durMs = end != null && end > start ? end - start : 0;
    const title = e.SUMMARY ? unescapeText(e.SUMMARY.value) : "(untitled)";
    const participants = attendees.join(", ");
    const ex = new Set(exdates);
    const push = (at: number) => {
      if (at >= winStart && at <= winEnd && !ex.has(at))
        out.push({ title, at_ms: at, end_ms: durMs ? at + durMs : 0, participants });
    };
    if (!e.RRULE) return push(start);

    const rule: Record<string, string> = {};
    for (const part of e.RRULE.value.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
    }
    const interval = Math.max(1, Number(rule.INTERVAL) || 1);
    const until = rule.UNTIL ? (parseIcsDate(rule.UNTIL, {}) ?? winEnd) : winEnd;
    const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
    const stop = Math.min(until, winEnd);
    const DAY = 86_400_000;
    let n = 0;
    if (rule.FREQ === "DAILY") {
      for (let t = start; t <= stop && n < count && n < 5000; t += interval * DAY, n++) push(t);
    } else if (rule.FREQ === "WEEKLY") {
      const dayIdx: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
      const startDow = new Date(start).getUTCDay();
      const byday = (rule.BYDAY ? rule.BYDAY.split(",").map((d) => dayIdx[d]).filter((d) => d != null) : [startDow]).sort();
      for (let week = start - startDow * DAY; week <= stop && n < count && n < 5000; week += interval * 7 * DAY) {
        for (const dow of byday) {
          const t = week + dow * DAY;
          if (t < start || t > stop || n >= count) continue;
          n++;
          push(t);
        }
      }
    } else if (rule.FREQ === "MONTHLY") {
      const d0 = new Date(start);
      for (let i = 0; n < count && n < 5000; i += interval, n++) {
        const t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i, d0.getUTCDate(), d0.getUTCHours(), d0.getUTCMinutes(), d0.getUTCSeconds());
        if (t > stop) break;
        push(t);
      }
    } else {
      push(start); // YEARLY etc. — at least surface the first instance
    }
  };

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { ev = {}; exdates = []; attendees = []; continue; }
    if (line === "END:VEVENT") { if (ev) flush(ev); ev = null; continue; }
    if (!ev) continue;
    const parsed = parseProp(line);
    if (!parsed) continue;
    const [name, prop] = parsed;
    if (name === "EXDATE") {
      for (const v of prop.value.split(",")) {
        const t = parseIcsDate(v, prop.params);
        if (t != null) exdates.push(t);
      }
    } else if (name === "ATTENDEE") {
      const who = prop.params.CN || prop.value.replace(/^mailto:/i, "").split("@")[0];
      if (who && !attendees.includes(who)) attendees.push(who);
    } else if (!(name in ev)) {
      ev[name] = prop; // first wins — Google emits one of each for the props we read
    }
  }
  return out.sort((a, b) => a.at_ms - b.at_ms);
}
