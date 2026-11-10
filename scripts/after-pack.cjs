// electron-builder's afterPack (package.json `build.afterPack`), run before the app is signed.
// Electron's own Info.plist asks for Bluetooth and system audio capture with generic wording;
// workshop uses neither (the recorder hears the Mac through BlackHole, which is the microphone
// permission), so those requests are taken out rather than shown to anyone.

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const UNUSED = ['NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSAudioCaptureUsageDescription']

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const plist = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Info.plist')
  for (const key of UNUSED) {
    try {
      execFileSync('plutil', ['-remove', key, plist], { stdio: 'ignore' })
    } catch {
      // not there in this Electron
    }
  }
}
