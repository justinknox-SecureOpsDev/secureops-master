---
name: App Store 5.1.1(iv) — permission-priming screens
description: Custom pre-permission screens must use neutral button labels AND must not be dismissable/bypassable — Apple rejects both under Guideline 5.1.1(iv).
---

Apple rejected the SecureOps mobile build under Guideline 5.1.1(iv) because a
custom pre-permission ("priming") screen shown *before* the OS camera prompt had
a button labelled "ALLOW CAMERA". Apple treats a button that looks like it grants
the permission as directing/encouraging the user.

**Rule:** any custom screen that appears before a system permission prompt
(camera, microphone, location, notifications, photos, Face ID, etc.) must use a
**neutral** button label — "Continue" or "Next" — never "Allow X", "Enable X",
or "Grant X". Explanatory body copy about why the permission is needed is fine;
only the action button wording is the trigger. Post-denial "open Settings"
guidance is also fine.

**Why:** the visible button label is what the reviewer checks; "Allow/Enable"
verbs on the pre-prompt button re-open the 5.1.1(iv) rejection.

**How to apply:** when adding/reviewing any permission request UI in the Expo
app, keep the pre-prompt button neutral. This is an in-binary change — fixing it
requires a NEW build + resubmission (OTA cannot patch a build that is in review),
unlike the web-hosted EULA fix.

## Second rejection (July 2026): priming screen must NOT be dismissable

Apple rejected again (1.0 build 7) because the camera priming screen could be
closed with an "X" without ever reaching the OS prompt: "the user can dismiss
this screen instead of being taken to the permission request".

**Rule:** a custom screen shown before a system permission prompt must ALWAYS
lead to the OS prompt — no close/X/skip affordance that bypasses it. Safest
pattern (what fixed it): fire `requestPermission()` immediately on mount
(useRef once-guard, spinner while pending) and reserve the custom screen for
POST-denial only ("access is off" + Open Settings via `Linking.openSettings()`
+ an alternate flow like manual code entry). Alternate-path links (e.g. "enter
code manually") are fine on the post-denial screen; the pre-prompt screen is
the risk surface, so best to have none at all.

**Why:** Apple treats any dismissable priming screen as gatekeeping the OS
prompt; two separate 5.1.1(iv) rejections came from this one component
(OrgQrScanner) — first the button wording, then the dismissability.
