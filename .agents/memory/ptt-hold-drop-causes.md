---
name: PTT mid-hold drop causes
description: Why a held radio talk button can stop transmitting, and the constraints on fixing each cause
---
Rules:
- The PTT Pressable must NEVER live inside a ScrollView — thumb drift lets the scroll gesture steal the press and fire onPressOut. Keep it in a fixed non-scrollable footer (padded by tabBarOverlay).
- Server releases the talk lock IMMEDIATELY on the holder's control-WS close (no grace/TTL reclaim), so a client "survive the WS drop" design is unsafe; cancel-on-close is correct but must show a visible "Transmission dropped" message, never a silent snap to idle.
- AppState "inactive" fires on mere notification banners/Control Center; stopTalking on backgrounding must be debounced (~600ms sustained non-active) or banners truncate transmissions.
- The LiveKit publish room needs a Disconnected handler + onPublishLost callback (deliberate teardowns null publishRoom first, so the handler distinguishes them); otherwise SFU/network death leaves a silent dead mic.
- Publish token TTL (90s) > server MAX_TRANSMISSION (60s), so token expiry can't cut a normal transmission.

**Why:** 2026-08 field reports of transmissions silently truncating mid-hold; all four causes were live at once.
**How to apply:** any PTT UI/layout or radio session change must re-check these four paths.
