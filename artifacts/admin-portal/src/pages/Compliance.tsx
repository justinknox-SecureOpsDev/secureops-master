import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, AlertTriangle, CheckCircle2, Clock, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type Site = { id: string; name: string; requiredTrainings?: string[] | null };

type Officer = {
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  maxLicenseLevel: number | null;
  heldTrainings: string[];
  missingTrainings: string[];
  expiringSoon: { id: string; type: string; title: string; expiryDate: string }[];
  compliant: boolean;
};

type Report = {
  siteId: string | null;
  siteName: string | null;
  requiredTrainings: string[];
  officers: Officer[];
};

export default function CompliancePage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string>("");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [onlyNonCompliant, setOnlyNonCompliant] = useState(false);

  useEffect(() => {
    api<{ rows: Site[] }>("/admin/tables/sites?limit=500&offset=0")
      .then((r) => setSites(r.rows ?? []))
      .catch(() => setSites([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    const qs = siteId ? `?siteId=${encodeURIComponent(siteId)}` : "";
    api<Report>(`/admin/compliance${qs}`)
      .then(setReport)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [siteId]);

  const filtered = useMemo(() => {
    if (!report) return [];
    return onlyNonCompliant ? report.officers.filter((o) => !o.compliant) : report.officers;
  }, [report, onlyNonCompliant]);

  const compliantCount = report?.officers.filter((o) => o.compliant).length ?? 0;
  const nonCompliantCount = (report?.officers.length ?? 0) - compliantCount;
  const expiringCount = report?.officers.reduce((n, o) => n + o.expiringSoon.length, 0) ?? 0;

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <div className="flex items-center gap-3">
        <ShieldCheck className="w-6 h-6" style={{ color: "#c9a84c" }} />
        <h1 className="text-2xl font-semibold">Compliance</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Stat icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />} label="Compliant officers" value={compliantCount} />
        <Stat icon={<AlertTriangle className="w-4 h-4 text-amber-600" />} label="Non-compliant" value={nonCompliantCount} highlight={nonCompliantCount > 0} />
        <Stat icon={<Clock className="w-4 h-4 text-rose-600" />} label="Certs expiring ≤30d" value={expiringCount} />
      </div>

      <div className="flex flex-wrap items-end gap-3 p-3 border rounded bg-white">
        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">Site</label>
          <select
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            className="border rounded px-3 py-2 text-sm min-w-[260px]"
          >
            <option value="">— No site (all officers, no training requirements) —</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <Button
          variant={onlyNonCompliant ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyNonCompliant((v) => !v)}
        >
          <Filter className="w-3.5 h-3.5 mr-1" />
          {onlyNonCompliant ? "Showing non-compliant only" : "Show non-compliant only"}
        </Button>
        {report?.siteId && report.requiredTrainings.length > 0 && (
          <div className="text-xs text-muted-foreground ml-auto">
            <span className="font-semibold">Site requires:</span>{" "}
            {report.requiredTrainings.map((t) => (
              <span key={t} className="inline-block px-2 py-0.5 mr-1 rounded bg-amber-100 text-amber-900 border border-amber-300">{t}</span>
            ))}
          </div>
        )}
      </div>

      {err && <div className="p-3 bg-rose-50 text-rose-900 border border-rose-200 rounded text-sm">{err}</div>}

      <div className="border rounded bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b">
            <tr>
              <th className="text-left px-3 py-2 font-semibold">Officer</th>
              <th className="text-left px-3 py-2 font-semibold">Max licence</th>
              <th className="text-left px-3 py-2 font-semibold">Held trainings</th>
              {report?.siteId && <th className="text-left px-3 py-2 font-semibold">Missing for site</th>}
              <th className="text-left px-3 py-2 font-semibold">Expiring ≤30d</th>
              <th className="text-left px-3 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center text-muted-foreground py-8">Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={6} className="text-center text-muted-foreground py-8">No officers to show.</td></tr>
            )}
            {!loading && filtered.map((o) => (
              <tr key={o.employeeId} className="border-b last:border-b-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{o.employeeName}</div>
                  <div className="text-xs text-muted-foreground">{o.employeeEmail}</div>
                </td>
                <td className="px-3 py-2">
                  {o.maxLicenseLevel ? (
                    <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold" style={{ background: "#080c18", color: "#c9a84c" }}>
                      L{o.maxLicenseLevel}
                    </span>
                  ) : <span className="text-xs text-muted-foreground">none</span>}
                </td>
                <td className="px-3 py-2">
                  {o.heldTrainings.length === 0 ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {o.heldTrainings.map((t) => <span key={t} className="px-1.5 py-0.5 rounded text-xs bg-emerald-50 text-emerald-900 border border-emerald-200">{t}</span>)}
                    </div>
                  )}
                </td>
                {report?.siteId && (
                  <td className="px-3 py-2">
                    {o.missingTrainings.length === 0 ? (
                      <span className="text-xs text-emerald-700">none</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {o.missingTrainings.map((t) => <span key={t} className="px-1.5 py-0.5 rounded text-xs bg-rose-50 text-rose-900 border border-rose-200">{t}</span>)}
                      </div>
                    )}
                  </td>
                )}
                <td className="px-3 py-2">
                  {o.expiringSoon.length === 0 ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <div className="space-y-0.5">
                      {o.expiringSoon.map((c) => (
                        <div key={c.id} className="text-xs">
                          <span className="font-medium">{c.title}</span>{" "}
                          <span className="text-rose-700">→ {c.expiryDate}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {o.compliant ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> OK</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700"><AlertTriangle className="w-3.5 h-3.5" /> Gap</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, highlight }: { icon: React.ReactNode; label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`border rounded p-4 bg-white ${highlight ? "border-amber-400" : ""}`}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        {icon}{label}
      </div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}
