// ThreadlinePanel — floating always-on-top recording companion.
//
// Watches GET /api/record/state (2s poll) and shows a small non-activating
// panel whenever a take is live — however it was started (macOS Shortcut,
// the web UI's Record button, a calendar notification). Red dot, title,
// elapsed timer, and a Stop button that ends the take. Hides itself the
// moment the recording stops, so stopping via the Shortcut also dismisses it.
// Needs no permissions.
//
// Build:  swiftc -O capture/ThreadlinePanel.swift -o capture/threadline-panel

import Cocoa
import Foundation

let STATE_URL = URL(string: "http://127.0.0.1:4640/api/record/state")!
let STOP_URL = URL(string: "http://127.0.0.1:4640/api/record/stop")!

func status(_ s: String) {
    FileHandle.standardError.write(("[panel] " + s + "\n").data(using: .utf8)!)
}

/// Same narration as the Shortcuts script: acting on the panel always answers
/// back with a notification, so a click is never a leap of faith.
func notify(_ text: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(text)\" with title \"Threadline\""]
    try? p.run()
}

/// Narrate the /api/record/stop response — same messages the Shortcut shows.
func narrateStop(_ body: String) {
    if body.contains("\"exit\":\"discarded\"") {
        notify("Too short — discarded. Hold recordings ≥15s to keep them.")
    } else if body.contains("\"exit\":\"failed\"") {
        notify("Nothing was captured — check mic/screen permissions")
    } else if let r = body.range(of: "\"title\":\""), let end = body[r.upperBound...].range(of: "\"") {
        notify("✓ Saved: \(body[r.upperBound..<end.lowerBound])")
    } else {
        notify("✓ Meeting saved")
    }
}

// Borderless panels refuse key status by default; the Stop button wants it.
// .nonactivatingPanel keeps clicks from activating the app or stealing focus.
final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class PanelController: NSObject {
    private let panel: FloatingPanel
    private let titleLabel = NSTextField(labelWithString: "Recording")
    private let timeLabel = NSTextField(labelWithString: "00:00")
    private let dot = NSView(frame: NSRect(x: 14, y: 25, width: 10, height: 10))
    private var startedAtMs: Double = 0
    private var stopping = false
    private var ticker: Timer?

    override init() {
        let size = NSSize(width: 292, height: 60)
        panel = FloatingPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: true
        )
        super.init()

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true

        let blur = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        blur.material = .hudWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 14
        blur.layer?.masksToBounds = true
        panel.contentView = blur

        dot.wantsLayer = true
        dot.layer?.backgroundColor = NSColor(red: 0.88, green: 0.27, blue: 0.24, alpha: 1).cgColor
        dot.layer?.cornerRadius = 5
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1.0
        pulse.toValue = 0.35
        pulse.duration = 0.8
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        dot.layer?.add(pulse, forKey: "pulse")
        blur.addSubview(dot)

        titleLabel.frame = NSRect(x: 32, y: 21, width: 140, height: 18)
        titleLabel.font = .systemFont(ofSize: 12.5, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        blur.addSubview(titleLabel)

        timeLabel.frame = NSRect(x: 176, y: 21, width: 52, height: 18)
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 12.5, weight: .regular)
        timeLabel.textColor = .secondaryLabelColor
        blur.addSubview(timeLabel)

        let stop = NSButton(title: "■", target: self, action: #selector(stopTapped))
        stop.frame = NSRect(x: 234, y: 15, width: 44, height: 30)
        stop.bezelStyle = .rounded
        stop.font = .systemFont(ofSize: 13, weight: .bold)
        stop.contentTintColor = NSColor(red: 0.88, green: 0.27, blue: 0.24, alpha: 1)
        stop.toolTip = "Stop recording"
        blur.addSubview(stop)

        if let screen = NSScreen.main {
            let v = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: v.maxX - size.width - 16, y: v.maxY - size.height - 16))
        }
    }

    /// Called on the main thread with the latest server state.
    func apply(recording: Bool, title: String?, startedAt: Double?) {
        if recording && !stopping {
            startedAtMs = startedAt ?? startedAtMs
            titleLabel.stringValue = (title?.isEmpty == false ? title! : "Recording")
            if !panel.isVisible {
                if startedAt == nil { startedAtMs = Date().timeIntervalSince1970 * 1000 }
                tickTime()
                panel.orderFrontRegardless()
                ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tickTime() }
                status("recording live — panel shown")
            }
        } else if !recording {
            stopping = false
            hide()
        }
    }

    private func hide() {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        ticker?.invalidate()
        ticker = nil
        status("recording ended — panel hidden")
    }

    private func tickTime() {
        let secs = max(0, Int((Date().timeIntervalSince1970 * 1000 - startedAtMs) / 1000))
        timeLabel.stringValue = String(format: "%02d:%02d", secs / 60, secs % 60)
    }

    @objc private func stopTapped() {
        guard !stopping else { return }
        stopping = true
        hide()
        notify("■ Stopped — stitching the meeting…")
        var req = URLRequest(url: STOP_URL)
        req.httpMethod = "POST"
        req.timeoutInterval = 300 // stop blocks through transcription + notes
        URLSession.shared.dataTask(with: req) { data, _, err in
            DispatchQueue.main.async { self.stopping = false }
            if let err = err {
                status("stop failed: \(err.localizedDescription)")
                notify("Threadline isn't reachable — is npm run dev running?")
                return
            }
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            status("stopped: \(body)")
            narrateStop(body)
        }.resume()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no menu bar
let controller = PanelController()

// Poll the server for recording state. Unreachable server = treat as idle.
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
    URLSession.shared.dataTask(with: STATE_URL) { data, _, _ in
        var recording = false
        var title: String? = nil
        var startedAt: Double? = nil
        if let data = data,
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            recording = obj["recording"] as? Bool ?? false
            title = obj["title"] as? String
            startedAt = obj["startedAt"] as? Double
        }
        DispatchQueue.main.async { controller.apply(recording: recording, title: title, startedAt: startedAt) }
    }.resume()
}

status("watching for recordings")
// Parent closes stdin to stop us.
DispatchQueue.global().async {
    _ = try? FileHandle.standardInput.readToEnd()
    exit(0)
}
app.run()
