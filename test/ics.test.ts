/** Calendar-link (ICS) parsing: fixed window, no network, no Date.now. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcs } from "../src/server/ics.js";

// Window: 2026-08-14 00:00 → 2026-08-16 00:00 UTC
const WIN_START = Date.UTC(2026, 7, 14);
const WIN_END = Date.UTC(2026, 7, 16);

const wrap = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}END:VCALENDAR\r\n`;

test("a plain UTC event inside the window comes through with title, times, attendees", () => {
  const ics = wrap(
    "BEGIN:VEVENT\r\n" +
      "DTSTART:20260814T093000Z\r\n" +
      "DTEND:20260814T100000Z\r\n" +
      "SUMMARY:Pricing sync\\, weekly\r\n" +
      "ATTENDEE;CN=Rachita:mailto:rachita@example.com\r\n" +
      "ATTENDEE:mailto:prabhav@example.com\r\n" +
      "END:VEVENT\r\n",
  );
  const out = parseIcs(ics, WIN_START, WIN_END);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Pricing sync, weekly");
  assert.equal(out[0].at_ms, Date.UTC(2026, 7, 14, 9, 30));
  assert.equal(out[0].end_ms, Date.UTC(2026, 7, 14, 10, 0));
  assert.equal(out[0].participants, "Rachita, prabhav");
});

test("TZID start times convert to the right epoch", () => {
  const ics = wrap(
    "BEGIN:VEVENT\r\nDTSTART;TZID=Asia/Kolkata:20260814T150000\r\nSUMMARY:IST standup\r\nEND:VEVENT\r\n",
  );
  const out = parseIcs(ics, WIN_START, WIN_END);
  assert.equal(out.length, 1);
  assert.equal(out[0].at_ms, Date.UTC(2026, 7, 14, 9, 30)); // 15:00 IST = 09:30 UTC
});

test("weekly recurrence lands on the right day; EXDATE knocks an instance out", () => {
  // Fridays weekly from June; 2026-08-14 is a Friday inside the window.
  const base =
    "BEGIN:VEVENT\r\n" +
    "DTSTART:20260605T100000Z\r\n" +
    "DTEND:20260605T103000Z\r\n" +
    "RRULE:FREQ=WEEKLY;BYDAY=FR\r\n" +
    "SUMMARY:Friday review\r\n" +
    "END:VEVENT\r\n";
  assert.equal(parseIcs(wrap(base), WIN_START, WIN_END).length, 1);
  assert.equal(parseIcs(wrap(base), WIN_START, WIN_END)[0].at_ms, Date.UTC(2026, 7, 14, 10, 0));

  const withEx = base.replace("SUMMARY:", "EXDATE:20260814T100000Z\r\nSUMMARY:");
  assert.equal(parseIcs(wrap(withEx), WIN_START, WIN_END).length, 0);
});

test("daily recurrence honors UNTIL", () => {
  const live = wrap(
    "BEGIN:VEVENT\r\nDTSTART:20260810T080000Z\r\nRRULE:FREQ=DAILY;UNTIL=20260820T000000Z\r\nSUMMARY:Daily\r\nEND:VEVENT\r\n",
  );
  assert.equal(parseIcs(live, WIN_START, WIN_END).length, 2); // 14th + 15th
  const ended = wrap(
    "BEGIN:VEVENT\r\nDTSTART:20260810T080000Z\r\nRRULE:FREQ=DAILY;UNTIL=20260812T000000Z\r\nSUMMARY:Daily\r\nEND:VEVENT\r\n",
  );
  assert.equal(parseIcs(ended, WIN_START, WIN_END).length, 0);
});

test("all-day and cancelled events are skipped; folded lines unfold", () => {
  const ics = wrap(
    "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260814\r\nSUMMARY:All day offsite\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nDTSTART:20260814T120000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Ghost\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nDTSTART:20260814T130000Z\r\nSUMMARY:Long title that\r\n  keeps going\r\nEND:VEVENT\r\n",
  );
  const out = parseIcs(ics, WIN_START, WIN_END);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Long title that keeps going");
});

test("events outside the window are dropped, results sorted ascending", () => {
  const ics = wrap(
    "BEGIN:VEVENT\r\nDTSTART:20260820T090000Z\r\nSUMMARY:Too late\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nDTSTART:20260814T170000Z\r\nSUMMARY:Second\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nDTSTART:20260814T080000Z\r\nSUMMARY:First\r\nEND:VEVENT\r\n",
  );
  const out = parseIcs(ics, WIN_START, WIN_END);
  assert.deepEqual(out.map((e) => e.title), ["First", "Second"]);
});
