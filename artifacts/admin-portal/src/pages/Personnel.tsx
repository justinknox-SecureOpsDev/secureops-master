import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Users, Loader2, AlertTriangle, ArrowUpDown } from "lucide-react";

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

  const activeOfficers = useQuery<ActiveOfficer[]>({
    queryKey: ["personnel", "active-officers"],
    queryFn: () => api<ActiveOfficer[]>("/admin/active-officers"),
    refetchInterval: 30_000,
  });

  const activeById = useMemo(() => {
    const map = new Map<string, ActiveOfficer>();
    for (const o of activeOfficers.data ?? []) map.set(o.userId, o);
    return map;
  }, [activeOfficers.data]);

  const sorted = useMemo(() => {
    const data = employees.data ?? [];
    const copy = [...data];
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
  }, [employees.data, activeById, sortKey]);

  return (
    <div className="p-4 lg:p-6 max-w-[1200px] mx-auto">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="w-5 h-5 brand-gold" />
            Personnel
            <span className="ml-auto text-xs opacity-60 font-normal">{sorted.length} officers</span>
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
                  return (
                    <tr key={e.id} className="border-t hover:bg-muted/30">
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
                      <td className="p-2 opacity-80">
                        {e.licenseCount}
                        {e.expiringLicenseCount > 0 && (
                          <span className="ml-1.5 text-amber-700">· {e.expiringLicenseCount} expiring</span>
                        )}
                      </td>
                      <td className="p-2">
                        {live ? (
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
                        ) : (
                          <span className="opacity-40">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!employees.isLoading && sorted.length === 0 && (
                  <tr><td colSpan={7} className="p-4 text-center opacity-60">No matching officers.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
