// ThreadlineHotkey — double-tap Fn anywhere to toggle recording.
//
// Listens system-wide for the Fn key (keyCode 63) via a global event
// monitor and POSTs /api/record/toggle on a double-tap within 450ms.
// Needs Accessibility/Input Monitoring permission for the app that runs it.
//
// Build:  swiftc -O capture/ThreadlineHotkey.swift -o capture/threadline-hotkey

import Cocoa
import Foundation

let TOGGLE_URL = URL(string: "http://127.0.0.1:4640/api/record/toggle")!
var lastTap: TimeInterval = 0

func status(_ s: String) {
    FileHandle.standardError.write(("[hotkey] " + s + "\n").data(using: .utf8)!)
}

/// Same narration as the Shortcuts script: every tap gets a notification, so
/// a hotkey press is never a leap of faith.
func notify(_ text: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(text)\" with title \"Threadline\""]
    try? p.run()
}

let STATE_URL = URL(string: "http://127.0.0.1:4640/api/record/state")!

func toggle() {
    // Peek at state first so the stop case can announce itself immediately —
    // the toggle response only arrives after the whole stitching pipeline.
    URLSession.shared.dataTask(with: STATE_URL) { data, _, _ in
        let wasRecording = data.flatMap { String(data: $0, encoding: .utf8) }?.contains("\"recording\":true") ?? false
        if wasRecording { notify("■ Stopped — stitching the meeting…") }

        var req = URLRequest(url: TOGGLE_URL)
        req.httpMethod = "POST"
        req.timeoutInterval = 300 // stop blocks through transcription + notes
        URLSession.shared.dataTask(with: req) { data, _, err in
            if let err = err { status("toggle failed: \(err.localizedDescription)"); notify("Threadline isn't reachable — is npm run dev running?"); return }
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            status("toggled: \(body)")
            if body.contains("\"action\":\"started\"") {
                notify("● Recording")
            } else if body.contains("\"exit\":\"discarded\"") {
                notify("Too short — discarded. Hold recordings ≥15s to keep them.")
            } else if body.contains("\"exit\":\"failed\"") {
                notify("Nothing was captured — check mic/screen permissions")
            } else if wasRecording {
                if let r = body.range(of: "\"title\":\""), let end = body[r.upperBound...].range(of: "\"") {
                    notify("✓ Saved: \(body[r.upperBound..<end.lowerBound])")
                } else {
                    notify("✓ Meeting saved")
                }
            }
        }.resume()
    }.resume()
}

// addGlobalMonitorForEvents "succeeds" even without permission — it just
// never receives events — so the only honest check is AXIsProcessTrusted.
// Ask with the system prompt so granting is one click, then say plainly
// whether we can actually hear the keyboard.
let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
let trusted = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
if !trusted {
    status("NO ACCESSIBILITY PERMISSION — double-Fn will not work. Grant it to the app that runs `npm run dev` in System Settings → Privacy & Security → Accessibility, then restart the server.")
}

NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { e in
    // Fn press arrives as flagsChanged with keyCode 63 and .function set
    if e.keyCode == 63 && e.modifierFlags.contains(.function) {
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastTap < 0.45 {
            lastTap = 0
            status("double-Fn — toggling recording")
            toggle()
        } else {
            lastTap = now
        }
    }
}

status(trusted ? "listening for double-Fn" : "started WITHOUT permission — taps will not be heard until Accessibility is granted and the server restarts")
// Parent closes stdin to stop us.
DispatchQueue.global().async {
    _ = try? FileHandle.standardInput.readToEnd()
    exit(0)
}
RunLoop.main.run()
