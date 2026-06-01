import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";

/**
 * Read the first present of one or more query-string param names. Lets a deep
 * link use either a generic `focus` id or an entity-specific name (`incidentId`,
 * `shiftId`, …) so the web admin portal accepts the same shapes the mobile app
 * resolves from push payloads.
 */
export function useFirstQueryParam(...names: string[]): string | null {
  const search = useSearch();
  return useMemo(() => {
    const sp = new URLSearchParams(search);
    for (const n of names) {
      const v = sp.get(n);
      if (v) return v;
    }
    return null;
  }, [search, names.join("|")]);
}

/**
 * Drives the scroll-to + highlight behavior for a single deep-linked row,
 * mirroring the mobile app's notification deep links. Attach the returned
 * `ref` to the element whose id matches `focusId`; once `ready` (data loaded),
 * the element is scrolled into view and `flashing` is true for `holdMs` so the
 * consumer can toggle the `wcsg-deep-link-flash` class.
 *
 * `focusId` is included in the dependency list so re-navigating to the same
 * page with a new target (or re-opening the same link, when the caller mixes a
 * nonce into the param) re-fires the effect.
 */
export function useDeepLinkFocus(
  focusId: string | null | undefined,
  ready: boolean,
  holdMs = 1800,
): { ref: React.MutableRefObject<HTMLElement | null>; flashing: boolean } {
  const ref = useRef<HTMLElement | null>(null);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (!focusId || !ready) return;
    const el = ref.current;
    if (!el) return;
    setFlashing(false);
    // Let the row paint + any auto-expand settle before scrolling.
    const tScroll = window.setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashing(true);
    }, 80);
    const tDone = window.setTimeout(() => setFlashing(false), 80 + holdMs);
    return () => {
      clearTimeout(tScroll);
      clearTimeout(tDone);
    };
  }, [focusId, ready, holdMs]);

  return { ref, flashing };
}
