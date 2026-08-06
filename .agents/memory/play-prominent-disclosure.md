---
name: Google Play Prominent Disclosure (location)
description: Why the location disclosure is Android-only, and the two rules that make it survive review — one gate for every GPS read, and copy that is literally true.
---

# Play "Inadequate Prominent Disclosure" — location

Google Play rejected SecureOps under the User Data policy: the app opened the OS
location dialog directly and streamed the officer's position to their employer,
with no in-app explanation. Play requires, **before** the OS prompt and **inside
the app** (privacy policy does not count): what is collected, what it is used
for, who it is shared with, and an affirmative action to continue.

## The cross-store trap

Apple rejects the opposite thing. Guideline 5.1.1(iv) has twice hit this app for
putting a dismissable custom screen in front of an OS permission prompt (see
`appstore-permission-priming.md`). Play wants a disclosure with a decline path;
Apple wants no gate at all.

**Resolution: the disclosure is `Platform.OS === "android"` only.** iOS keeps
prompting directly. Do not "simplify" this by making it universal — that
re-opens a 5.1.1(iv) rejection.

## Two rules that keep it approvable

1. **Every GPS read goes through one gate.** A single missed call site defeats
   the whole thing, because a user upgrading from an older build already has the
   OS permission granted — so collection resumes with no disclosure ever shown.
   The gate needs a non-blocking mode for paths that must not wait on a dialog
   (panic alert, timer-driven pings): that mode collects only when consent is
   already recorded AND the OS permission is already granted.
2. **The copy must be literally true of the code.** An inaccurate disclosure is
   itself a policy violation. Claims like "only while you are clocked in" or
   "never in the background" have to be checked against every call site — the
   Clock screen reads on mount regardless of shift state, and emergency/patrol
   reads happen off-shift too. If the app has a background-audio session (the
   radio) that can keep a screen mounted, a timer-driven read needs an explicit
   foreground check or "we never collect in the background" becomes false.

## The disclosure Google judges includes the artefacts you uploaded

Play rejected the app a SECOND time for inadequate prominent disclosure while the
in-app screen was already correct and already shipped. The evidence screenshot
(`IN_APP_EXPERIENCE-*.png` in the Console message) was a frame from the **demo
video attached to the location permission declaration** — a stale export still
showing the pre-fix "Background Location Needed" copy.

**The in-app screen, the demo video in the declaration form, the Console "App
access" notes, the Data safety answers, and `APP_REVIEW_NOTES.md` are one
disclosure as far as review is concerned.** Fixing the code fixes only one of
them; the rest are uploads and must be replaced by hand in the Console.

**How to apply:** when a rejection cites an in-app experience, open the attached
screenshot before touching code — a device-bezel frame with a soft grey tap
circle is our demo-video harness, not the app. Then re-export the video AND
re-read every store-facing text for the same claim.

## Dormant permissions are a standing risk

The app declared `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION`
while never calling `requestBackgroundPermissionsAsync` or
`startLocationUpdatesAsync`. Declaring background location invites the heaviest
Play scrutiny (declaration form + demo video) for a capability that is not used.
Drop unused permissions rather than justifying them.

**How to apply:** before any store submission touching location, re-grep for
every `getCurrentPositionAsync` call and confirm each one sits behind the gate,
then re-read the disclosure copy against that list.
