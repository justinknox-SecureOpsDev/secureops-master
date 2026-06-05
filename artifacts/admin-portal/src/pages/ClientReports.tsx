import { useEffect, useState } from "react";
import { FileText, AlertTriangle, ClipboardList, Download, ChevronDown, ChevronUp } from "lucide-react";
import { api, fetchWithAuth } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Incident = {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  locationDescription: string | null;
  occurredAt: string;
  resolvedAt: string | null;
  siteName: string | null;
};

type DAR = {
  id: string;
  reportDate: string;
  submittedAt: string;
  summary: string;
  observations: string | null;
  visitorsCount: number;
  patrolsCount: number;
  incidentsNoted: string | null;
  weather: string | null;
  siteId: string | null;
  siteName: string | null;
};

function fmt(d: string) {
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-blue-100 text-blue-700",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-red-700",
};

function IncidentCard({ inc }: { inc: Incident }) {
  const [expanded, setExpanded] = useState(false);
  const base = (window as any).__BASE_URL__ as string | undefined ?? "/admin-portal";

  async function downloadPdf() {
    const url = `/api/client/incidents/${inc.id}/pdf`;
    const res = await fetchWithAuth(url);
    if (!res.ok) { alert("PDF not available."); return; }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `incident-${inc.id}.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((x) => !x)}
      >
        <AlertTriangle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{inc.title}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${SEVERITY_COLORS[inc.severity] ?? "bg-gray-100 text-gray-500"}`}>
              {inc.severity}
            </span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 uppercase tracking-wide">
              {inc.status}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex gap-x-3 flex-wrap">
            <span>{fmt(inc.occurredAt)}</span>
            {inc.siteName && <span>· {inc.siteName}</span>}
            {inc.locationDescription && <span>· {inc.locationDescription}</span>}
          </div>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </div>

      {expanded && (
        <div className="border-t px-4 py-3 bg-muted/20 space-y-2">
          <p className="text-sm">{inc.description}</p>
          {inc.resolvedAt && (
            <p className="text-xs text-muted-foreground">Resolved: {fmt(inc.resolvedAt)}</p>
          )}
          <Button size="sm" variant="outline" className="gap-1 mt-2" onClick={downloadPdf}>
            <Download className="w-3.5 h-3.5" /> Download PDF report
          </Button>
        </div>
      )}
    </div>
  );
}

function DarCard({ dar }: { dar: DAR }) {
  const [expanded, setExpanded] = useState(false);

  async function downloadPdf() {
    const res = await fetchWithAuth(`/api/client/dar/${dar.id}/pdf`);
    if (!res.ok) { alert("PDF not available."); return; }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dar-${dar.id}.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((x) => !x)}
      >
        <ClipboardList className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{fmtDate(dar.reportDate)}</div>
          <div className="text-xs text-muted-foreground mt-0.5 flex gap-x-3 flex-wrap">
            {dar.siteName && <span>{dar.siteName}</span>}
            <span>{dar.patrolsCount} patrol{dar.patrolsCount !== 1 ? "s" : ""}</span>
            <span>{dar.visitorsCount} visitor{dar.visitorsCount !== 1 ? "s" : ""}</span>
          </div>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </div>
      {expanded && (
        <div className="border-t px-4 py-3 bg-muted/20 space-y-2 text-sm">
          <p>{dar.summary}</p>
          {dar.observations && <p className="text-muted-foreground">{dar.observations}</p>}
          {dar.incidentsNoted && (
            <div className="text-xs border-t pt-2">
              <strong>Incidents noted:</strong> {dar.incidentsNoted}
            </div>
          )}
          {dar.weather && (
            <div className="text-xs text-muted-foreground">Weather: {dar.weather}</div>
          )}
          <Button size="sm" variant="outline" className="gap-1 mt-2" onClick={(e) => { e.stopPropagation(); void downloadPdf(); }}>
            <Download className="w-3.5 h-3.5" /> Download PDF report
          </Button>
        </div>
      )}
    </div>
  );
}

type Tab = "incidents" | "dar";

export default function ClientReports() {
  const [tab, setTab] = useState<Tab>("incidents");
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [dars, setDars] = useState<DAR[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api<Incident[]>("/client/incidents"),
      api<{ reports: DAR[] }>("/client/dar"),
    ])
      .then(([inc, darRes]) => {
        setIncidents(inc);
        setDars(darRes.reports);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-xl font-bold flex items-center gap-2 mb-6">
        <FileText className="w-5 h-5" /> Reports
      </h1>

      {/* Tab switcher */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab("incidents")}
          className={`px-4 py-2 rounded text-sm font-medium border transition-colors ${tab === "incidents" ? "bg-foreground text-background" : "hover:bg-muted"}`}
        >
          Incident Reports ({incidents.length})
        </button>
        <button
          onClick={() => setTab("dar")}
          className={`px-4 py-2 rounded text-sm font-medium border transition-colors ${tab === "dar" ? "bg-foreground text-background" : "hover:bg-muted"}`}
        >
          Daily Activity Reports ({dars.length})
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Loading reports…</div>
      ) : tab === "incidents" ? (
        incidents.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <AlertTriangle className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No incidents at your sites.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {incidents.map((i) => <IncidentCard key={i.id} inc={i} />)}
          </div>
        )
      ) : (
        dars.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No daily activity reports at your sites yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {dars.map((d) => <DarCard key={d.id} dar={d} />)}
          </div>
        )
      )}
    </div>
  );
}
