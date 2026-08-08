import Foundation
import Speech
import AVFoundation
import AppKit
import Darwin

func argumentValue(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else {
        return nil
    }
    return CommandLine.arguments[index + 1]
}

let stateFilePath = argumentValue("--state")
let stopFilePath = argumentValue("--stop")
let stateLock = NSLock()
var emittedState: [String: Any] = ["phase": "starting", "ready": false, "stopped": false]

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
    guard let stateFilePath = stateFilePath else { return }
    stateLock.lock()
    payload.forEach { emittedState[$0.key] = $0.value }
    emittedState["updated_at"] = Date().timeIntervalSince1970
    let stateData = try? JSONSerialization.data(withJSONObject: emittedState)
    stateLock.unlock()
    if let stateData = stateData {
        try? stateData.write(to: URL(fileURLWithPath: stateFilePath), options: .atomic)
    }
}

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
let engine = AVAudioEngine()
var recognitionTask: SFSpeechRecognitionTask?
var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
var isStopping = false
var stopTimer: DispatchWorkItem?

func permissionName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    @unknown default: return "unknown"
    }
}

func finishStop() {
    recognitionTask?.cancel()
    emit(["stopped": true])
    exit(0)
}

func stopRecognition() {
    guard !isStopping else { return }
    isStopping = true
    emit(["phase": "stopping"])
    if engine.isRunning {
        engine.stop()
    }
    engine.inputNode.removeTap(onBus: 0)
    recognitionRequest?.endAudio()
    let timer = DispatchWorkItem { finishStop() }
    stopTimer = timer
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
}

func startRecognition() {
    guard let recognizer = recognizer, recognizer.isAvailable else {
        emit(["error": "系统语音识别当前不可用"])
        exit(2)
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    recognitionRequest = request

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
    }
    recognitionTask = recognizer.recognitionTask(with: request) { result, error in
        if let result = result {
            emit(["transcript": result.bestTranscription.formattedString, "final": result.isFinal])
            if result.isFinal && isStopping {
                stopTimer?.cancel()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { finishStop() }
            }
        }
        if let error = error, !isStopping {
            emit(["error": error.localizedDescription])
        }
    }
    do {
        engine.prepare()
        try engine.start()
        emit(["ready": true, "phase": "listening"])
    } catch {
        emit(["error": "麦克风启动失败：\(error.localizedDescription)"])
        exit(3)
    }
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { stopRecognition() }
termSource.resume()
let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interruptSource.setEventHandler { stopRecognition() }
interruptSource.resume()

func requestSpeechPermission() {
    let current = SFSpeechRecognizer.authorizationStatus()
    emit(["phase": "requesting_permission", "permission": permissionName(current)])
    SFSpeechRecognizer.requestAuthorization { status in
        DispatchQueue.main.async {
            emit(["phase": "permission_result", "permission": permissionName(status)])
            switch status {
            case .authorized:
                startRecognition()
            case .denied:
                emit(["error": "语音识别权限被拒绝，请在系统设置的隐私与安全性中允许"])
                exit(4)
            case .restricted:
                emit(["error": "当前系统限制了语音识别"])
                exit(5)
            case .notDetermined:
                emit(["error": "尚未获得语音识别权限"])
                exit(6)
            @unknown default:
                emit(["error": "未知的语音识别权限状态"])
                exit(7)
            }
        }
    }
}

func requestMicrophonePermission() {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        requestSpeechPermission()
    case .notDetermined:
        emit(["phase": "requesting_microphone", "permission": "not_determined"])
        AVCaptureDevice.requestAccess(for: .audio) { allowed in
            DispatchQueue.main.async {
                if allowed {
                    requestSpeechPermission()
                } else {
                    emit(["error": "麦克风权限被拒绝，请在系统设置的隐私与安全性中允许"])
                    exit(8)
                }
            }
        }
    case .denied:
        emit(["error": "麦克风权限被拒绝，请在系统设置的隐私与安全性中允许"])
        exit(8)
    case .restricted:
        emit(["error": "当前系统限制了麦克风"])
        exit(9)
    @unknown default:
        emit(["error": "未知的麦克风权限状态"])
        exit(10)
    }
}

DispatchQueue.main.async {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    if let stopFilePath = stopFilePath {
        try? FileManager.default.removeItem(atPath: stopFilePath)
        Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in
            if FileManager.default.fileExists(atPath: stopFilePath) {
                stopRecognition()
            }
        }
    }
    requestMicrophonePermission()
}

/* Keep references alive for the lifetime of the helper. */
withExtendedLifetime(termSource) {
    withExtendedLifetime(interruptSource) {
        RunLoop.main.run()
    }
}
