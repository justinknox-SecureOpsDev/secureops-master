import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { UserPlus, Loader2, Copy, ExternalLink } from "lucide-react";
import { openSignedObject } from "@/lib/upload";

type Item = {
  employeeId: string;
  firstName: string; lastName: string; email: string;
  status: "pending" | "completed";
  tokenExpiresAt: string | null;
  submittedAt: string | null;
  applicationId: string | null;
};

type Detail = Item & {
  submission: null | {
    id: string;
    bankSortCode: string; bankAccountNumber: string; bankAccountName: string;
    niNumberConfirmed: string | null; taxCode: string | null; p45DocKey: string | null;
    emergencyContactName: string; emergencyContactRelationship: string | null; emergencyContactPhone: string;
    uniformShirt: string | null; uniformTrousers: string | null; uniformJacket: string | null; uniformBoots: string | null;
    siaLicenseDocKey: string | null; passportDocKey: string | null;
    directDepositConsent: boolean; directDepositSignature: string;
    acknowledgements: { type: string; accepted: boolean; signature: string; timestamp: string }[];
    submittedAt: string;
  };
};

type ResendResp = { onboardingUrl: string; onboardingToken: string; emailSent: boolean };

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900 border-amber-300",
  completed: "bg-emerald-100 text-emerald-900 border-emerald-300",
};

export function OnboardingPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [resend, setResend] = useState<ResendResp | null>(null);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const qs = status ? `?status=${status}` : "";
      const data = await api<Item[]>(`/admin/onboarding${qs}`);
      setItems(data);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [status]);

  const opened = useMemo(() => items.find((i) => i.employeeId === openId) ?? null, [items, openId]);

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      <header>
        <h1 className="brand-wordmark text-2xl flex items-center gap-2">
          <UserPlus className="w-6 h-6 brand-gold" /> Onboarding
        </h1>
        <p className="text-sm text-muted-foreground">
          Track approved employees through onboarding. Resend links if needed.
        </p>
      </header>
      <div className="flex items-center gap-1">
        {[{v:"",l:"All"},{v:"pending",l:"Pending"},{v:"completed",l:"Completed"}].map((s) => (
          <button key={s.v} onClick={() => setStatus(s.v)}
            className={`text-xs px-3 py-1.5 rounded border ${
              status === s.v ? "bg-brand-navy text-white border-brand-navy" : "bg-background hover:bg-accent/40"
            }`}>{s.l}</button>
        ))}
      </div>
      {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}
      <div className="bg-card rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">Employee</th>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Token expires</th>
              <th className="text-left px-3 py-2">Submitted</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 inline-block animate-spin" /></td></tr>)}
            {!loading && items.length === 0 && (<tr><td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">No onboarding records yet.</td></tr>)}
            {items.map((i) => (
              <tr key={i.employeeId} className="border-t hover:bg-accent/30">
                <td className="px-3 py-2 font-medium">{i.firstName} {i.lastName}</td>
                <td className="px-3 py-2">{i.email}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 text-[11px] uppercase rounded border ${STATUS_STYLES[i.status]}`}>{i.status}</span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{i.tokenExpiresAt ? new Date(i.tokenExpiresAt).toLocaleString() : "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">{i.submittedAt ? new Date(i.submittedAt).toLocaleString() : "—"}</td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="outline" onClick={() => setOpenId(i.employeeId)}>View</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {opened && (
        <DetailDialog
          employeeId={opened.employeeId}
          onClose={() => setOpenId(null)}
          onResent={(r) => setResend(r)}
        />
      )}
      {resend && (
        <Dialog open onOpenChange={(o) => { if (!o) setResend(null); }}>
          <DialogContent className="max-w-xl">
            <DialogHeader><DialogTitle className="brand-wordmark text-xl">New onboarding link</DialogTitle></DialogHeader>
            <div className="space-y-2 text-sm">
              <p>Share this link with the employee. Previous links are invalidated.</p>
              <div className="flex gap-1">
                <Input readOnly value={resend.onboardingUrl} />
                <Button variant="outline" onClick={() => navigator.clipboard.writeText(resend.onboardingUrl)}><Copy className="w-4 h-4" /></Button>
                <a href={resend.onboardingUrl} target="_blank" rel="noreferrer"><Button variant="outline"><ExternalLink className="w-4 h-4" /></Button></a>
              </div>
              {!resend.emailSent && (
                <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 p-2 rounded">
                  Email delivery isn't configured — copy and send the link manually.
                </div>
              )}
            </div>
            <DialogFooter><Button onClick={() => setResend(null)}>Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function DetailDialog({
  employeeId, onClose, onResent,
}: {
  employeeId: string;
  onClose: () => void;
  onResent: (r: ResendResp) => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Detail>(`/admin/onboarding/${employeeId}`).then(setD).catch((e) => setError((e as Error).message));
  }, [employeeId]);

  async function resend() {
    setBusy(true); setError(null);
    try {
      const r = await api<ResendResp>(`/admin/onboarding/${employeeId}/resend`, { method: "POST" });
      onResent(r); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="brand-wordmark text-xl">
            {d ? `${d.firstName} ${d.lastName}` : "Loading…"}
            {d && (
              <span className={`ml-2 inline-block px-2 py-0.5 text-[11px] uppercase rounded border ${STATUS_STYLES[d.status]}`}>{d.status}</span>
            )}
          </DialogTitle>
        </DialogHeader>
        {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}
        {!d ? <Loader2 className="w-5 h-5 animate-spin" /> : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-4">
              <Info k="Email" v={d.email} />
              <Info k="Token expires" v={d.tokenExpiresAt ? new Date(d.tokenExpiresAt).toLocaleString() : null} />
            </div>
            {!d.submission && (
              <div className="text-sm bg-amber-50 border border-amber-200 text-amber-900 p-2 rounded">
                Employee hasn't completed onboarding yet.
              </div>
            )}
            {d.submission && (
              <>
                <Section title="Bank & tax">
                  <div className="grid grid-cols-2 gap-4">
                    <Info k="Sort code" v={d.submission.bankSortCode} />
                    <Info k="Account number" v={d.submission.bankAccountNumber} />
                    <Info k="Account name" v={d.submission.bankAccountName} />
                    <Info k="NI" v={d.submission.niNumberConfirmed} />
                    <Info k="Tax code" v={d.submission.taxCode} />
                  </div>
                </Section>
                <Section title="Emergency contact">
                  <div className="grid grid-cols-2 gap-4">
                    <Info k="Name" v={d.submission.emergencyContactName} />
                    <Info k="Relationship" v={d.submission.emergencyContactRelationship} />
                    <Info k="Phone" v={d.submission.emergencyContactPhone} />
                  </div>
                </Section>
                <Section title="Uniform sizes">
                  <div className="grid grid-cols-4 gap-4">
                    <Info k="Shirt" v={d.submission.uniformShirt} />
                    <Info k="Trousers" v={d.submission.uniformTrousers} />
                    <Info k="Jacket" v={d.submission.uniformJacket} />
                    <Info k="Boots" v={d.submission.uniformBoots} />
                  </div>
                </Section>
                <Section title="Documents">
                  <ul className="space-y-1">
                    <FileLink k="P45" path={d.submission.p45DocKey} />
                    <FileLink k="SIA licence" path={d.submission.siaLicenseDocKey} />
                    <FileLink k="Passport" path={d.submission.passportDocKey} />
                  </ul>
                </Section>
                <Section title="Consent & acknowledgements">
                  <ul className="space-y-1">
                    <li>
                      Direct deposit: {d.submission.directDepositConsent ? "✓" : "✗"} —
                      signed “{d.submission.directDepositSignature}”
                    </li>
                    {d.submission.acknowledgements.map((a, i) => (
                      <li key={i}>
                        {a.accepted ? "✓" : "✗"} <strong>{a.type}</strong> — “{a.signature}” at {new Date(a.timestamp).toLocaleString()}
                      </li>
                    ))}
                  </ul>
                </Section>
              </>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={resend} disabled={busy} className="bg-brand-navy hover:opacity-90 text-white">
            {busy ? "Generating…" : "Resend onboarding link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Info({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide opacity-70">{k}</dt>
      <dd className="font-medium">{v || "—"}</dd>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs uppercase tracking-wide opacity-70">{title}</h3>
      {children}
    </div>
  );
}
function FileLink({ k, path }: { k: string; path: string | null }) {
  if (!path) return null;
  return (
    <li>
      <span className="opacity-70">{k}:</span>{" "}
      <button type="button" className="underline brand-navy" onClick={() => openSignedObject(path)}>view</button>
    </li>
  );
}
