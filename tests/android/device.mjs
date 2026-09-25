import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// adb helpers for a disposable emulator or device. ANDROID_SERIAL
// selects a device when several are attached, as adb itself does.
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const adbPath = sdk && existsSync(join(sdk, 'platform-tools', 'adb')) ? join(sdk, 'platform-tools', 'adb') : 'adb';

export function adb(...args) {
  return execFileSync(adbPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function screencap() {
  return execFileSync(adbPath, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
}

export function shell(command) {
  return adb('shell', command);
}

export function deviceSerial() {
  const devices = adb('devices').split('\n').slice(1).map(line => line.split('\t')).filter(([, state]) => state === 'device');
  const serial = process.env.ANDROID_SERIAL || devices[0]?.[0];
  assert.ok(serial && devices.some(([id]) => id === serial), 'Start an Android emulator or connect a device (adb devices)');
  return serial;
}

// Release Firefox for Android, x86_64 for emulators unless FIREFOX_ANDROID_ABI says otherwise.
export async function firefoxApk(cacheDirectory, version = process.env.FIREFOX_ANDROID_VERSION || 'stable') {
  const resolved = version === 'stable'
    ? (await (await fetch('https://product-details.mozilla.org/1.0/mobile_versions.json')).json()).version
    : version;
  const abi = process.env.FIREFOX_ANDROID_ABI || shell('getprop ro.product.cpu.abi');
  const file = join(cacheDirectory, `fenix-${resolved}.multi.android-${abi}.apk`);
  if (!existsSync(file)) {
    const url = `https://archive.mozilla.org/pub/fenix/releases/${resolved}/android/fenix-${resolved}-android-${abi}/fenix-${resolved}.multi.android-${abi}.apk`;
    const response = await fetch(url);
    assert.ok(response.ok, `Download Firefox for Android ${resolved} (${abi}): HTTP ${response.status}`);
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
  }
  return { version: resolved, abi, file };
}

export function installedVersion(pkg) {
  return shell(`dumpsys package ${pkg}`).match(/versionName=(\S+)/)?.[1];
}
