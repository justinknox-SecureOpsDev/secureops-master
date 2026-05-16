import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Loader2, AlertTriangle, Download, MapPin, Calendar, User, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

type PublicIncident = {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  locationDescription: string | null;
  lat: string | null;
  lng: string | null;
  occurredAt: string;
  resolvedAt: string | null;
  responderName: string | null;
  siteName: string | null;
  shiftTitle: string | null;
  attachments: { key: string; url: string }[];
  share: { expiresAt: string; viewCount: number };
};

const SEVERITY_TONE: Record<string, string> = {
  low: "bg-zinc-100 text-zinc-800 border-zinc-300",
  medium: "bg-amber-100 text-amber-900 border-amber-300",
  high: "bg-orange-100 text-orange-900 border-orange-300",
  critical: "bg-red-100 text-red-900 border-red-300",
};

// API base: this page is rendered under /admin-portal/share/incident/:token,
// so we hit `/api/...` relative to the proxy host.
const API = "/api";

export default function PublicIncidentPage() {
  const [, params] = useRoute<{ token: string }>("/share/incident/:token");
  const token = params?.token;

  const [data, setData] = useState<PublicIncident | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/public/incident-shares/${encodeURIComponent(token)}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (!cancelled) setData(body as PublicIncident);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-cream text-brand-navy">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-cream p-6">
        <div className="max-w-md w-full bg-white border rounded-xl p-6 text-center">
          <AlertTriangle className="w-8 h-8 mx-auto mb-3 text-amber-600" />
          <div className="text-lg font-semibold brand-navy mb-1">Link unavailable</div>
          <div className="text-sm text-muted-foreground">{error ?? "Unknown error"}</div>
          <div className="text-xs text-muted-foreground mt-4">
            If you received this link in error, please contact Williams Council Security Group.
          </div>
        </div>
      </div>
    );
  }

  const tone = SEVERITY_TONE[data.severity] ?? SEVERITY_TONE.low;

  return (
    <div className="min-h-screen bg-brand-cream">
      <div className="bg-brand-navy text-brand-cream">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center gap-3">
          <ShieldAlert className="w-5 h-5 brand-gold" />
          <div>
            <div className="brand-wordmark text-lg">Williams Council Security Group</div>
            <div className="text-xs opacity-70">Incident report — shared with you</div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto p-6">
        <div className="bg-white border rounded-xl p-6">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold brand-navy">{data.title}</h1>
              <div className="text-xs text-muted-foreground mt-1">
                Status: {data.status.replace(/_/g, " ")}
              </div>
            </div>
            <span className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-sm border ${tone}`}>
              {data.severity}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-5 text-sm">
            <Fact icon={<Calendar className="w-4 h-4" />} label="Occurred">
              {new Date(data.occurredAt).toLocaleString()}
            </Fact>
            {data.resolvedAt && (
              <Fact icon={<Calendar className="w-4 h-4" />} label="Resolved">
                {new Date(data.resolvedAt).toLocaleString()}
              </Fact>
            )}
            {(data.siteName || data.shiftTitle) && (
              <Fact icon={<MapPin className="w-4 h-4" />} label="Site / shift">
                {[data.siteName, data.shiftTitle].filter(Boolean).join(" — ") || "—"}
              </Fact>
            )}
            {data.locationDescription && (
              <Fact icon={<MapPin className="w-4 h-4" />} label="Location">
                {data.locationDescription}
              </Fact>
            )}
            {data.responderName && (
              <Fact icon={<User className="w-4 h-4" />} label="Responding officer">
                {data.responderName}
              </Fact>
            )}
          </div>

          <div className="mt-6">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Description</div>
            <div className="whitespace-pre-wrap text-sm leading-6 brand-navy">{data.description}</div>
          </div>

          {data.attachments.length > 0 && (
            <div className="mt-6">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Attachments</div>
              <ul className="space-y-1 text-sm">
                {data.attachments.map((a, i) => (
                  <li key={a.key}>
                    <a href={a.url} target="_blank" rel="noopener noreferrer"
                       className="text-blue-700 hover:underline inline-flex items-center gap-1">
                      <Download className="w-3 h-3" />Attachment {i + 1}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-8 pt-5 border-t flex flex-wrap gap-3 justify-between items-center">
            <Button asChild>
              <a href={`${API}/public/incident-shares/${encodeURIComponent(token!)}/pdf`}>
                <Download className="w-4 h-4 mr-2" />Download full PDF report
              </a>
            </Button>
            <div className="text-xs text-muted-foreground text-right">
              Link expires {new Date(data.share.expiresAt).toLocaleDateString()}<br />
              View #{data.share.viewCount}
            </div>
          </div>
        </div>

        <div className="text-center text-xs text-muted-foreground mt-6">
          This is a secure, time-limited link issued by Williams Council Security Group.
          Do not forward.
        </div>
      </div>
    </div>
  );
}

function Fact({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <div className="text-brand-gold mt-0.5">{icon}</div>
      <div>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="brand-navy">{children}</div>
      </div>
    </div>
  );
}
