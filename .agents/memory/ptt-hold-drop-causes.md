---
name: PTT mid-hold drop causes
description: Durable invariants for any PTT UI or radio session change.
---

- PTT `Pressable` must never be inside a `ScrollView` — scroll gesture steals the touch and fires `onPressOut`, dropping the transmission mid-hold.
- Server drops the talk lock immediately on WS close (no grace period); any "survive the drop" design must surface a visible error, not silently snap to idle.
- `AppState "inactive"` fires on notification banners and Control Center swipes, not only true backgrounding; debounce `stopTalking` (~600 ms) or normal banners truncate transmissions.
