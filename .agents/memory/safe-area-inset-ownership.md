---
name: Safe-area top-inset ownership (security-ops)
description: Why nested SafeAreaViews double-pad, and which security-ops screens must own the notch inset vs opt out of it.
---

`SafeAreaView` from `react-native-safe-area-context` pads by the **device**
inset for its declared edges **regardless of where it sits in the tree**. It is
not "remaining unsafe area" — a SafeAreaView nested below another top-padded
element pads a *second* time.

**Why:** the officer Chat screen put its Messages/Radio switcher in a plain
`View` at y=0 under `headerShown:false` tabs, so the switcher rendered beneath
the notch and Radio was unreachable. Both panes below it (`ChatRoomsList`,
`RadioScreen`) meanwhile applied their own top inset, adding a dead gap. Two
symptoms, one root cause: nobody owned the top inset and everybody applied it.

**How to apply:** exactly one element per screen owns the top inset.

- The employee tab layout is `headerShown: false` → the **screen** must own it.
- The admin tab layout is `headerShown: true` → the **native header** owns it,
  so screens under it should opt out.
- `ChatRoomsList` and `RadioScreen` are shared across both layouts *and* render
  both standalone and embedded under the Chat switcher, so inset ownership
  cannot be hardcoded — both take a `topInset` prop (default `true`, matching
  standalone use) and hosts pass `topInset={false}` when something above them
  already reserved the space.

Watch for a screen whose loading branch uses bare `<SafeAreaView>` (defaults to
**all four** edges) while its loaded branch declares `edges={["top"]}` — that
mismatch makes the layout jump when data arrives. `edges={[]}` is a valid no-op.

Insets are 0 on Expo web, so this class of bug cannot be reproduced in a browser
preview or caught by the web-rendered a11y gates — it only shows on a notched
device.
