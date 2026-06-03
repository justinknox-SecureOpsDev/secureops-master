---
name: Responsive single-render ref/behavior parity
description: When a responsive component renders one of two layouts (desktop table vs mobile cards) instead of both, any ref or behavior wired to one branch must be duplicated on the other.
---

When making a component mobile-friendly, prefer single-render (`useIsMobile()` → render EITHER `<Table>` OR a card list) over the dual CSS approach (`hidden md:block` + `md:hidden`). The dual-DOM approach renders BOTH copies into jsdom and breaks tests with duplicate text/rows.

**The trap:** any `ref`, callback, or conditional class attached to rows in ONE branch silently stops working in the other. Concretely: the admin DataGrid deep-link focus (`useDeepLinkFocus` scroll-into-view + `wcsg-deep-link-flash`) attaches `focusRowRef` to the desktop `<TableRow>`. After converting to single-render, the ref must ALSO be attached to the mobile card wrapper, or focus/scroll/flash is dead on mobile (effect early-exits on `!ref.current`). Architect review caught this; it passed typecheck and all existing tests because the existing tests only run the desktop layout.

**How to apply:**
- After any dual-layout → single-render refactor, audit every per-row `ref=`, `onClick`, and behavioral class and mirror it onto the other branch.
- Add a test that forces the mobile branch: override `window.innerWidth` AND `window.matchMedia` (`matches:true`) in `beforeEach`, restore in `afterEach`. `useIsMobile` seeds from `innerWidth` then subscribes via `matchMedia`, so both are needed.
- jsdom needs a `window.matchMedia` polyfill in `vitest.setup.ts` (default `matches:false` → desktop) or `useIsMobile()` throws.

**Why:** silent behavioral regressions that only manifest on one viewport are invisible to typecheck and to tests that only exercise the other viewport.
