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
teammates while the app is backgrounded** during an active shift (e.g. phone in
pocket while patrolling). This is a genuine, user-initiated, continuous audio
feature — not background download or silent audio. Audio only flows while the
user has joined a radio channel during a shift.

To exercise it: sign in, join the team radio / chat channel, and use the
push-to-talk control.

---

## 4. Location usage (background location disclosure)

Location is used **only while the officer is clocked in on a shift**, for two
operational purposes disclosed in the permission prompts:

- **Clock-in verification:** confirm the officer is physically on-site.
- **Live position + geofence:** share live position with dispatch and alert
  dispatch if the officer leaves their assigned site, or triggers the emergency
  button.

Location sharing stops when the officer clocks out. The in-app EULA and the
usage-description strings describe this. The purpose strings in `Info.plist`:

- *When in use:* "SecureOps uses your location to verify you are on-site when
  you clock in and to share your live position with dispatch while you are on
  shift."
- *Always/background:* "SecureOps uses your location in the background while you
  are clocked in so dispatch can be alerted if you leave your assigned site or
  trigger an emergency."

To exercise it: sign in as the officer, clock in on an assigned shift, and grant
location. The emergency button is on the officer Home screen (press and hold).

---

## 5. Export compliance — `ITSAppUsesNonExemptEncryption = false`

The app does not use any non-exempt encryption. All encryption used is standard
and exempt: HTTPS/TLS for network transport, and LiveKit's end-to-end audio
encryption uses standard algorithms provided by the platform. There is no
proprietary or non-standard cryptography. `ITSAppUsesNonExemptEncryption` is set
to `false` accordingly.
