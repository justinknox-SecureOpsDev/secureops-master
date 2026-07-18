import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardList, RefreshCw, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, fetchWithAuth } from "@/lib/api";

type Row = {
  id: string;
  reportDate: string;
  submittedAt: string;
  summary: string;
  visitorsCount: number;
  patrolsCount: number;
  employeeId: string;
  firstName: string | null;
  lastName: string | null;
  siteId: string | null;
  siteName: string | null;
};

type Detail = {
  dar: {
    id: string;
    reportDate: string;
    submittedAt: string;
    summary: string;
    observations: string | null;
    visitorsCount: number;
    patrolsCount: number;
    incidentsNoted: string | null;
    weather: string | null;
    signature: string | null;
  };
  siteName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  shiftTitle: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString();
}

export function DailyReportsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      qs.set("limit", "200");
      const data = await api<{ reports: Row[] }>(`/admin/dar?${qs.toString()}`);
      setRows(data.reports);
    } catch (e) { setError((e as Error).message); setRows([]); }
    finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    api<Detail>(`/admin/dar/${openId}`).then(setDetail).catch(() => setDetail(null));
  }, [openId]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.summary, r.siteName, r.firstName, r.lastName]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    );
  }, [rows, search]);

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="px-6 py-4 border-b bg-card">
        <h1 className="text-3xl brand-navy inline-flex items-center gap-2" style={{ fontFamily: "Georgia, serif", fontWeight: 700 }}>
          <ClipboardList className="w-6 h-6" /> Daily Activity Reports
        </h1>
        <div className="text-sm text-muted-foreground mt-1">
          End-of-shift summaries submitted by officers.
        </div>
      </div>

      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded px-2 py-1.5 text-sm bg-background" />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border rounded px-2 py-1.5 text-sm bg-background" />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-muted-foreground mb-1">Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="officer, site, or text…" className="w-full border rounded px-2 py-1.5 text-sm bg-background" />
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>

        {error && <div className="text-sm text-destructive">{error}</div>}

        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Submitted</th>
                <th className="text-left px-3 py-2 font-medium">Date</th>
                <th className="text-left px-3 py-2 font-medium">Officer</th>
                <th className="text-left px-3 py-2 font-medium">Site</th>
                <th className="text-left px-3 py-2 font-medium">Summary</th>
                <th className="text-right px-3 py-2 font-medium">V / P</th>
              </tr>
            </thead>
            <tbody>
              {!rows ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground text-sm">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground text-sm">No reports.</td></tr>
              ) : filtered.map((r) => (
                <tr key={r.id} className="border-t cursor-pointer hover:bg-muted/30" onClick={() => setOpenId(r.id)}>
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{fmtDate(r.submittedAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.reportDate}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{[r.firstName, r.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.siteName ?? "—"}</td>
                  <td className="px-3 py-2 max-w-[420px] truncate">{r.summary}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground whitespace-nowrap">{r.visitorsCount} / {r.patrolsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {openId && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setOpenId(null)}>
          <div className="bg-card border rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold">Daily Activity Report</div>
                {detail && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {[detail.firstName, detail.lastName].filter(Boolean).join(" ") || "Officer"} · {detail.siteName ?? "—"} · {detail.dar.reportDate}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => openId && downloadDarPdf(openId)}>
                  <Download className="w-3.5 h-3.5 mr-1" /> PDF
                </Button>
                <button onClick={() => setOpenId(null)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="p-5 space-y-4 text-sm">
              {!detail ? (
                <div className="text-muted-foreground">Loading…</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div><span className="text-muted-foreground">Visitors:</span> <span className="font-medium">{detail.dar.visitorsCount}</span></div>
                    <div><span className="text-muted-foreground">Patrols:</span> <span className="font-medium">{detail.dar.patrolsCount}</span></div>
                    {detail.dar.weather && <div className="col-span-2"><span className="text-muted-foreground">Weather:</span> {detail.dar.weather}</div>}
                    {detail.shiftTitle && (
                      <div className="col-span-2 text-muted-foreground">
                        Shift: {detail.shiftTitle}{detail.shiftStart ? ` · ${fmtDate(detail.shiftStart)}` : ""}
                      </div>
                    )}
                  </div>
                  <Section title="Summary">{detail.dar.summary}</Section>
                  {detail.dar.observations && <Section title="Observations">{detail.dar.observations}</Section>}
                  {detail.dar.incidentsNoted && <Section title="Incidents noted">{detail.dar.incidentsNoted}</Section>}
                  {detail.dar.signature && (
                    <div className="border-t pt-3 text-xs text-muted-foreground">
                      Signed: <span className="text-foreground font-medium">{detail.dar.signature}</span> · Submitted {fmtDate(detail.dar.submittedAt)}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

async function downloadDarPdf(id: string) {
  try {
    const res = await fetchWithAuth(`/api/dar/${id}/pdf`);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") ?? "";
    const m = /filename="?([^";]+)"?/i.exec(cd);
    const filename = m?.[1] ?? `wcsg-dar-${id.slice(0, 8)}.pdf`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert(`Could not download PDF: ${(e as Error).message}`);
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
      <div className="whitespace-pre-wrap">{children}</div>
    </div>
  );
}
