---
name: App Store 5.1.5 EULA + emergency/location disclaimer
description: Why the app ships an in-app EULA and what must stay in sync with the emergency/location feature to keep Apple review passing.
---

Apple rejected the SecureOps mobile build under Guideline 5.1.5 (Location
Services) because a location-based emergency-dispatch feature needs (1) a EULA
containing a disclaimer addressing the specific service, and (2) evidence that
dispatch/emergency services can receive & identify the user's location.

The app satisfies this with a public EULA page (a `EulaPage` in the admin-portal
Legal module, served pre-auth at `/admin-portal/eula`, same routing block as
privacy/terms/data-rights) linked from the mobile login legal row, the admin
login footer, and the shared legal footer.

**Rule:** any change to the emergency/panic or live-location behavior (the
`/emergency` route and the on-shift location pings) MUST keep the EULA's
"Location services and emergency features" disclaimer accurate — especially that
it is NOT a substitute for calling 911, that location may be inaccurate/delayed/
unavailable, and how the alert+location reach the org's dispatch/admins.

**Why:** the disclaimer is the artifact Apple review checks against the actual
feature; drift between them re-opens the 5.1.5 rejection.

**How to apply:** when editing the emergency flow or location sharing, re-read
the EULA section and update it in lockstep. The "evidence" Apple wants is the
critical incident record (officer identity + lat/lng/locationDescription) plus
the push/SMS/email coordinate alert to admins — point App Review Notes at that,
and give App Store Connect the public `/admin-portal/eula` URL.
