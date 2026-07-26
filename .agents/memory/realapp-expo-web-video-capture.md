---
name: Real-app Expo-web walkthrough video capture
description: How to record the officer mobile app (Expo web) as a narrated MP4 walkthrough via headless Chromium + CDP screencast (real app, not a simulation).
---
Record the REAL app by driving it as Expo web in headless Chromium and screen-recording via CDP. Deliver the MP4 with `presentAsset`.

**Environment:**
- The script MUST live in `scripts/` (workspace) — `puppeteer-core` only resolves there, not `/tmp`. Chromium is at a nix-store path; `ffmpeg` is available. Run under ShellExec `node` (real timers).
- Target URL `https://$REPLIT_EXPO_DEV_DOMAIN` (routes `/api` to api-server). Viewport 390×844.
- DB writes are dev-only via CodeExecution `executeSql` (`pg` is NOT resolvable from the workspace).

**Capture pipeline:**
- CDP `Page.startScreencast({format:'jpeg'})`; write each frame to disk AS IT ARRIVES — never buffer in memory, or a run near the ShellExec ~200s cap loses everything. Keep encode separable (gate ffmpeg behind an env flag) so frames survive a timeout.
- Build an ffmpeg concat list with per-frame `duration` = real ms between frames, then `-r 30 -pix_fmt yuv420p libx264` for real-time playback.
- Screencast captures at the CSS viewport size (→ 390-wide output); `deviceScaleFactor` is IGNORED, so you get 1x, not 2x. Real-time capture means CSS transitions are fine (the framer-only rule applies only to virtual-clock capture).
- Overlays (caption lower-third, intro/outro cards) are injected DOM divs with `pointer-events:none` + high z-index; the screencast records them.

**Non-obvious blockers (each cost real debugging):**
- A first-run **Welcome tour** overlay covers Home and silently eats tab taps → dismiss it ("Skip") right after login, before any navigation.
- Navigate tabs by **aria-label** (RN-web accessibilityLabel), not visible text (text taps mis-hit). The **chat tab** label embeds the unread count ("Team chat tab, N unread messages") → match by substring, not exact. Add a deep-link `page.goto('/route')` fallback after a tap that doesn't change the URL.
- On web, in-app `confirmAction`/`notify` are `window.confirm`/`window.alert` → auto-accept via `page.on('dialog', d=>d.accept())`.
- Stub `navigator.geolocation` to error → forces the manual "PICK A SHIFT" clock-in path (real GPS-less behavior); that path needs an accepted roster at the target site.

**Demo seeding (dev DB) to make it camera-clean:**
- Clear the two home banners by filling BOTH the license surfaces (eligibility row + `employees.sia_*`) AND all 6 profile fields the banner checks: `phone, address, emergency_contact_name, emergency_contact_phone, bank_account_number, bank_bsb`; sync phone to `users.phone_number`; set `users.must_sign_policies=false`.
- `shift_assignments.employee_id` and `time_entries.employee_id` both hold **users.id** (same misnamed-FK convention as the licenses table).
- Reset the scenario before EACH capture (claim/clock-in/out mutate state): delete the officer's demo time_entries, reset assignments (accepted for the "my shifts" + clock-in shifts, unassigned for the claimable one), and refresh shift start/end relative to `now()` so the clock-in target sits inside its 30-min-before→end window.
- Delete leftover `external_source='scheduler'` test shifts (auto-generated junk titles) so the Available list shows only the demo shift.
