import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Users, Loader2, AlertTriangle } from "lucide-react";

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

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-600 text-white",
  inactive: "bg-slate-400 text-white",
  pending: "bg-amber-500 text-black",
};

/**
 * Read-only personnel roster for dispatchers (admins also use this
 * shortcut from the side nav). All write operations remain on the
 * admin-only /admin/tables/employees grid.
 */
export default function PersonnelPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("");
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

  const sorted = useMemo(() => {
    const data = employees.data ?? [];
    return [...data].sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));
  }, [employees.data]);

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
                  <th className="text-left p-2">Name</th>
                  <th className="text-left p-2">Email</th>
                  <th className="text-left p-2">Phone</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-left p-2">Max licence</th>
                  <th className="text-left p-2">Licences</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className="p-2 font-medium">{e.lastName}, {e.firstName}</td>
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
                  </tr>
                ))}
                {!employees.isLoading && sorted.length === 0 && (
                  <tr><td colSpan={6} className="p-4 text-center opacity-60">No matching officers.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
