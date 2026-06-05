import { api as serverApi } from "@/lib/api";

// Public share links point at the scheduler's own user-facing page. This is a
// browser navigation target, NOT an API call, so it keeps using the scheduler
// origin directly. All actual API traffic is proxied through the SecureOps API
// server (see below), which holds the shared HMAC secret and signs requests.
const DEFAULT_BASE = "https://event-staff-scheduler.replit.app";

export const SHIFTBOARD_BASE_URL: string =
  (import.meta.env.VITE_SHIFTBOARD_URL as string | undefined)?.replace(/\/$/, "") ||
  DEFAULT_BASE;

export type ShiftboardEvent = {
  id: number;
  name: string;
  slug: string;
  location: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  totalShifts: number;
  totalSlots: number;
  filledSlots: number;
};

export type ShiftboardSignup = {
  id: number;
  shiftId: number;
  name: string;
  phone: string | null;
  email: string | null;
  createdAt?: string;
};

export type ShiftboardShift = {
  id: number;
  eventId: number;
  date: string;
  shiftType: string | null;
  area: string | null;
  position: string;
  role: string | null;
  posCode: string | null;
  startTime: string;
  endTime: string;
  slotsTotal: number;
  notes: string | null;
  signups: ShiftboardSignup[];
};

export type ShiftboardEventFull = {
  event: Omit<ShiftboardEvent, "totalShifts" | "totalSlots" | "filledSlots">;
  shifts: ShiftboardShift[];
};

export type ShiftboardStats = {
  eventId: number;
  totalSlots: number;
  filledSlots: number;
  byDay: { date: string; totalSlots: number; filledSlots: number }[];
};

// All scheduler API calls are proxied through the SecureOps API server, which
// attaches the admin JWT (via `serverApi`) and signs the forwarded request with
// the shared HMAC secret. The browser never talks to the scheduler API or holds
// the secret.
export const shiftboard = {
  listEvents: () => serverApi<ShiftboardEvent[]>(`/admin/scheduler/events`),
  createEvent: (body: {
    name: string;
    location: string;
    description?: string;
    startDate?: string;
    endDate?: string;
  }) => serverApi<ShiftboardEvent>(`/admin/scheduler/events`, { method: "POST", body }),
  getEventFull: (id: number) => serverApi<ShiftboardEventFull>(`/admin/scheduler/events/${id}/full`),
  getEventStats: (id: number) => serverApi<ShiftboardStats>(`/admin/scheduler/events/${id}/stats`),
  updateEvent: (
    id: number,
    body: Partial<{ name: string; location: string; description: string; startDate: string; endDate: string }>,
  ) => serverApi<ShiftboardEvent>(`/admin/scheduler/events/${id}`, { method: "PATCH", body }),
  deleteEvent: (id: number) => serverApi<void>(`/admin/scheduler/events/${id}`, { method: "DELETE" }),
  addShift: (
    eventId: number,
    body: {
      date: string;
      startTime: string;
      endTime: string;
      position: string;
      area?: string;
      role?: string;
      shiftType?: string;
      posCode?: string;
      slotsTotal: number;
      notes?: string;
    },
  ) => serverApi<ShiftboardShift>(`/admin/scheduler/events/${eventId}/shifts`, { method: "POST", body }),
  deleteSignup: (signupId: number, name: string) =>
    serverApi<void>(`/admin/scheduler/signups/${signupId}?name=${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
};

export function publicShareUrl(slug: string): string {
  return `${SHIFTBOARD_BASE_URL}/share/${slug}`;
}
