import React, { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";
import { storage } from "@/utils/storage";

interface AccessibilityContextType {
  /** When true, the app renders with a pure-black high-contrast palette. */
  highContrast: boolean;
  setHighContrast: (next: boolean) => void;
  /** False until the persisted preference has been read from storage. */
  ready: boolean;
}

const HIGH_CONTRAST_KEY = "wcsg.officer.highContrast";

const AccessibilityContext = createContext<AccessibilityContextType>({
  highContrast: false,
  setHighContrast: () => {},
  ready: true,
});

export function AccessibilityProvider({ children }: { children: ReactNode }) {
  const [highContrast, setHighContrastState] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await storage.get(HIGH_CONTRAST_KEY);
      if (!cancelled) {
        setHighContrastState(saved === "1");
        setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setHighContrast = useCallback((next: boolean) => {
    setHighContrastState(next);
    storage.set(HIGH_CONTRAST_KEY, next ? "1" : "0").catch(() => {});
  }, []);

  return (
    <AccessibilityContext.Provider value={{ highContrast, setHighContrast, ready }}>
      {children}
    </AccessibilityContext.Provider>
  );
}

/**
 * Safe to call outside the provider — falls back to the default (high contrast
 * off) so screens that render before the provider mounts don't crash.
 */
export function useAccessibility() {
  return useContext(AccessibilityContext);
}
