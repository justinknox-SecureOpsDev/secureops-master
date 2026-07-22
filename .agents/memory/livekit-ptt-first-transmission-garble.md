---
name: LiveKit PTT first-transmission garble
description: Why the first PTT transmissions play as static on E2EE LiveKit radio and the layered fix (mute-settle-unmute, discard-not-ready frames, distinct publish identity).
---

**Rule:** Any E2EE LiveKit push-to-talk flow that publishes a *fresh track per press* must (1) publish muted, wait a short abort-aware settle (~300ms), then unmute; (2) ensure receivers DROP frames when the cryptor isn't ready (`discardFrameWhenCryptorNotReady: true` — `@livekit/react-native`'s RNKeyProvider hardcodes `false`, requiring a vendored subclass that swaps the native provider with an identical option set except the flag); and (3) mint publish tokens under a distinct identity (`userId#pub`) so the publish connection never same-identity-evicts the listen connection.

**Why:** Each listener's receiver FrameCryptor is created and keyed asynchronously when a new track arrives; with discard=false, frames landing first are fed to Opus UNDECRYPTED and play as loud static — heard as "first ~2 transmissions garbled, third clear". Same-identity rejoin also evicts the listen room server-side.

**How to apply:** Radio media planes live in `admin-portal` Radio.tsx (web) and `security-ops` components/radio (native, vendored RadioKeyProvider). Server mints `#pub` identities and delays speaker eviction ~750ms after lock release (skip if lock re-taken) so rapid double-press doesn't kill the fresh publish room. Listen rooms self-heal via a Disconnected handler (map-identity check — dropListen removes from the map BEFORE disconnecting) firing onListenLost → listenEpoch bump with capped backoff. The vendored key provider's options MUST mirror RNKeyProvider's merged defaults at the pinned version — re-verify on any `@livekit/react-native` upgrade.
