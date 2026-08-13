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

func toggle() {
    var req = URLRequest(url: TOGGLE_URL)
    req.httpMethod = "POST"
    URLSession.shared.dataTask(with: req) { data, _, err in
        if let err = err { status("toggle failed: \(err.localizedDescription)") }
        else if let d = data, let s = String(data: d, encoding: .utf8) { status("toggled: \(s)") }
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
