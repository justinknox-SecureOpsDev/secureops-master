# App Review Notes — SecureOps (WCSG)

Paste the relevant sections into **App Store Connect → App Review Information → Notes**.
Set the demo account in the **Sign-In Required** fields as well.

---

## 1. How to sign in (Guideline 2.1 — fresh install, no organization code needed)

SecureOps is a B2B workforce app: real users are invited by their employer and
connect using an **organization code** (or an invite QR link). App Review does
not have a code, so we built a dedicated reviewer path that needs nothing:

1. Launch the app. On the **Connect** screen, tap **"No code? Try the demo."**
2. The app connects to our demo backend automatically and signs you in with the
   demo officer account — no code, no typing.

If you prefer to sign in manually instead, use the **"Try Demo"** button on the
login screen, or enter these credentials:

- **Email:** `guest@secureops.com`
- **Password:** `Demo123!`

Additional roles are available if you want to review admin/dispatch features:

- Officer: `officer@secureops.com` / `Employee123!`
- Site lead: `lead@secureops.com` / `Lead123!`

The demo account is re-provisioned on every server boot and stays active, so it
is always available for review.

---

## 2. Account creation & deletion (Guideline 5.1.1(v))

- **No public sign-up.** Accounts are created by the employer's HR team, who
  invite the worker. There is no in-app registration, so there is no "create
  account" flow to exercise.
- **In-app account deletion is fully supported.** A signed-in user can delete
  their own account entirely within the app:
  **Profile tab → ACCOUNT section → "Delete account"** → confirm with password.
  This calls `POST /auth/delete-account`, which deactivates the account, signs
  the user out on every device, revokes all sessions, and removes push tokens.
  The user can no longer sign in afterward.
- **Records retention:** as the user's employer, the company must legally retain
  certain employment records (timekeeping, payroll and 1099 tax records, filed
  incident reports, and audit history) for the period required by law. The
  in-app deletion screen discloses this clearly. These records are held by HR
  under the retention policy and are no longer accessible from the app.
- Deleting the shared demo account only ends that session (it is not
  deactivated), so the demo remains available for the next reviewer.

---

## 3. Background audio mode justification (Guideline 2.5.4)

The app declares the `audio` background mode (`UIBackgroundModes`) because it
includes a **push-to-talk (PTT) team radio** used by security officers on shift.
PTT uses LiveKit real-time audio; officers must continue to **hear dispatch and
teammates while the app is backgrounded or the phone is locked** during an
active shift (e.g. phone in pocket while patrolling). This is a genuine,
user-initiated, continuous audio-monitoring feature — the radio channel is an
open live audio session the officer deliberately joins, comparable to a
walkie-talkie left on.

Implementation note (in the interest of full transparency): between
transmissions the channel is silent, so while the user is **actively joined to
a radio channel** the app keeps the shared audio session rendering (a silent
keep-alive loop) purely so iOS does not suspend the app and cause the officer
to miss the next incoming transmission — missing a dispatch call is a safety
issue for lone security officers. This keep-alive runs **only** while a live
radio connection is actually up (the officer is listening to or transmitting on
a channel), and stops as soon as they mute or leave the channel, leave the
radio, or sign out. It is never used for location tracking, downloads, or any
other background work.

To exercise it: sign in, open the Radio tab (a channel is joined automatically),
lock the phone for a few minutes, then have a second session transmit — the
locked device keeps receiving the transmission.

---

## 4. Location usage — FOREGROUND ONLY

> Anything in this section that reaches a store form must stay literally true of
> the code. Google rejected the app once for a disclosure that promised more
> collection than the app performs. Re-read `.agents/memory/play-prominent-disclosure.md`
> before editing. There is **no background location and no geofencing** in this
> app — do not describe either, and never tick "Geofencing" on a store form.

**What is requested:** foreground/"when in use" location only.

- Android declares `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION`. It does
  **not** declare `ACCESS_BACKGROUND_LOCATION` or `FOREGROUND_SERVICE_LOCATION`.
- iOS declares `NSLocationWhenInUseUsageDescription` only — there is no
  "Always" purpose string.
- The code only ever calls `requestForegroundPermissionsAsync()` and one-shot
  `getCurrentPositionAsync()`. There is no `startLocationUpdatesAsync`, no
  `TaskManager` background task, and no region monitoring / geofencing.

**When location is read** (every one of these is with the app open on screen):

- when the officer opens the Clock screen;
- when they clock in or out (from the Clock screen or the Shifts list);
- when they scan a patrol checkpoint;
- when they send an emergency alert;
- about once a minute while clocked in — and only while the app is actually
  foregrounded (the timer checks `AppState` and skips the read otherwise, so
  the radio's background-audio session cannot turn this into background
  collection).

**What it is used for:** confirming the officer is physically at the assigned
site when clocking in, and showing dispatch the officer's position during a
shift so they can respond to an emergency alert.

**Who it is shared with:** the employer's own dispatch and administrator team.
It is not sold and not shared with advertisers.

**Prominent disclosure (Android):** on Android the app shows a full in-app
disclosure — what is collected, when, what for, who it is shared with, and that
nothing is collected in the background — **before** the OS permission dialog.
The user must tap "I agree, continue"; "Not now" declines, and declining leaves
the app fully usable (the officer picks their site by hand when clocking in).
The demo video of this flow is `attached_assets/location-permission-demo.mp4`.

iOS deliberately does **not** show that screen and prompts directly: Apple has
rejected this app twice under Guideline 5.1.1(iv) for putting a custom screen in
front of an OS permission prompt.

To exercise it: sign in as the officer, open the Clock tab, and grant location.
The emergency button is on the officer Home screen (press and hold).

---

## 5. Export compliance — `ITSAppUsesNonExemptEncryption = false`

The app does not use any non-exempt encryption. All encryption used is standard
and exempt: HTTPS/TLS for network transport, and LiveKit's end-to-end audio
encryption uses standard algorithms provided by the platform. There is no
proprietary or non-standard cryptography. `ITSAppUsesNonExemptEncryption` is set
to `false` accordingly.
