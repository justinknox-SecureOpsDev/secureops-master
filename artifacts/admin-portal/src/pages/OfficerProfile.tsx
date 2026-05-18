import { useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useRoute, useLocation } from "wouter";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, User, Mail, Phone, ShieldCheck, AlertTriangle, Loader2,
  ExternalLink, MessageCircle, PhoneCall, Calendar, ShieldAlert, MapPin,
} from "lucide-react";

type Officer = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  phone: string | null;
  maxLicenseLevel: number | null;
  licenseCount: number;
  expiringLicenseCount: number;
};

type ShiftAssignment = {
  id: string;
  employeeId: string;
  status: string;
};

type Shift = {
  id: string;
  title: string | null;
  startTime: string;
  endTime: string;
  status: string;
  location: string | null;
  clientName: string | null;
  siteId: string | null;
  assignments: ShiftAssignment[];
};

type Incident = {
  id: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
  occurredAt: string | null;
  createdAt: string;
  locationDescription: string | null;
};

type ChatRoom = { id: string; name: string };

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-600 text-white",
  inactive: "bg-slate-400 text-white",
  pending: "bg-amber-500 text-black",
};

const SEV_TONE: Record<Incident["severity"], string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-yellow-500 text-black",
  low: "bg-slate-400 text-white",
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function startOfToday(): Date {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
}
function endOfToday(): Date {
  const d = new Date(); d.setHours(23, 59, 59, 999); return d;
}

/**
 * Officer profile page reachable from the Dispatch Live Map "View profile"
 * popup action and the personnel roster. Both dispatchers and admins can
 * open it; `GET /employees/:id` is role-aware, so dispatchers see only the
 * operational-safe projection.
 *
 * Read-only profile data — but dispatchers can act from here: open a DM,
 * dial the officer, or jump to today's shift / recent incidents.
 */
export default function OfficerProfilePage() {
  const [, params] = useRoute<{ id: string }>("/personnel/:id");
  const [, navigate] = useLocation();
  const id = params?.id ?? "";

  const officer = useQuery<Officer>({
    queryKey: ["officer", id],
    queryFn: () => api<Officer>(`/employees/${encodeURIComponent(id)}`),
    enabled: !!id,
  });

  // Today's shift window covers anything scheduled to start today or
  // currently in progress that started earlier. We pull a slightly wider
  // window (start of today through end of today) and let the UI pick the
  // best row to highlight as "now".
  const todaysShifts = useQuery<Shift[]>({
    queryKey: ["officer-shifts-today", id],
    queryFn: () => {
      const from = startOfToday().toISOString();
      const to = endOfToday().toISOString();
      return api<Shift[]>(
        `/shifts?employeeId=${encodeURIComponent(id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
    },
    enabled: !!id,
  });

  const recentIncidents = useQuery<Incident[]>({
    queryKey: ["officer-incidents-recent", id],
    queryFn: () => api<Incident[]>(`/incidents?employeeId=${encodeURIComponent(id)}`),
    enabled: !!id,
  });

  // Send-message handler: idempotently open/create the 1:1 DM, then
  // deep-link the existing /chat?room=<id> route.
  const openDm = useMutation<ChatRoom, Error, void>({
    mutationFn: async () =>
      api<ChatRoom>("/chat/direct", {
        method: "POST",
        body: JSON.stringify({ otherUserId: id }),
      }),
    onSuccess: (room) => navigate(`/chat?room=${encodeURIComponent(room.id)}`),
  });

  // Pick the most relevant shift to surface as "today's shift":
  // 1) an in-progress shift (start ≤ now ≤ end)
  // 2) the next shift starting later today
  // 3) otherwise nothing
  const todaysShift = useMemo<Shift | null>(() => {
    const rows = todaysShifts.data ?? [];
    if (rows.length === 0) return null;
    const now = Date.now();
    const sorted = [...rows].sort((a, b) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    const active = sorted.find((s) =>
      new Date(s.startTime).getTime() <= now && new Date(s.endTime).getTime() >= now);
    if (active) return active;
    const upcoming = sorted.find((s) => new Date(s.startTime).getTime() > now);
    return upcoming ?? sorted[sorted.length - 1] ?? null;
  }, [todaysShifts.data]);

  const recent5 = useMemo<Incident[]>(() => {
    const rows = recentIncidents.data ?? [];
    return [...rows]
      .sort((a, b) =>
        new Date(b.occurredAt ?? b.createdAt).getTime() -
        new Date(a.occurredAt ?? a.createdAt).getTime())
      .slice(0, 5);
  }, [recentIncidents.data]);

  return (
    <div className="p-4 lg:p-6 max-w-[1000px] mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <Link href="/personnel">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" /> Personnel
          </Button>
        </Link>
        <Link href="/dispatch">
          <Button variant="ghost" size="sm" className="opacity-70">
            <ArrowLeft className="w-4 h-4 mr-1" /> Dispatch
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="w-5 h-5 brand-gold" />
            Officer profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          {officer.isLoading && (
            <div className="text-sm opacity-60 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {officer.error && (
            <div className="rounded border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" />
              {officer.error instanceof Error ? officer.error.message : "Could not load officer."}
            </div>
          )}
          {officer.data && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="text-xl font-semibold brand-wordmark">
                  {officer.data.lastName}, {officer.data.firstName}
                </div>
                <Badge className={`text-[10px] uppercase ${STATUS_TONE[officer.data.status] ?? "bg-slate-400 text-white"}`}>
                  {officer.data.status}
                </Badge>
                <Badge className="bg-brand-navy text-brand-gold uppercase text-[10px]">
                  {officer.data.role}
                </Badge>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => openDm.mutate()}
                  disabled={openDm.isPending}
                  data-testid="officer-send-message"
                >
                  {openDm.isPending ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <MessageCircle className="w-4 h-4 mr-1" />
                  )}
                  Send message
                </Button>
                {officer.data.phone ? (
                  <a href={`tel:${officer.data.phone}`} data-testid="officer-call">
                    <Button size="sm" variant="outline">
                      <PhoneCall className="w-4 h-4 mr-1" />
                      Call {officer.data.phone}
                    </Button>
                  </a>
                ) : (
                  <Button size="sm" variant="outline" disabled title="No phone on file">
                    <PhoneCall className="w-4 h-4 mr-1" />
                    No phone on file
                  </Button>
                )}
              </div>
              {openDm.error && (
                <div className="text-xs text-red-700">
                  Could not open chat: {openDm.error.message}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded border p-3 flex items-start gap-2">
                  <Mail className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Email</div>
                    <a className="underline truncate block" href={`mailto:${officer.data.email}`}>
                      {officer.data.email}
                    </a>
                  </div>
                </div>
                <div className="rounded border p-3 flex items-start gap-2">
                  <Phone className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Phone</div>
                    {officer.data.phone ? (
                      <a className="underline" href={`tel:${officer.data.phone}`}>{officer.data.phone}</a>
                    ) : (
                      <span className="opacity-60">—</span>
                    )}
                  </div>
                </div>
                <div className="rounded border p-3 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Max licence</div>
                    <div>
                      {officer.data.maxLicenseLevel == null
                        ? <span className="opacity-50">none on file</span>
                        : `L${officer.data.maxLicenseLevel}${officer.data.maxLicenseLevel === 4 ? " / PPO" : ""}`}
                    </div>
                  </div>
                </div>
                <div className="rounded border p-3 flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 mt-0.5 brand-gold flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase opacity-60">Licences</div>
                    <div>
                      {officer.data.licenseCount}
                      {officer.data.expiringLicenseCount > 0 && (
                        <span className="ml-1.5 text-amber-700">
                          · {officer.data.expiringLicenseCount} expiring within 30d
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="text-xs opacity-60">
                Read-only. To edit this officer, open the admin Personnel grid.
                <Link href="/personnel">
                  <Button variant="link" size="sm" className="text-xs h-auto p-0 ml-2">
                    Open roster <ExternalLink className="w-3 h-3 ml-1" />
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Calendar className="w-5 h-5 brand-gold" />
            Today's shift
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {todaysShifts.isLoading && (
            <div className="opacity-60 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {todaysShifts.error && (
            <div className="text-xs text-red-700">
              Could not load shifts: {todaysShifts.error instanceof Error ? todaysShifts.error.message : "unknown error"}
            </div>
          )}
          {!todaysShifts.isLoading && !todaysShift && (
            <div className="opacity-60">No shifts scheduled today.</div>
          )}
          {todaysShift && (
            <div className="space-y-1">
              <div className="font-medium">{todaysShift.title ?? "Untitled shift"}</div>
              <div className="opacity-80">
                {fmtDateTime(todaysShift.startTime)} — {fmtDateTime(todaysShift.endTime)}
              </div>
              {(todaysShift.clientName || todaysShift.location) && (
                <div className="opacity-70 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {[todaysShift.clientName, todaysShift.location].filter(Boolean).join(" · ")}
                </div>
              )}
              <div className="pt-1">
                <Link href={`/admin/tables/shifts?focus=${encodeURIComponent(todaysShift.id)}`}>
                  <Button variant="link" size="sm" className="text-xs h-auto p-0">
                    Open shift <ExternalLink className="w-3 h-3 ml-1" />
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="w-5 h-5 brand-gold" />
            Recent incidents
            {recent5.length > 0 && (
              <span className="ml-auto text-xs opacity-60 font-normal">
                last {recent5.length}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {recentIncidents.isLoading && (
            <div className="opacity-60 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {recentIncidents.error && (
            <div className="text-xs text-red-700">
              Could not load incidents: {recentIncidents.error instanceof Error ? recentIncidents.error.message : "unknown error"}
            </div>
          )}
          {!recentIncidents.isLoading && recent5.length === 0 && (
            <div className="opacity-60">No incidents on file.</div>
          )}
          {recent5.length > 0 && (
            <ul className="divide-y">
              {recent5.map((inc) => (
                <li key={inc.id} className="py-2 flex items-start gap-3">
                  <Badge className={`text-[10px] uppercase shrink-0 ${SEV_TONE[inc.severity]}`}>
                    {inc.severity}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{inc.title}</div>
                    <div className="text-xs opacity-70">
                      {fmtDateTime(inc.occurredAt ?? inc.createdAt)}
                      {inc.locationDescription ? ` · ${inc.locationDescription}` : ""}
                      <span className="ml-1.5 uppercase opacity-60">· {inc.status}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
