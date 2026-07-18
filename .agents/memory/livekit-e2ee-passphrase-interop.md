---
name: LiveKit E2EE cross-platform key interop
description: Radio E2EE keys must be fed to LiveKit as STRING passphrases on all platforms; raw-bytes paths derive different AES keys web vs native.
---

**Rule:** Any LiveKit E2EE key shared across web + React Native clients must be passed as a **string passphrase** (`setKey(string)` / `setSharedKey(string)`), never as decoded raw bytes.

**Why:** livekit-client's `ExternalE2EEKeyProvider.setKey(ArrayBuffer)` derives the AES-GCM key via **HKDF**, but the native `@livekit/react-native-webrtc` key provider defaults to **PBKDF2** (`keyDerivationAlgorithm ?? 0`) and `RNKeyProvider` cannot select HKDF (option not forwarded). Same input bytes → different final AES keys → cross-platform audio decrypts to garbled/unintelligible noise (native `discardFrameWhenCryptorNotReady=false` plays undecrypted frames as audio). A string routes through PBKDF2 (SHA-256, 100k iter, salt `LKFrameEncryptionKey`) on BOTH platforms — LiveKit's documented cross-SDK path ("Not all client SDKs support HKDF").

**How to apply:**
- Server sends the base64 key string; clients pass that string straight through — no base64 decoding.
- On native, mirror web `ExternalE2EEKeyProvider` semantics for a static shared key: `new RNKeyProvider({ ratchetWindowSize: 0, failureTolerance: -1 })`.
- Changing key handling is a **breaking wire change between app versions**: updated ↔ non-updated clients (any platform mix) can't decrypt each other until the mobile OTA/app update ships. Roll out promptly.
- Garbled (not silent) E2EE audio ≈ wrong-key decrypt or cryptor-not-attached passthrough; suspect KDF/key mismatch before network quality.
