// The screen recorder's sound (src/main/recorder.ts): the Mac's output copied into BlackHole 2ch, so a
// recording hears what you hear. Compiled by main into <profile>/recorder the first time it is needed.
//
//   recaudio route          → the default output becomes "<current> + Record", a multi-output device of
//                             the current output (main, so its clock and volume lead) and BlackHole 2ch
//                             (drift corrected), made once and reused. Prints {"previous","device"} as JSON.
//                             Already on BlackHole or a "+ Record" device: left alone.
//   recaudio restore <uid>  → the default output back to <uid>.
//
// Any failure prints {"error": "..."} and exits 1. Nothing here touches the microphone.

import CoreAudio
import Foundation

struct Device { let id: AudioDeviceID; let name: String; let uid: String }

func prop<T>(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector, _ value: inout T) -> OSStatus {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value)
}

func string(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String {
  var s: Unmanaged<CFString>? = nil
  guard prop(id, sel, &s) == 0, let v = s?.takeRetainedValue() else { return "" }
  return v as String
}

func devices() -> [Device] {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
  return ids.map { Device(id: $0, name: string($0, kAudioObjectPropertyName), uid: string($0, kAudioDevicePropertyDeviceUID)) }
}

func defaultOutput() -> Device? {
  var id = AudioDeviceID(0)
  guard prop(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, &id) == 0 else { return nil }
  return devices().first { $0.id == id }
}

func setDefaultOutput(_ id: AudioDeviceID) -> OSStatus {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var v = id
  return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &v)
}

func out(_ obj: [String: String]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  print(String(data: data, encoding: .utf8)!)
  exit(obj["error"] == nil ? 0 : 1)
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "route":
  guard let cur = defaultOutput() else { out(["error": "no default output device"]) }
  guard let bh = devices().first(where: { $0.name == "BlackHole 2ch" }) else {
    out(["error": "BlackHole 2ch is not installed (brew install blackhole-2ch)"])
  }
  if cur.uid == bh.uid || cur.name.hasSuffix(" + Record") { out(["previous": cur.uid, "device": cur.uid]) }
  let name = "\(cur.name) + Record"
  let uid = "workshop.record.\(cur.uid)"
  var dev = devices().first(where: { $0.uid == uid })
  if dev == nil {
    let desc: [String: Any] = [
      kAudioAggregateDeviceNameKey: name,
      kAudioAggregateDeviceUIDKey: uid,
      kAudioAggregateDeviceIsStackedKey: 1,
      kAudioAggregateDeviceMainSubDeviceKey: cur.uid,
      kAudioAggregateDeviceSubDeviceListKey: [
        [kAudioSubDeviceUIDKey: cur.uid],
        [kAudioSubDeviceUIDKey: bh.uid, kAudioSubDeviceDriftCompensationKey: 1],
      ],
    ]
    var made = AudioDeviceID(0)
    let err = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &made)
    guard err == 0 else { out(["error": "could not make the \(name) device (\(err))"]) }
    // The new device takes a moment to show up in the device list.
    for _ in 0..<20 where devices().first(where: { $0.uid == uid }) == nil { usleep(50_000) }
    dev = devices().first(where: { $0.uid == uid }) ?? Device(id: made, name: name, uid: uid)
  }
  guard setDefaultOutput(dev!.id) == 0 else { out(["error": "could not switch the output to \(name)"]) }
  out(["previous": cur.uid, "device": dev!.uid])
case "restore":
  guard args.count > 2, let d = devices().first(where: { $0.uid == args[2] }) else { out(["error": "no such device"]) }
  guard setDefaultOutput(d.id) == 0 else { out(["error": "could not switch the output back"]) }
  out(["previous": d.uid, "device": d.uid])
default:
  out(["error": "usage: recaudio route | restore <uid>"])
}
