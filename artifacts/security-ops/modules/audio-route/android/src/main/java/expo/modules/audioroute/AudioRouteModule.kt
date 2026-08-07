package expo.modules.audioroute

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions as ExpoPermissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android native side of the local `audio-route` Expo module.
 *
 * Monitors Bluetooth HFP/SCO headset availability and active-route state,
 * emitting `onAudioRouteChange` events to JS whenever either changes.
 *
 * ## Two independent state signals in the event payload
 *
 *  - `hasBluetoothHeadsetAvailable` — A BT SCO/HFP device is physically present
 *    in the system device list (from `AudioManager.getDevices()`). Does NOT
 *    require BLUETOOTH_CONNECT permission; device types are plain integers.
 *    Used by JS as the TRIGGER for the lazy permission request and BT routing
 *    selection (availability → permission → selectAudioOutput("bluetooth")).
 *
 *  - `isBluetoothHFPActive` — A BT SCO/HFP device is currently the SELECTED
 *    communication device:
 *      - API 31+: `AudioManager.getCommunicationDevice()?.type == TYPE_BLUETOOTH_SCO`
 *      - Pre-31:  `AudioManager.isBluetoothScoOn()`
 *    Also permission-free (type integers / boolean). Used by JS as CONFIRMATION.
 *
 * ## Three complementary signals (all funnel into emitRouteChange)
 *
 *  1. `AudioDeviceCallback.onAudioDevicesAdded/Removed` — physical device
 *     connect/disconnect; re-evaluates both availability and active-route.
 *
 *  2. `AudioManager.addOnCommunicationDeviceChangedListener` (API 31+) — fires
 *     when the OS changes the selected communication device without a physical
 *     add/remove event (the "selection gap" AudioDeviceCallback alone misses).
 *
 *  3. `BroadcastReceiver(ACTION_SCO_AUDIO_STATE_UPDATED)` (pre-31) — pre-31
 *     equivalent: fires on every SCO channel state transition, so
 *     `isBluetoothScoOn()` changes are always observed on older handsets.
 *
 * ## BLUETOOTH_CONNECT permission (Android 12 / API 31+)
 *
 * All detection APIs used here (`getDevices()` for device types,
 * `getCommunicationDevice().type`, `isBluetoothScoOn()`) are permission-free
 * — they return type integers and booleans, not device names or addresses.
 *
 * The permission is needed only when LiveKit actually opens a BT SCO audio
 * channel for mic capture. JS requests it LAZILY via `requestBluetoothPermission()`
 * only the first time `hasBluetoothHeadsetAvailable` transitions false→true.
 * Officers with no headset never see the prompt.
 *
 * ## Thread safety
 *
 * All three signals deliver to `mainHandler` (main-thread Looper) so
 * `sendEvent()` — which must be called from the JS thread — is always correct.
 *
 * ## Lazy listener registration
 *
 * `appContext.reactContext` can be null when `OnCreate` fires (e.g. when the
 * module is instantiated before the React host has fully started). To guarantee
 * listeners are always registered before any event can be observed,
 * `ensureRouteListenersRegistered()` is called both in `OnCreate` (eager
 * attempt) and at every JS entry point — `OnStartObserving("onAudioRouteChange")`
 * plus each `Function` and `AsyncFunction` body. The check is guarded by a
 * `@Volatile` flag so only the first successful registration runs; subsequent
 * calls are no-ops. `OnDestroy` unregisters and resets the flag so a potential
 * module-recreate cycle works correctly.
 */
class AudioRouteModule : Module() {

    private val audioManager: AudioManager?
        get() = appContext.reactContext?.getSystemService(AudioManager::class.java)

    private val mainHandler = Handler(Looper.getMainLooper())

    // Idempotency guard for listener registration.
    // Written from the JS thread; @Volatile ensures cross-thread visibility.
    @Volatile private var listenersRegistered = false

    // Signal 1: AudioDeviceCallback (device add/remove).
    private var deviceCallback: AudioDeviceCallback? = null

    // Signal 2: communication-device selection changes (API 31+).
    private var commDeviceListener: AudioManager.OnCommunicationDeviceChangedListener? = null

    // Signal 3: SCO audio-channel state broadcasts (pre-API 31).
    private var scoStateReceiver: BroadcastReceiver? = null

    override fun definition() = ModuleDefinition {
        Name("AudioRoute")

        Events("onAudioRouteChange")

        // Eager attempt: succeeds when reactContext is already available at
        // module-creation time (the common case after first JS load).
        OnCreate {
            ensureRouteListenersRegistered()
        }

        OnDestroy {
            unregisterRouteListeners()
        }

        // Reliable fallback: fires the first time JS calls
        // `emitter.addListener("onAudioRouteChange", …)` — i.e. when
        // `addRouteChangeListener` in index.ts attaches a callback.
        // At this point reactContext is guaranteed to be live (JS is running).
        // Cited from expo-modules-core@3.0.30:
        //   ObjectDefinitionBuilder.kt line 496 — `OnStartObserving(body: () -> Unit)`
        //   called "right after the first event listener is added".
        OnStartObserving("onAudioRouteChange") {
            ensureRouteListenersRegistered()
        }

        // Platform constant: always "android". Used by JS to gate platform-specific
        // BT monitor paths without importing react-native.
        Function("platform") {
            "android"
        }

        /**
         * Returns true when a Bluetooth HFP/SCO or BLE headset device is
         * physically AVAILABLE in the system device list — regardless of whether
         * it is currently the selected communication device.
         *
         * Implemented via `AudioManager.getDevices(GET_DEVICES_ALL)`, which
         * returns all input and output devices. Checking device type (an integer
         * field) does NOT require BLUETOOTH_CONNECT permission.
         *
         * Used by JS as the TRIGGER for the lazy permission request: if this
         * returns false, no BT headset is present and no prompt is ever shown.
         */
        Function("hasBluetoothHeadsetAvailable") {
            ensureRouteListenersRegistered()
            checkHasBluetoothHeadsetAvailable()
        }

        /**
         * Returns true when a BT HFP/SCO device is the ACTIVE selected
         * communication route (not merely available in the device list).
         *
         *  - API 31+: `AudioManager.getCommunicationDevice()?.type`
         *  - Pre-31:  `AudioManager.isBluetoothScoOn()`
         *
         * No BLUETOOTH_CONNECT permission required (type integer / boolean).
         * Used by JS as CONFIRMATION that routing actually changed.
         */
        Function("isBluetoothHFPActive") {
            ensureRouteListenersRegistered()
            checkBluetoothActive()
        }

        /**
         * Requests the `BLUETOOTH_CONNECT` permission required on Android 12+
         * (API 31+) when LiveKit captures from a BT mic.
         *
         * Called LAZILY by JS — only the first time `hasBluetoothHeadsetAvailable`
         * transitions false→true — never at session start.
         *
         *  - Returns `true` immediately on API < 31.
         *  - Returns `true` immediately if already granted.
         *  - Delegates to Expo's PermissionsManager to show the OS prompt.
         *  - Returns `false` if the Activity is unavailable or user denies.
         */
        AsyncFunction("requestBluetoothPermission") { promise: Promise ->
            ensureRouteListenersRegistered()
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                promise.resolve(true)
                return@AsyncFunction
            }

            val perm = Manifest.permission.BLUETOOTH_CONNECT
            val ctx = appContext.reactContext
            if (ctx != null &&
                ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED
            ) {
                promise.resolve(true)
                return@AsyncFunction
            }

            val permManager = appContext.permissions
            if (permManager == null) {
                promise.resolve(false)
                return@AsyncFunction
            }

            // Pass the Expo Promise directly.
            //
            // The static compatibility overload in Permissions.java (lines 42–51 of
            // expo-modules-core@3.0.30) accepts expo.modules.kotlin.Promise, wraps it
            // into a legacy Promise bridge, and delegates to
            // permissionsManager.askForPermissionsWithPromise() — which resolves with
            // a Bundle containing { status, granted, expires, canAskAgain }.
            //
            // The JS wrapper (modules/audio-route/src/index.ts) normalises that
            // Bundle to a plain boolean, so radioMedia.native.ts receives the same
            // boolean contract as the early-resolve(true) paths above.
            ExpoPermissions.askForPermissionsWithPermissionsManager(
                permManager,
                promise,
                perm
            )
        }
    }

    // ── Detection helpers ─────────────────────────────────────────────────────

    /**
     * Returns true if ANY BT SCO/HFP or BLE headset device is present in the
     * system device list. Uses type integers — no BLUETOOTH_CONNECT needed.
     */
    private fun checkHasBluetoothHeadsetAvailable(): Boolean {
        val am = audioManager ?: return false
        return am.getDevices(AudioManager.GET_DEVICES_ALL).any { device ->
            device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    device.type == AudioDeviceInfo.TYPE_BLE_HEADSET)
        }
    }

    /**
     * Returns true when BT HFP/SCO is the SELECTED communication route.
     *
     *  - API 31+: getCommunicationDevice()?.type — permission-free integer field.
     *  - Pre-31:  isBluetoothScoOn() — permission-free boolean.
     */
    private fun checkBluetoothActive(): Boolean {
        val am = audioManager ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val commDevice = am.communicationDevice ?: return false
            commDevice.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                commDevice.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        } else {
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn
        }
    }

    // ── Lazy registration guard ───────────────────────────────────────────────

    /**
     * Attempts to register the three route-change signals atomically if they
     * are not yet registered and all required dependencies are available.
     *
     * ## Atomic contract
     *
     * All required context is resolved from a SINGLE `reactContext` snapshot
     * at the top of this function.  `registerRouteListeners(am, rc)` is only
     * called when BOTH `audioManager` AND (for pre-31) `reactContext` are
     * confirmed non-null from the same snapshot — eliminating a TOCTOU race
     * where `reactContext` becomes null between the `audioManager` null-check
     * and the BroadcastReceiver registration inside `registerRouteListeners`.
     *
     * `listenersRegistered` is set to `true` only AFTER `registerRouteListeners`
     * returns `true` (all listeners installed).  A partial failure in
     * `registerRouteListeners` returns `false` without setting the flag, so
     * the next call site can retry — no listener is leaked and none is silently
     * skipped.
     *
     * Safe to call multiple times: once `listenersRegistered` is `true` every
     * subsequent call is a cheap no-op.  All Expo Function / AsyncFunction
     * bodies, plus `OnCreate` and `OnStartObserving`, call this so registration
     * is guaranteed to happen before the first event could be observed.
     *
     * NOTE: Native listener lifecycle cannot be unit-tested from Kotlin (no
     * instrumented test harness for AudioManager callbacks in this repo).
     * Hardware verification is covered by §4b steps 7 and 9 of the release
     * runbook (deferred-context + pre-31 SCO receiver behaviour).
     */
    private fun ensureRouteListenersRegistered(): Boolean {
        if (listenersRegistered) return true

        // Resolve reactContext once — used both to obtain AudioManager and,
        // for pre-31, to register the BroadcastReceiver.  A single snapshot
        // prevents the TOCTOU race described above.
        val rc = appContext.reactContext ?: return false
        val am = rc.getSystemService(AudioManager::class.java) ?: return false

        if (!registerRouteListeners(am, rc)) return false
        listenersRegistered = true
        return true
    }

    // ── Signal registration ───────────────────────────────────────────────────

    /**
     * Registers all three route-change signals using dependencies resolved by
     * the caller ([ensureRouteListenersRegistered]) from a single `reactContext`
     * snapshot.
     *
     * ## Atomic contract
     *
     * Every signal is registered in sequence.  If any registration throws, all
     * previously installed listeners are unregistered (via [unregisterRouteListeners])
     * and `false` is returned so [ensureRouteListenersRegistered] leaves
     * `listenersRegistered = false` and the next call site can retry cleanly.
     * On success all listeners are installed and `true` is returned.
     *
     * `listenersRegistered` is NOT touched here — the flag is owned exclusively
     * by [ensureRouteListenersRegistered] so the atomic "all-or-nothing" set
     * happens in one place.
     *
     * NOTE: Native lifecycle cannot be unit-tested here (no Android
     * instrumentation harness); the atomic contract is verified on-device per
     * §4b steps 7 and 9 of the release runbook.
     */
    private fun registerRouteListeners(am: AudioManager, rc: Context): Boolean {
        // Signal 1: AudioDeviceCallback — physical connect/disconnect.
        // Covers hasBluetoothHeadsetAvailable transitions (primary availability signal).
        val cb = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<AudioDeviceInfo>) {
                emitRouteChange()
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<AudioDeviceInfo>) {
                emitRouteChange()
            }
        }
        try {
            am.registerAudioDeviceCallback(cb, mainHandler)
        } catch (e: Exception) {
            // Defensive: registration failed; leave listenersRegistered=false.
            return false
        }
        deviceCallback = cb

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Signal 2 (API 31+): communication-device selection changes.
            // Fires when the OS selects a different communication device without
            // a physical add/remove event — covers isBluetoothHFPActive transitions
            // that AudioDeviceCallback alone misses.
            val listener = AudioManager.OnCommunicationDeviceChangedListener { _ ->
                emitRouteChange()
            }
            try {
                am.addOnCommunicationDeviceChangedListener(
                    { cmd -> mainHandler.post(cmd) },
                    listener
                )
            } catch (e: Exception) {
                // Partial failure: unregister Signal 1 before returning false.
                unregisterRouteListeners()
                return false
            }
            commDeviceListener = listener
        } else {
            // Signal 3 (pre-31): SCO audio-channel state broadcasts.
            // ACTION_SCO_AUDIO_STATE_UPDATED fires on every SCO channel transition
            // (CONNECTING → CONNECTED → DISCONNECTING → DISCONNECTED) so
            // isBluetoothScoOn() changes are always observed.  The context `rc`
            // is already confirmed non-null by ensureRouteListenersRegistered()
            // from the same reactContext snapshot — no second null-check needed,
            // and the TOCTOU race where reactContext becomes null between the
            // audioManager check and here is impossible.
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    emitRouteChange()
                }
            }
            try {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                rc.registerReceiver(
                    receiver,
                    IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED)
                )
            } catch (e: Exception) {
                // Partial failure: unregister Signal 1 before returning false.
                unregisterRouteListeners()
                return false
            }
            scoStateReceiver = receiver
        }

        return true
    }

    private fun unregisterRouteListeners() {
        val am = audioManager

        deviceCallback?.let { am?.unregisterAudioDeviceCallback(it) }
        deviceCallback = null

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            commDeviceListener?.let { am?.removeOnCommunicationDeviceChangedListener(it) }
            commDeviceListener = null
        }

        scoStateReceiver?.let { receiver ->
            try {
                appContext.reactContext?.unregisterReceiver(receiver)
            } catch (_: IllegalArgumentException) {
                // Context already torn down.
            }
        }
        scoStateReceiver = null

        // Reset so a module-recreate cycle can re-register from scratch.
        listenersRegistered = false
    }

    private fun emitRouteChange() {
        sendEvent(
            "onAudioRouteChange",
            mapOf(
                "isBluetoothHFPActive" to checkBluetoothActive(),
                "hasBluetoothHeadsetAvailable" to checkHasBluetoothHeadsetAvailable()
            )
        )
    }
}
