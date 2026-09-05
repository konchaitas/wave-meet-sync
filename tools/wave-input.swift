// Reads/clears the macOS CoreAudio input mute on the Wave:3.
//
// This is a *separate* control from Wave Link's mute — proven by toggling Wave
// Link's mute and watching this value not move. When it is stuck on, Google Meet
// shows "Microphone muted by the system" no matter what Wave Link says.
//
//   swift tools/wave-input.swift          # show current state
//   swift tools/wave-input.swift unmute   # clear it (the fix)
//
// NOTE: deliberately no volume setter. On the Wave:3 the macOS input volume IS
// the mic gain that Wave Link shows — raising it to satisfy Meet's "increase its
// level" advice will wreck your gain staging (0.28 here == ~21 dB in Wave Link;
// 0.90 == ~38 dB).

import CoreAudio
import Foundation

func devices() -> [AudioDeviceID] {
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size)
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids)
    return ids
}

func name(_ id: AudioDeviceID) -> String {
    var a = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<UnsafeRawPointer?>.size)
    var cf: Unmanaged<CFString>? = nil
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &cf) == noErr, let cf else { return "?" }
    return cf.takeUnretainedValue() as String
}

guard let dev = devices().first(where: { name($0).hasPrefix("Elgato Wave:3") }) else {
    FileHandle.standardError.write("Wave:3 not found — is it plugged in?\n".data(using: .utf8)!)
    exit(1)
}

var muteAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute,
    mScope: kAudioObjectPropertyScopeInput, mElement: 0)
var volAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
    mScope: kAudioObjectPropertyScopeInput, mElement: 0)

func mute() -> UInt32 {
    var v: UInt32 = 0; var s = UInt32(MemoryLayout<UInt32>.size)
    AudioObjectGetPropertyData(dev, &muteAddr, 0, nil, &s, &v); return v
}
func vol() -> Float32 {
    var v: Float32 = 0; var s = UInt32(MemoryLayout<Float32>.size)
    AudioObjectGetPropertyData(dev, &volAddr, 0, nil, &s, &v); return v
}

if CommandLine.arguments.dropFirst().first == "unmute" {
    var v: UInt32 = 0
    let st = AudioObjectSetPropertyData(dev, &muteAddr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v)
    if st != noErr {
        FileHandle.standardError.write("failed to unmute (OSStatus \(st))\n".data(using: .utf8)!)
        exit(1)
    }
}

print("Wave:3 macOS input:  mute=\(mute() == 1 ? "MUTED" : "off")   level=\(String(format: "%.2f", vol())) (= your Wave Link gain)")
