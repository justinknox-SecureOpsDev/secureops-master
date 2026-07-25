import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView; the deep-link focus hook calls it.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom doesn't implement matchMedia; the responsive useIsMobile hook calls it.
// Default to desktop (no match) so DataGrid renders its table layout under test.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// Reset persisted browser state before each test so no test depends on
// another's leftover UI preferences (view mode, filters, jump date, etc.)
// that components read from localStorage/sessionStorage on mount.
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
});
