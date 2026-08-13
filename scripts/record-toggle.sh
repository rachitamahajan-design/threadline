#!/bin/zsh
# Toggle Threadline recording from anywhere — bind this to a global hotkey.
#
#   Setup (once, ~1 minute):
#     1. Open the macOS Shortcuts app → new Shortcut → add "Run Shell Script"
#     2. Script: /path/to/threadline/scripts/record-toggle.sh
#     3. Shortcut settings → Add Keyboard Shortcut → e.g. ⌘⇧R
#
#   Same combo starts AND stops. Start is instant; stop takes a while
#   (transcription + notes are stitched before the meeting is saved) — the
#   notification fires immediately, the meeting name arrives in the app.
set -u

BASE="http://localhost:4640"

notify() {
  osascript -e "display notification \"$1\" with title \"Threadline\"" 2>/dev/null
}

# Is the server even up?
if ! curl -s -m 2 -o /dev/null "$BASE/api/record/state"; then
  notify "Threadline isn't running — start it with npm run dev"
  exit 0
fi

STATE=$(curl -s -m 3 "$BASE/api/record/state")
if [[ "$STATE" == *'"recording":true'* ]]; then
  # Stopping blocks for the whole processing pipeline — notify first, then wait.
  notify "■ Stopped — stitching the meeting…"
  RESP=$(curl -s -m 300 -X POST "$BASE/api/record/toggle" -H 'Content-Type: application/json' -d '{}')
  TITLE=$(printf '%s' "$RESP" | sed -n 's/.*"title":"\([^"]*\)".*/\1/p')
  if [[ "$RESP" == *'"exit":"failed"'* ]]; then
    notify "Nothing was captured — check mic/screen permissions for the server's app"
  elif [[ -n "$TITLE" ]]; then
    notify "✓ Saved: $TITLE"
  else
    notify "✓ Meeting saved"
  fi
else
  RESP=$(curl -s -m 10 -X POST "$BASE/api/record/toggle" -H 'Content-Type: application/json' -d '{}')
  if [[ "$RESP" == *'"recording":true'* ]]; then
    notify "● Recording"
  else
    notify "Couldn't start recording"
  fi
fi
