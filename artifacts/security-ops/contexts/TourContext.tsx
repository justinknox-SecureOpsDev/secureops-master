import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { storage } from "@/utils/storage";
import { useAuth } from "@/contexts/AuthContext";

interface TourContextType {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const TourContext = createContext<TourContextType | null>(null);

const tourStorageKey = (userId: string) => `wcsg.officer.tour.seen.${userId}`;

export function TourProvider({ children }: { children: ReactNode }) {
  const { user, awaitingBiometric, isLoading } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const checkedFor = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading || awaitingBiometric) return;
    if (!user || user.role !== "employee") return;
    if (checkedFor.current === user.id) return;
    checkedFor.current = user.id;
    let cancelled = false;
    (async () => {
      const seen = await storage.get(tourStorageKey(user.id));
      if (!cancelled && !seen) setIsOpen(true);
    })();
    return () => { cancelled = true; };
  }, [user, awaitingBiometric, isLoading]);

  const open = useCallback(() => setIsOpen(true), []);

  const close = useCallback(() => {
    setIsOpen(false);
    if (user?.id) {
      storage.set(tourStorageKey(user.id), "1").catch(() => {});
    }
  }, [user]);

  return (
    <TourContext.Provider value={{ isOpen, open, close }}>
      {children}
    </TourContext.Provider>
  );
}

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used within a TourProvider");
  return ctx;
}
