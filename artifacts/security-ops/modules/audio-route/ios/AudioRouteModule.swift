import ExpoModulesCore
import AVFoundation

/**
 * iOS native side of the local `audio-route` Expo module.
 *
 * Subscribes to `AVAudioSession.routeChangeNotification` (the authoritative
 * iOS system notification for audio device connect / disconnect) and emits
 * `onAudioRouteChange` events to JS with both BT state fields on every event.
 *
 * ## Two fields emitted on every `onAudioRouteChange` event
 *
 *  - `isBluetoothHFPActive` — A `.bluetoothHFP` port is the currently SELECTED
 *    active input route (`currentRoute.inputs`). Used by JS as the iOS trigger
 *    (iOS auto-routes when a headset connects, so active = available).
 *
 *  - `hasBluetoothHeadsetAvailable` — A `.bluetoothHFP` port appears in
 *    `availableInputs` (all inputs the OS can route to, not just the active
 *    one). In practice this equals `isBluetoothHFPActive` on iOS because
 *    AVAudioSession immediately promotes a connected BT headset to the active
 *    route; the field is emitted for TS contract parity with Android.
 *
 * Also exposes synchronous `isBluetoothHFPActive()` and
 * `hasBluetoothHeadsetAvailable()` functions so the radio BT monitor can read
 * current state immediately on session start (handles headsets already
 * connected before monitoring began).
 *
 * `platform()` returns the constant string `"ios"` so the JS BT monitor can
 * branch on platform without importing react-native (which uses Flow `import
 * typeof` syntax that vite/vitest SSR transform cannot parse).
 *
 * THREAD SAFETY: `AVAudioSession.routeChangeNotification` is posted on an
 * arbitrary thread by iOS; `sendEvent` on ExpoModulesCore is thread-safe.
 * Both `currentRoute` and `availableInputs` are documented as safe to call
 * from any thread.
 */
public class AudioRouteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AudioRoute")

    Events("onAudioRouteChange")

    OnCreate {
      self.subscribeToRouteChanges()
    }

    OnDestroy {
      NotificationCenter.default.removeObserver(self)
    }

    // Platform constant: always "ios". Used by JS to gate platform-specific
    // BT monitor paths without importing react-native.
    Function("platform") { () -> String in
      "ios"
    }

    // Synchronous: true when a BT HFP port appears in AVAudioSession.availableInputs
    // (all inputs the OS can route to, including ones not yet selected). In
    // practice equal to isBluetoothHFPActive on iOS because the OS immediately
    // promotes a connected headset to the active route.
    Function("hasBluetoothHeadsetAvailable") { () -> Bool in
      AudioRouteModule.checkBluetoothHFPAvailable()
    }

    // Synchronous: reads AVAudioSession.currentRoute.inputs and returns true
    // if the currently SELECTED active input port is a Bluetooth HFP device.
    Function("isBluetoothHFPActive") { () -> Bool in
      AudioRouteModule.checkBluetoothHFPActive()
    }

    // iOS does not require a runtime Bluetooth permission for HFP monitoring.
    // This async stub exists so JS can call requestBluetoothPermission() on
    // both platforms without branching — it always resolves true on iOS.
    AsyncFunction("requestBluetoothPermission") { (promise: Promise) in
      promise.resolve(true)
    }
  }

  // MARK: - Internal helpers

  /// True when a `.bluetoothHFP` port is physically AVAILABLE to the session
  /// (appears in `availableInputs`, which lists all inputs the OS can route to,
  /// not just the one currently selected). On iOS this is virtually always the
  /// same as `checkBluetoothHFPActive()` because AVAudioSession immediately
  /// promotes a newly connected BT headset to the active route.
  static func checkBluetoothHFPAvailable() -> Bool {
    return AVAudioSession.sharedInstance().availableInputs?.contains {
      $0.portType == .bluetoothHFP
    } ?? false
  }

  /// True when a `.bluetoothHFP` port is the currently SELECTED active input
  /// route (`currentRoute.inputs`). Safe to call from any thread.
  static func checkBluetoothHFPActive() -> Bool {
    let inputs = AVAudioSession.sharedInstance().currentRoute.inputs
    return inputs.contains { $0.portType == .bluetoothHFP }
  }

  private func subscribeToRouteChanges() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleRouteChange(_:)),
      name: AVAudioSession.routeChangeNotification,
      object: AVAudioSession.sharedInstance()
    )
  }

  @objc private func handleRouteChange(_ notification: Notification) {
    let isActive = AudioRouteModule.checkBluetoothHFPActive()
    let isAvailable = AudioRouteModule.checkBluetoothHFPAvailable()
    sendEvent("onAudioRouteChange", [
      "isBluetoothHFPActive": isActive,
      "hasBluetoothHeadsetAvailable": isAvailable,
    ])
  }
}
