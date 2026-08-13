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

guard AXIsProcessTrusted() || NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { _ in }) != nil else {
    status("no accessibility permission — grant it in System Settings → Privacy & Security → Accessibility")
    exit(1)
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

status("listening for double-Fn")
// Parent closes stdin to stop us.
DispatchQueue.global().async {
    _ = try? FileHandle.standardInput.readToEnd()
    exit(0)
}
RunLoop.main.run()
