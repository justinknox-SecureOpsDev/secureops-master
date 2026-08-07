/**
 * JS entry point for the local `audio-route` Expo native module.
 *
 * This file is loaded LAZILY via `getAudioRoute()` in
 * `components/radio/nativeModules.ts` — never imported directly.  Loading it
 * calls `requireNativeModule("AudioRoute")` which throws
 * `CannotFindNativeModule` on binaries that predate this module; that throw is
 * caught by the lazy loader and degrades to `null` (BT monitoring disabled,
 * radio otherwise unaffected).
 *
 * ## Event payload
 *
 * Both platforms emit `onAudioRouteChange` with two independent fields:
 *
 *  - `hasBluetoothHeadsetAvailable` — A BT SCO/HFP device is physically
 *    present in the system device list.  Does NOT require BLUETOOTH_CONNECT
 *    (device types are integers).  Used by JS as the TRIGGER for the lazy
 *    permission request and `selectAudioOutput("bluetooth")` call.
 *    On iOS this is the same as `isBluetoothHFPActive` (iOS auto-routes).
 *
 *  - `isBluetoothHFPActive` — A BT SCO/HFP device is currently the selected
 *    communication route.  Also permission-free.  Used by JS as CONFIRMATION.
 *
 * ## Platform behaviour
 *
 *  iOS : `platform()` → `"ios"`.  `addRouteChangeListener` subscribes to
 *        `AVAudioSession.routeChangeNotification`; each event payload carries
 *        both fields (equal on iOS — active route = availability).
 *        `requestBluetoothPermission()` always resolves `true`.
 *
 *  Android: `platform()` → `"android"`.  `addRouteChangeListener` forwards
 *        three complementary signals (AudioDeviceCallback, communication-device
 *        changed listener API 31+, SCO broadcast pre-31) so both availability
 *        and active-route changes are observed.
 *        `requestBluetoothPermission()` requests `BLUETOOTH_CONNECT` on
 *        API 31+ via Expo's PermissionsManager.
 */
import { requireNativeModule, EventEmitter } from "expo-modules-core";

export type RouteChangeEvent = {
  /**
   * True when a Bluetooth HFP/SCO or BLE headset device is physically present
   * in the system device list (NOT necessarily the active/selected route).
   * Permission-free (device type is an integer field).
   * On iOS equals `isBluetoothHFPActive` — iOS auto-routes when a headset
   * connects, so available = active.
   */
  hasBluetoothHeadsetAvailable: boolean;
  /** True when a BT HFP/SCO device is the currently selected communication route. */
  isBluetoothHFPActive: boolean;
};

const nativeModule = requireNativeModule("AudioRoute");
const emitter = new EventEmitter(nativeModule ?? {});

/**
 * Returns `"ios"` or `"android"`. Used by the JS BT monitor to gate
 * platform-specific paths without importing react-native.
 */
export function platform(): string {
  try {
    return (nativeModule.platform() as string) ?? "";
  } catch {
    return "";
  }
}

/**
 * Synchronously returns whether a Bluetooth HFP/SCO or BLE headset device is
 * physically present in the system device list (not necessarily the active route).
 *
 * Android: scans `AudioManager.getDevices(GET_DEVICES_ALL)` for TYPE_BLUETOOTH_SCO
 *   or TYPE_BLE_HEADSET — no BLUETOOTH_CONNECT permission required.
 * iOS: same as `isBluetoothHFPActive()` (iOS availability = active route).
 */
export function hasBluetoothHeadsetAvailable(): boolean {
  try {
    return (nativeModule.hasBluetoothHeadsetAvailable() as boolean) ?? false;
  } catch {
    return false;
  }
}

/**
 * Synchronously returns whether a Bluetooth HFP/SCO device is currently the
 * selected communication route.
 *
 * iOS: reads `AVAudioSession.currentRoute.inputs` for a `.bluetoothHFP` port.
 * Android API 31+: reads `AudioManager.getCommunicationDevice()?.type`.
 * Android pre-31: reads `AudioManager.isBluetoothScoOn()`.
 */
export function isBluetoothHFPActive(): boolean {
  try {
    return (nativeModule.isBluetoothHFPActive() as boolean) ?? false;
  } catch {
    return false;
  }
}

/**
 * Requests the platform runtime permission required for Bluetooth HFP mic
 * capture, if any.
 *
 * iOS: always resolves `true` (no runtime BT permission needed).
 * Android API < 31: always resolves `true`.
 * Android API ≥ 31: resolves `true` after the user grants `BLUETOOTH_CONNECT`.
 *
 * Called LAZILY by JS — only the first time `hasBluetoothHeadsetAvailable`
 * transitions false→true. Officers with no headset never trigger this call.
 *
 * ## Resolved value shape
 *
 * The Kotlin implementation has two code paths:
 *
 *  1. Early-resolve branches (API < 31, already granted, no PermissionsManager):
 *     `promise.resolve(true)` → JS receives a plain `boolean`.
 *
 *  2. Delegated path — `Permissions.askForPermissionsWithPermissionsManager`
 *     (Permissions.java lines 42–51, expo-modules-core@3.0.30): wraps the
 *     Kotlin Promise into a legacy bridge and calls
 *     `askForPermissionsWithPromise`, which resolves with a `Bundle` carrying
 *     `{ status: "granted"|"denied"|"undetermined", granted: boolean, … }`.
 *     JS receives that Bundle as a plain object.
 *
 * This wrapper normalises both shapes to a `boolean`.
 */
export async function requestBluetoothPermission(): Promise<boolean> {
  try {
    const raw = await (nativeModule.requestBluetoothPermission() as Promise<unknown>);
    // Early-resolve path: native called promise.resolve(true/false) directly.
    if (typeof raw === "boolean") return raw;
    // Delegated path: Expo PermissionResponse bundle
    // { status: "granted" | "denied" | "undetermined", granted: boolean, … }
    if (raw !== null && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      return r["granted"] === true || r["status"] === "granted";
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Subscribe to audio-route-change events. The callback receives both
 * `hasBluetoothHeadsetAvailable` and `isBluetoothHFPActive` on every event.
 *
 * iOS: fired by `AVAudioSession.routeChangeNotification`.
 * Android: fired by any of three signals (AudioDeviceCallback,
 *   addOnCommunicationDeviceChangedListener, ACTION_SCO_AUDIO_STATE_UPDATED).
 */
export function addRouteChangeListener(
  cb: (event: RouteChangeEvent) => void,
): { remove(): void } {
  return emitter.addListener("onAudioRouteChange", cb);
}

const AudioRouteModule = {
  platform,
  hasBluetoothHeadsetAvailable,
  isBluetoothHFPActive,
  requestBluetoothPermission,
  addRouteChangeListener,
};
export default AudioRouteModule;
