import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Loader2, AlertTriangle, Download, ShieldCheck, BadgeCheck, Calendar, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

type VisibleSections = {
  license: boolean;
  experience: boolean;
  skills: boolean;
  uniform: boolean;
  trainingCerts: boolean;
  documents: boolean;
};

type DocEntry = { label: string; filename: string | null };

type PublicProfile = {
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  licenseNumber: string | null;
  licenseLevel: number | null;
  licenseExpiry: string | null;
  yearsExperience: number | null;
  previousExperience: string | null;
  rightToWorkStatus: string | null;
  skills: string[];
  uniform: {
    shirt: string | null;
    trousers: string | null;
    jacket: string | null;
    boots: string | null;
  };
  documents?: DocEntry[];
  trainingCertificates?: DocEntry[];
  visibleSections?: VisibleSections;
  share: { expiresAt: string; viewCount: number };
};

const API = "/api";

export default function PublicEmployeeProfilePage() {
  const [, params] = useRoute<{ token: string }>("/share/employee/:token");
  const token = params?.token;

  const [data, setData] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/public/employee-shares/${encodeURIComponent(token)}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (!cancelled) setData(body as PublicProfile);
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

  const fullName = `${data.firstName ?? ""} ${data.lastName ?? ""}`.trim() || "Officer";
  // Server already nulls out fields when a section is hidden; treat
  // legacy responses (no visibleSections key) as "everything visible".
  const sec: VisibleSections = data.visibleSections ?? {
    license: true, experience: true, skills: true,
    uniform: true, trainingCerts: true, documents: true,
  };
  const uniformFields = sec.uniform ? ([
    ["Shirt", data.uniform.shirt],
    ["Trousers", data.uniform.trousers],
    ["Jacket", data.uniform.jacket],
    ["Boots", data.uniform.boots],
  ].filter(([, v]) => !!v) as [string, string][]) : [];
  const documents = (data.documents ?? []).filter((d) => !!d.filename);
  const trainingCerts = (data.trainingCertificates ?? []).filter((d) => !!d.filename);

  return (
    <div className="min-h-screen bg-brand-cream">
      <div className="bg-brand-navy text-brand-cream">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 brand-gold" />
          <div>
            <div className="brand-wordmark text-lg">Williams Council Security Group</div>
            <div className="text-xs opacity-70">Officer profile — shared with you</div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto p-6">
        <div className="bg-white border rounded-xl p-6">
          <div className="flex items-start gap-5 flex-wrap">
            {data.photoUrl ? (
              <img
                src={data.photoUrl}
                alt={fullName}
                className="w-28 h-32 object-cover rounded-md border-2 border-brand-gold"
              />
            ) : (
              <div className="w-28 h-32 rounded-md border-2 border-dashed border-brand-gold/50 flex items-center justify-center text-xs text-muted-foreground">
                No photo
              </div>
            )}
            <div className="flex-1 min-w-[200px]">
              <h1 className="text-2xl font-bold brand-navy">{fullName}</h1>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mt-1">
                Security Officer
              </div>
              {data.licenseLevel != null && (
                <div className="mt-3 inline-flex items-center gap-2 text-sm bg-brand-cream border border-brand-gold/40 rounded-md px-3 py-1.5 brand-navy">
                  <BadgeCheck className="w-4 h-4 brand-gold" />
                  TX License L{data.licenseLevel}
                  {data.licenseNumber && <span className="text-muted-foreground">· #{data.licenseNumber}</span>}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6 text-sm">
            {data.licenseExpiry && (
              <Fact icon={<Calendar className="w-4 h-4" />} label="License expires">
                {new Date(data.licenseExpiry).toLocaleDateString()}
              </Fact>
            )}
            {data.yearsExperience != null && (
              <Fact icon={<ShieldCheck className="w-4 h-4" />} label="Experience">
                {data.yearsExperience} year{data.yearsExperience === 1 ? "" : "s"}
              </Fact>
            )}
            {data.rightToWorkStatus && (
              <Fact icon={<BadgeCheck className="w-4 h-4" />} label="Right to work">
                {data.rightToWorkStatus}
              </Fact>
            )}
          </div>

          {data.previousExperience && (
            <div className="mt-6">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Background</div>
              <div className="whitespace-pre-wrap text-sm leading-6 brand-navy">{data.previousExperience}</div>
            </div>
          )}

          {data.skills.length > 0 && (
            <div className="mt-6">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Skills & qualifications</div>
              <div className="flex flex-wrap gap-2">
                {data.skills.map((s) => (
                  <span key={s} className="text-xs bg-brand-navy/5 brand-navy border rounded-full px-2.5 py-1">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {uniformFields.length > 0 && (
            <div className="mt-6">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Uniform sizes</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                {uniformFields.map(([k, v]) => (
                  <div key={k}>
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{k}</div>
                    <div className="brand-navy">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {documents.length > 0 && (
            <div className="mt-6">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Documents on file</div>
              <ul className="text-sm space-y-1">
                {documents.map((d) => (
                  <li key={d.label} className="flex items-center gap-2 brand-navy">
                    <FileText className="w-3.5 h-3.5 text-brand-gold flex-shrink-0" />
                    <span className="text-muted-foreground">{d.label}:</span>
                    <span className="truncate">{d.filename}</span>
                  </li>
                ))}
              </ul>
              <div className="text-[11px] text-muted-foreground mt-1">
                Originals are kept securely with HR — names shown for reference only.
              </div>
            </div>
          )}

          {trainingCerts.length > 0 && (
            <div className="mt-6">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Training certificates</div>
              <ul className="text-sm space-y-1">
                {trainingCerts.map((d) => (
                  <li key={d.label} className="flex items-center gap-2 brand-navy">
                    <FileText className="w-3.5 h-3.5 text-brand-gold flex-shrink-0" />
                    <span className="text-muted-foreground">{d.label}:</span>
                    <span className="truncate">{d.filename}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-8 pt-5 border-t flex flex-wrap gap-3 justify-between items-center">
            <Button asChild>
              <a href={`${API}/public/employee-shares/${encodeURIComponent(token!)}/pdf`}>
                <Download className="w-4 h-4 mr-2" />Download profile PDF
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
          Bank account, SSN and other sensitive details are intentionally not shown. Do not forward.
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
