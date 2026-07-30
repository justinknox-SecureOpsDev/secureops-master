import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Loader2, AlertTriangle, ArrowUpDown, MessageCircle, FileUp, Send, Smartphone } from "lucide-react";
import { PdfImportWizard } from "@/components/PdfImportWizard";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

type Employee = {
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

type ActiveOfficer = {
  userId: string;
  firstName: string;
  lastName: string;
  lastLat: string | null;
  lastLng: string | null;
  lastLocationAt: string | null;
  clockInTime: string | null;
  shiftId: string | null;
  shiftTitle: string | null;
  siteName: string | null;
};

type AppVersionRow = {
  id: string;
  appProjectId: string | null;
  appVersion: string | null;
  appBuildNumber: string | null;
  appPlatform: string | null;
  appReportedAt: string | null;
  appUpdateNotifiedAt: string | null;
  onCurrentApp: boolean;
};

type AppVersionsResponse = {
  currentProjectId: string;
  defaults: { message: string; iosUrl: string; androidUrl: string };
  users: AppVersionRow[];
};

type NoticeSummary = {
  total: number;
  inApp: number;
  push: number;
  sms: { attempted: number; delivered: number; skipped: number; failed: number } | null;
  unreachable: { id: string; firstName: string; lastName: string }[];
  notifiedAt: string;
};

type UnreadCount = {
  roomId: string;
  otherUserId: string;
  unreadCount: number;
};

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-600 text-white",
  inactive: "bg-slate-400 text-white",
  pending: "bg-amber-500 text-black",
};

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "no ping";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type SortKey = "name" | "onDuty";

/**
 * Read-only personnel roster for dispatchers (admins also use this
 * shortcut from the side nav). All write operations remain on the
 * admin-only /admin/tables/employees grid.
 *
 * The "On duty / last ping" column joins each row against the existing
 * /admin/active-officers payload (polled every 30s) so dispatchers
 * triaging an active call can spot who's currently clocked in without
 * opening individual profiles. Click any row to jump to the full
 * live-location card on OfficerProfile.
 */
export default function PersonnelPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [importOpen, setImportOpen] = useState(false);
  const [onlyOutdated, setOnlyOutdated] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [noticeMsg, setNoticeMsg] = useState("");
  const [iosUrl, setIosUrl] = useState("");
  const [androidUrl, setAndroidUrl] = useState("");
  const [withSms, setWithSms] = useState(false);
  const [summary, setSummary] = useState<NoticeSummary | null>(null);
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // App-version data (and the notice sender) is admin/dispatcher only —
  // site managers also browse this roster and must not trigger 403 noise.
  const canNotify = user?.role === "admin" || user?.role === "dispatcher";

  // Open (or create) a 1:1 DM with an on-duty officer and jump to Chat.
  // The server upserts the direct room keyed on the participant pair, so
  // repeated clicks always resolve to the same conversation.
  const openDirect = useMutation({
    mutationFn: (otherUserId: string) =>
      api<{ id: string }>("/chat/direct", { method: "POST", body: { otherUserId } }),
    onSuccess: (room) => setLocation(`/chat?room=${room.id}`),
  });

  const employees = useQuery<Employee[]>({
    queryKey: ["personnel", search, status],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      const q = params.toString();
      return api<Employee[]>(`/employees${q ? `?${q}` : ""}`);
    },
  });

  const appVersions = useQuery<AppVersionsResponse>({
    queryKey: ["personnel", "app-versions"],
    queryFn: () => api<AppVersionsResponse>("/admin/app-versions"),
    enabled: canNotify,
  });

  const sendNotice = useMutation({
    mutationFn: () =>
      api<NoticeSummary>("/admin/app-update-notice", {
        method: "POST",
        body: {
          userIds: Array.from(selected),
          message: noticeMsg,
          iosUrl,
          androidUrl,
          sendSms: withSms,
        },
      }),
    onSuccess: (s) => {
      setSummary(s);
      void appVersions.refetch();
    },
  });

  const openNotice = () => {
    const d = appVersions.data?.defaults;
    setNoticeMsg(d?.message ?? "");
    setIosUrl(d?.iosUrl ?? "");
    setAndroidUrl(d?.androidUrl ?? "");
    setWithSms(false);
    setSummary(null);
    sendNotice.reset();
    setNoticeOpen(true);
  };

  const activeOfficers = useQuery<ActiveOfficer[]>({
    queryKey: ["personnel", "active-officers"],
    queryFn: () => api<ActiveOfficer[]>("/admin/active-officers"),
    refetchInterval: 30_000,
  });

  // Per-officer unread DM counts, keyed by the officer's userId so the
  // message shortcut can render a badge without first resolving the DM room.
  // Polled on the same 30s cadence as the active-officer roster.
  const unreadCounts = useQuery<UnreadCount[]>({
    queryKey: ["personnel", "unread-counts"],
    queryFn: () => api<UnreadCount[]>("/chat/unread-counts"),
    refetchInterval: 30_000,
  });

  const activeById = useMemo(() => {
    const map = new Map<string, ActiveOfficer>();
    for (const o of activeOfficers.data ?? []) map.set(o.userId, o);
    return map;
  }, [activeOfficers.data]);

  const unreadByUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of unreadCounts.data ?? []) {
      if (c.unreadCount > 0) map.set(c.otherUserId, c.unreadCount);
    }
    return map;
  }, [unreadCounts.data]);

  const appById = useMemo(() => {
    const map = new Map<string, AppVersionRow>();
    for (const r of appVersions.data?.users ?? []) map.set(r.id, r);
    return map;
  }, [appVersions.data]);

  const sorted = useMemo(() => {
    const data = employees.data ?? [];
    // "Not on the current app" filter: no report at all (legacy app can't
    // report) counts as outdated — never-seen is the whole point.
    const filtered = onlyOutdated
      ? data.filter((e) => !(appById.get(e.id)?.onCurrentApp))
      : data;
    const copy = [...filtered];
    if (sortKey === "onDuty") {
      // On-duty officers first, then by most-recent ping; off-shift rows
      // sink to the bottom in name order so the list stays predictable.
      copy.sort((a, b) => {
        const aa = activeById.get(a.id);
        const bb = activeById.get(b.id);
        if (!!aa !== !!bb) return aa ? -1 : 1;
        if (aa && bb) {
          const at = aa.lastLocationAt ? new Date(aa.lastLocationAt).getTime() : 0;
          const bt = bb.lastLocationAt ? new Date(bb.lastLocationAt).getTime() : 0;
          if (bt !== at) return bt - at;
        }
        return `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`);
      });
    } else {
      copy.sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
    }
    return copy;
  }, [employees.data, activeById, sortKey, onlyOutdated, appById]);

  const allVisibleSelected = sorted.length > 0 && sorted.every((e) => selected.has(e.id));
  const toggleAll = () => {
    setSelected((prev) => {
      if (allVisibleSelected) return new Set();
      const next = new Set(prev);
      for (const e of sorted) next.add(e.id);
      return next;
    });
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const showSelect = canNotify && onlyOutdated;

  return (
    <div className="p-4 lg:p-6 max-w-[1200px] mx-auto">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="w-5 h-5 brand-gold" />
            Personnel
            <span className="ml-auto text-xs opacity-60 font-normal">{sorted.length} officers</span>
            {isAdmin && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => setImportOpen(true)}
              >
                <FileUp className="w-4 h-4" />
                Import from PDF
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Search name or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
            <select
              className="rounded border px-2 py-1.5 bg-background text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="pending">Pending</option>
            </select>
            {canNotify && (
              <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer select-none rounded border px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={onlyOutdated}
                  onChange={(e) => {
                    setOnlyOutdated(e.target.checked);
                    if (!e.target.checked) setSelected(new Set());
                  }}
                />
                Not on current app
              </label>
            )}
            {showSelect && (
              <Button
                type="button"
                size="sm"
                className="h-9 gap-1.5"
                disabled={selected.size === 0 || appVersions.isLoading}
                onClick={openNotice}
              >
                <Send className="w-4 h-4" />
                Send install notice{selected.size > 0 ? ` (${selected.size})` : ""}
              </Button>
            )}
          </div>

          {employees.isLoading && (
            <div className="text-sm opacity-60 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {employees.error && (
            <div className="rounded border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" />
              {employees.error instanceof Error ? employees.error.message : "Could not load personnel."}
            </div>
          )}

          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide opacity-70">
                <tr>
                  {showSelect && (
                    <th className="p-2 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all filtered officers"
                        checked={allVisibleSelected}
                        onChange={toggleAll}
                      />
                    </th>
                  )}
                  <th className="text-left p-2">
                    <button
                      type="button"
                      onClick={() => setSortKey("name")}
                      className={`inline-flex items-center gap-1 ${sortKey === "name" ? "text-foreground" : ""}`}
                    >
                      Name <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="text-left p-2">Email</th>
                  <th className="text-left p-2">Phone</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-left p-2">Max licence</th>
                  {canNotify && <th className="text-left p-2">App version</th>}
                  <th className="text-left p-2">Licences</th>
                  <th className="text-left p-2">
                    <button
                      type="button"
                      onClick={() => setSortKey("onDuty")}
                      className={`inline-flex items-center gap-1 ${sortKey === "onDuty" ? "text-foreground" : ""}`}
                      title="Sort on-duty officers to the top"
                    >
                      On duty / last ping <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => {
                  const live = activeById.get(e.id);
                  const app = appById.get(e.id);
                  return (
                    <tr key={e.id} className="border-t hover:bg-muted/30">
                      {showSelect && (
                        <td className="p-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${e.firstName} ${e.lastName}`}
                            checked={selected.has(e.id)}
                            onChange={() => toggleOne(e.id)}
                          />
                        </td>
                      )}
                      <td className="p-2 font-medium">
                        <Link href={`/personnel/${e.id}`} className="hover:underline">
                          {e.lastName}, {e.firstName}
                        </Link>
                      </td>
                      <td className="p-2 opacity-80">{e.email}</td>
                      <td className="p-2 opacity-80">{e.phone ?? "—"}</td>
                      <td className="p-2">
                        <Badge className={`text-[10px] uppercase ${STATUS_TONE[e.status] ?? "bg-slate-400 text-white"}`}>
                          {e.status}
                        </Badge>
                      </td>
                      <td className="p-2">
                        {e.maxLicenseLevel == null
                          ? <span className="opacity-50">none</span>
                          : `L${e.maxLicenseLevel}${e.maxLicenseLevel === 4 ? "/PPO" : ""}`}
                      </td>
                      {canNotify && (
                        <td className="p-2">
                          {app?.onCurrentApp ? (
                            <div className="flex flex-col">
                              <span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-medium">
                                <Smartphone className="w-3 h-3" />
                                v{app.appVersion ?? "?"}{app.appPlatform ? ` · ${app.appPlatform}` : ""}
                              </span>
                              <span className="text-[11px] opacity-60">seen {fmtAgo(app.appReportedAt)}</span>
                            </div>
                          ) : (
                            <div className="flex flex-col">
                              <Badge className="bg-amber-500 text-black text-[10px] uppercase w-fit">
                                Old app / unknown
                              </Badge>
                              <span className="text-[11px] opacity-60">
                                {app?.appReportedAt ? `seen ${fmtAgo(app.appReportedAt)}` : "never reported"}
                                {app?.appUpdateNotifiedAt ? ` · notified ${fmtAgo(app.appUpdateNotifiedAt)}` : ""}
                              </span>
                            </div>
                          )}
                        </td>
                      )}
                      <td className="p-2 opacity-80">
                        {e.licenseCount}
                        {e.expiringLicenseCount > 0 && (
                          <span className="ml-1.5 text-amber-700">· {e.expiringLicenseCount} expiring</span>
                        )}
                      </td>
                      <td className="p-2">
                        {live ? (
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/personnel/${e.id}`}
                              className="inline-flex items-center gap-1.5 hover:underline"
                              title={live.siteName ? `On duty at ${live.siteName}` : "On duty"}
                            >
                              <span
                                className="inline-block w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-emerald-500/30"
                                aria-hidden="true"
                              />
                              <span className="text-xs">{fmtAgo(live.lastLocationAt)}</span>
                            </Link>
                            {(() => {
                              const unread = unreadByUser.get(e.id) ?? 0;
                              return (
                                <button
                                  type="button"
                                  onClick={() => openDirect.mutate(e.id)}
                                  disabled={openDirect.isPending}
                                  className="relative inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                                  title={unread > 0 ? `Message ${e.firstName} · ${unread} unread` : `Message ${e.firstName}`}
                                  aria-label={
                                    unread > 0
                                      ? `Message ${e.firstName} ${e.lastName}, ${unread} unread message${unread === 1 ? "" : "s"}`
                                      : `Message ${e.firstName} ${e.lastName}`
                                  }
                                >
                                  {openDirect.isPending && openDirect.variables === e.id ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <MessageCircle className="w-3.5 h-3.5" />
                                  )}
                                  {unread > 0 && (
                                    <span
                                      className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold leading-4 text-center"
                                      aria-hidden="true"
                                    >
                                      {unread > 99 ? "99+" : unread}
                                    </span>
                                  )}
                                </button>
                              );
                            })()}
                          </div>
                        ) : (
                          <span className="opacity-40">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!employees.isLoading && sorted.length === 0 && (
                  <tr><td colSpan={9} className="p-4 text-center opacity-60">No matching officers.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      {isAdmin && (
        <PdfImportWizard open={importOpen} onOpenChange={setImportOpen} />
      )}
      <Dialog open={noticeOpen} onOpenChange={setNoticeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send "install the new app" notice</DialogTitle>
            <DialogDescription>
              {summary
                ? "Delivery summary"
                : `Sends a push notification and an in-app notification to ${selected.size} selected ${selected.size === 1 ? "person" : "people"}. Because the app listing changed, they must install the new app from the store — "Update" in their old app won't work.`}
            </DialogDescription>
          </DialogHeader>
          {summary ? (
            <div className="space-y-2 text-sm">
              <div className="rounded border p-3 space-y-1">
                <div>In-app notification: <b>{summary.inApp}</b> of {summary.total}</div>
                <div>Push notification: <b>{summary.push}</b> of {summary.total} had a push-capable device</div>
                <div>
                  SMS:{" "}
                  {summary.sms
                    ? <><b>{summary.sms.delivered}</b> delivered · {summary.sms.skipped} skipped · {summary.sms.failed} failed</>
                    : "not sent"}
                </div>
              </div>
              {summary.unreachable.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3">
                  <div className="font-medium text-amber-900 mb-1">
                    No push or SMS reached ({summary.unreachable.length}) — in-app only:
                  </div>
                  <div className="text-amber-900/90">
                    {summary.unreachable.map((u) => `${u.firstName} ${u.lastName}`).join(", ")}
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button type="button" onClick={() => { setNoticeOpen(false); setSelected(new Set()); }}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="notice-msg">Message</label>
                <Textarea
                  id="notice-msg"
                  rows={5}
                  value={noticeMsg}
                  onChange={(e) => setNoticeMsg(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium" htmlFor="notice-ios">iPhone App Store link</label>
                  <Input id="notice-ios" value={iosUrl} onChange={(e) => setIosUrl(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium" htmlFor="notice-android">Google Play link</label>
                  <Input id="notice-android" value={androidUrl} onChange={(e) => setAndroidUrl(e.target.value)} />
                </div>
              </div>
              <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={withSms} onChange={(e) => setWithSms(e.target.checked)} />
                Also send as SMS (opted-in users with a phone number)
              </label>
              {sendNotice.error && (
                <div className="rounded border border-red-200 bg-red-50 text-red-900 text-xs px-3 py-2">
                  {sendNotice.error instanceof Error ? sendNotice.error.message : "Could not send the notice."}
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setNoticeOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={sendNotice.isPending || !noticeMsg.trim() || !iosUrl || !androidUrl}
                  onClick={() => sendNotice.mutate()}
                >
                  {sendNotice.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
                  Send to {selected.size}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
