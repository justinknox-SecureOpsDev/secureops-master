const DEFAULT_BASE = "https://event-staff-scheduler.replit.app";

export const SHIFTBOARD_BASE_URL: string =
  (import.meta.env.VITE_SHIFTBOARD_URL as string | undefined)?.replace(/\/$/, "") ||
  DEFAULT_BASE;

export const SHIFTBOARD_API = `${SHIFTBOARD_BASE_URL}/api`;

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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SHIFTBOARD_API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error || body?.message) msg = body.error || body.message;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export const shiftboard = {
  listEvents: () => api<ShiftboardEvent[]>(`/events`),
  createEvent: (body: {
    name: string;
    location: string;
    description?: string;
    startDate?: string;
    endDate?: string;
  }) => api<ShiftboardEvent>(`/events`, { method: "POST", body: JSON.stringify(body) }),
  getEventFull: (id: number) => api<ShiftboardEventFull>(`/events/${id}/full`),
  getEventStats: (id: number) => api<ShiftboardStats>(`/events/${id}/stats`),
  updateEvent: (
    id: number,
    body: Partial<{ name: string; location: string; description: string; startDate: string; endDate: string }>,
  ) => api<ShiftboardEvent>(`/events/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteEvent: (id: number) => api<void>(`/events/${id}`, { method: "DELETE" }),
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
  ) => api<ShiftboardShift>(`/events/${eventId}/shifts`, { method: "POST", body: JSON.stringify(body) }),
  deleteSignup: (signupId: number, name: string) =>
    api<void>(`/signups/${signupId}?name=${encodeURIComponent(name)}`, { method: "DELETE" }),
};

export function publicShareUrl(slug: string): string {
  return `${SHIFTBOARD_BASE_URL}/share/${slug}`;
}
