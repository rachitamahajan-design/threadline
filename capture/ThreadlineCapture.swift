// ThreadlineCapture — captures BOTH sides of a meeting with no bot in the call:
//   channel 0: system audio (the other people, via ScreenCaptureKit)
//   channel 1: microphone   (you, via AVAudioEngine)
//
// Output on stdout, framed: [1 byte channel][4 bytes LE payload length][PCM16 mono @16kHz]
// Status lines go to stderr. Stop with SIGINT/SIGTERM or closing stdin.
//
// Build:  swiftc -O capture/ThreadlineCapture.swift -o capture/threadline-capture
// Needs: macOS 13+, Screen Recording + Microphone permission for the terminal.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let TARGET_RATE = 16_000.0
let outLock = NSLock()

func emit(_ channel: UInt8, _ pcm: Data) {
    guard !pcm.isEmpty else { return }
    var header = Data([channel])
    var len = UInt32(pcm.count).littleEndian
    withUnsafeBytes(of: &len) { header.append(contentsOf: $0) }
    outLock.lock()
    FileHandle.standardOutput.write(header + pcm)
    outLock.unlock()
}

func status(_ s: String) {
    FileHandle.standardError.write(("[capture] " + s + "\n").data(using: .utf8)!)
}

/// Converts any incoming PCM format to 16 kHz mono Int16.
final class Downsampler {
    private var converter: AVAudioConverter?
    private var inFormat: AVAudioFormat?
    private let outFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: TARGET_RATE, channels: 1, interleaved: true)!

    func convert(_ buffer: AVAudioPCMBuffer) -> Data {
        if converter == nil || inFormat != buffer.format {
            inFormat = buffer.format
            converter = AVAudioConverter(from: buffer.format, to: outFormat)
        }
        guard let conv = converter else { return Data() }
        let ratio = TARGET_RATE / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return Data() }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, statusPtr in
            if fed { statusPtr.pointee = .noDataNow; return nil }
            fed = true
            statusPtr.pointee = .haveData
            return buffer
        }
        if err != nil { return Data() }
        guard let ch = out.int16ChannelData else { return Data() }
        return Data(bytes: ch[0], count: Int(out.frameLength) * 2)
    }
}

// ── Microphone (channel 1) ────────────────────────────────────────────────
let engine = AVAudioEngine()
let micDown = Downsampler()

func startMic() {
    let input = engine.inputNode
    let fmt = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { buf, _ in
        emit(1, micDown.convert(buf))
    }
    do {
        try engine.start()
        status("mic capturing at \(Int(fmt.sampleRate))Hz")
    } catch {
        status("mic failed: \(error.localizedDescription) — continuing with system audio only")
    }
}

// ── System audio (channel 0) ──────────────────────────────────────────────
final class SystemAudio: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let down = Downsampler()

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw NSError(domain: "threadline", code: 1) }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        // Video is mandatory in the API; keep it tiny and drop the frames.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 5)
        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio"))
        try await s.startCapture()
        stream = s
        status("system audio capturing")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid else { return }
        guard let desc = sb.formatDescription,
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else { return }
        var asbd = asbdPtr.pointee
        guard let fmt = AVAudioFormat(streamDescription: &asbd) else { return }
        let frames = AVAudioFrameCount(sb.numSamples)
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return }
        buf.frameLength = frames
        let ablPtr = buf.mutableAudioBufferList
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(frames), into: ablPtr) == noErr
        else { return }
        emit(0, down.convert(buf))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        status("system stream stopped: \(error.localizedDescription)")
        exit(2)
    }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
let sys = SystemAudio()
signal(SIGINT) { _ in status("stopping"); exit(0) }
signal(SIGTERM) { _ in status("stopping"); exit(0) }
// Parent closes our stdin to stop us.
DispatchQueue.global().async {
    _ = try? FileHandle.standardInput.readToEnd()
    status("stdin closed, stopping")
    exit(0)
}

Task {
    do {
        try await sys.start()
    } catch {
        status("system audio failed: \(error.localizedDescription)")
        status("grant Screen Recording permission: System Settings → Privacy & Security → Screen Recording")
        // Mic-only is still useful; don't exit.
    }
    startMic()
}
RunLoop.main.run()
