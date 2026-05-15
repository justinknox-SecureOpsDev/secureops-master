import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { ClipboardList, Search, Loader2, Copy, ExternalLink, MailCheck, MessageSquareWarning } from "lucide-react";
import { openSignedObject } from "@/lib/upload";
import { AMENDMENT_FIELDS } from "@/lib/amendmentFields";

type ApplicationStatus = "submitted" | "under_review" | "info_requested" | "approved" | "rejected";

type Application = {
  id: string;
  status: ApplicationStatus;
  firstName: string; lastName: string; email: string; phone: string; address: string;
  dateOfBirth: string | null; cityOfBirth: string | null; stateOfBirth: string | null;
  niNumber: string | null; rightToWorkStatus: string | null; rightToWorkDocKey: string | null;
  siaLicenseNumber: string | null; siaLicenseLevel: number | null; siaLicenseExpiry: string | null;
  previousExperience: string | null; yearsExperience: number | null;
  references: { name: string; relationship: string; phone: string; email?: string }[] | null;
  photoKey: string | null; cvKey: string | null;
  trainingCertificateKeys: string[] | null;
  availability: { day: string; period: string }[] | null;
  reviewerNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdEmployeeId: string | null;
  createdAt: string;
};

type ApproveResp = {
  application: Application;
  onboardingUrl: string;
  onboardingToken: string;
  employeeId: string;
  tempPasswordHint: string;
  emailSent: boolean;
};

type RejectResp = Application & { emailSent: boolean };

const STATUSES = [
  { value: "", label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "under_review", label: "Under review" },
  { value: "info_requested", label: "Info requested" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

const STATUS_STYLES: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-900 border-blue-300",
  under_review: "bg-amber-100 text-amber-900 border-amber-300",
  info_requested: "bg-orange-100 text-orange-900 border-orange-300",
  approved: "bg-emerald-100 text-emerald-900 border-emerald-300",
  rejected: "bg-rose-100 text-rose-900 border-rose-300",
};

type RequestInfoResp = {
  application: Application;
  amendUrl: string;
  amendmentToken: string;
  requestedFields: string[];
  fieldLabels: string[];
  expiresAt: string;
  emailSent: boolean;
};

export function ApplicationsPage() {
  const [items, setItems] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApproveResp | null>(null);
  const [rejection, setRejection] = useState<RejectResp | null>(null);
  const [requestInfo, setRequestInfo] = useState<RequestInfoResp | null>(null);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (search) qs.set("search", search);
      const data = await api<Application[]>(`/admin/applications${qs.toString() ? `?${qs}` : ""}`);
      setItems(data);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [status]);

  const opened = useMemo(() => items.find((i) => i.id === openId) ?? null, [items, openId]);

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="brand-wordmark text-2xl flex items-center gap-2">
            <ClipboardList className="w-6 h-6 brand-gold" /> Applications
          </h1>
          <p className="text-sm text-muted-foreground">
            Review applications submitted from the public form at /apply.
          </p>
        </div>
        <a className="text-sm underline brand-navy" href={`${import.meta.env.BASE_URL}apply`} target="_blank" rel="noreferrer">
          Open public form ↗
        </a>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              onClick={() => setStatus(s.value)}
              className={`text-xs px-3 py-1.5 rounded border ${
                status === s.value ? "bg-brand-navy text-white border-brand-navy" : "bg-background hover:bg-accent/40"
              }`}
            >{s.label}</button>
          ))}
        </div>
        <form className="flex gap-2 ml-auto" onSubmit={(e) => { e.preventDefault(); refresh(); }}>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name / email / phone" className="w-64" />
          <Button type="submit" variant="outline"><Search className="w-4 h-4" /></Button>
        </form>
      </div>

      {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}

      <div className="bg-card rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2">Applicant</th>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Phone</th>
              <th className="text-left px-3 py-2">TX Lic</th>
              <th className="text-left px-3 py-2">Submitted</th>
              <th className="text-left px-3 py-2">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 inline-block animate-spin" /></td></tr>)}
            {!loading && items.length === 0 && (<tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">No applications.</td></tr>)}
            {items.map((a) => (
              <tr key={a.id} className="border-t hover:bg-accent/30">
                <td className="px-3 py-2 font-medium">{a.firstName} {a.lastName}</td>
                <td className="px-3 py-2">{a.email}</td>
                <td className="px-3 py-2">{a.phone}</td>
                <td className="px-3 py-2">{a.siaLicenseLevel ? `L${a.siaLicenseLevel}` : "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 text-[11px] uppercase rounded border ${STATUS_STYLES[a.status]}`}>
                    {a.status.replace("_", " ")}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="outline" onClick={() => setOpenId(a.id)}>Review</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {opened && (
        <ApplicationDialog
          app={opened}
          onClose={() => setOpenId(null)}
          onUpdated={(updated) => { setItems((arr) => arr.map((x) => x.id === updated.id ? updated : x)); }}
          onApproved={(resp) => {
            setItems((arr) => arr.map((x) => x.id === resp.application.id ? resp.application : x));
            setApproval(resp);
          }}
          onRejected={(resp) => {
            const { emailSent: _es, ...app } = resp;
            setItems((arr) => arr.map((x) => x.id === app.id ? (app as Application) : x));
            setRejection(resp);
          }}
          onInfoRequested={(resp) => {
            setItems((arr) => arr.map((x) => x.id === resp.application.id ? resp.application : x));
            setRequestInfo(resp);
          }}
        />
      )}
      {approval && (
        <ApprovalSuccessDialog resp={approval} onClose={() => setApproval(null)} />
      )}
      {rejection && (
        <RejectionResultDialog resp={rejection} onClose={() => setRejection(null)} />
      )}
      {requestInfo && (
        <RequestInfoResultDialog resp={requestInfo} onClose={() => setRequestInfo(null)} />
      )}
    </div>
  );
}

function ApplicationDialog({
  app, onClose, onUpdated, onApproved, onRejected, onInfoRequested,
}: {
  app: Application;
  onClose: () => void;
  onUpdated: (a: Application) => void;
  onApproved: (resp: ApproveResp) => void;
  onRejected: (resp: RejectResp) => void;
  onInfoRequested: (resp: RequestInfoResp) => void;
}) {
  const [notes, setNotes] = useState(app.reviewerNotes ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRequestInfo, setShowRequestInfo] = useState(false);

  async function action(kind: "review" | "reject" | "approve") {
    setBusy(kind); setError(null);
    try {
      if (kind === "approve") {
        const resp = await api<ApproveResp>(`/admin/applications/${app.id}/approve`, {
          method: "POST", body: { notes: notes || undefined },
        });
        onApproved(resp); onClose();
      } else if (kind === "reject") {
        const resp = await api<RejectResp>(`/admin/applications/${app.id}/reject`, {
          method: "POST", body: { notes: notes || undefined },
        });
        onRejected(resp); onClose();
      } else {
        const updated = await api<Application>(`/admin/applications/${app.id}/${kind}`, {
          method: "POST", body: { notes: notes || undefined },
        });
        onUpdated(updated);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="brand-wordmark text-xl">
            {app.firstName} {app.lastName}
            <span className={`ml-2 inline-block px-2 py-0.5 text-[11px] uppercase rounded border ${STATUS_STYLES[app.status]}`}>
              {app.status.replace("_", " ")}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <Info k="Email" v={app.email} />
          <Info k="Phone" v={app.phone} />
          <Info k="Address" v={app.address} />
          <Info k="Date of birth" v={app.dateOfBirth} />
          <Info k="City of birth" v={app.cityOfBirth} />
          <Info k="State of birth" v={app.stateOfBirth} />
          <Info k="SSN (last 4)" v={app.niNumber} />
          <Info k="Right to work" v={app.rightToWorkStatus} />
          <Info k="TX license #" v={app.siaLicenseNumber} />
          <Info k="License level" v={app.siaLicenseLevel ? `L${app.siaLicenseLevel}` : null} />
          <Info k="License expiry" v={app.siaLicenseExpiry} />
          <Info k="Years experience" v={app.yearsExperience?.toString() ?? null} />
        </div>
        {app.previousExperience && (
          <Section title="Previous experience"><p className="text-sm whitespace-pre-wrap">{app.previousExperience}</p></Section>
        )}
        {app.references && app.references.length > 0 && (
          <Section title="References">
            <ul className="text-sm space-y-1">
              {app.references.map((r, i) => (
                <li key={i}>• <strong>{r.name}</strong> ({r.relationship}) · {r.phone}{r.email ? ` · ${r.email}` : ""}</li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="Documents">
          <ul className="text-sm space-y-1">
            <FileLink k="Right-to-work" path={app.rightToWorkDocKey} />
            <FileLink k="Photo" path={app.photoKey} />
            <FileLink k="CV" path={app.cvKey} />
            {(app.trainingCertificateKeys ?? []).map((k, i) => (
              <FileLink key={i} k={`Certificate ${i + 1}`} path={k} />
            ))}
          </ul>
        </Section>
        {app.availability && app.availability.length > 0 && (
          <Section title="Availability">
            <p className="text-xs text-muted-foreground">{app.availability.length} slots selected</p>
          </Section>
        )}
        <Section title="Reviewer notes">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes (optional)" />
        </Section>
        {app.createdEmployeeId && (
          <div className="text-sm bg-emerald-50 border border-emerald-200 text-emerald-900 p-2 rounded">
            Approved — employee record created. Visit <strong>Onboarding</strong> to view their progress.
          </div>
        )}
        {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}
        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {app.status !== "approved" && app.status !== "rejected" && (
            <Button variant="outline" disabled={!!busy} onClick={() => action("review")}>
              {busy === "review" ? "…" : "Mark under review"}
            </Button>
          )}
          {app.status !== "approved" && app.status !== "rejected" && (
            <Button variant="outline" disabled={!!busy} onClick={() => setShowRequestInfo(true)}>
              <MessageSquareWarning className="w-4 h-4 mr-1" /> Request more info
            </Button>
          )}
          {app.status !== "approved" && (
            <Button variant="destructive" disabled={!!busy} onClick={() => action("reject")}>
              {busy === "reject" ? "…" : "Reject"}
            </Button>
          )}
          {app.status !== "approved" && (
            <Button className="bg-brand-navy hover:opacity-90 text-white" disabled={!!busy} onClick={() => action("approve")}>
              {busy === "approve" ? "Approving…" : "Approve & create employee"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {showRequestInfo && (
        <RequestInfoDialog
          app={app}
          onClose={() => setShowRequestInfo(false)}
          onSent={(resp) => { setShowRequestInfo(false); onInfoRequested(resp); onClose(); }}
        />
      )}
    </Dialog>
  );
}

function RequestInfoDialog({
  app, onClose, onSent,
}: {
  app: Application;
  onClose: () => void;
  onSent: (resp: RequestInfoResp) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function send() {
    if (selected.size === 0) { setError("Select at least one field."); return; }
    setBusy(true); setError(null);
    try {
      const resp = await api<RequestInfoResp>(`/admin/applications/${app.id}/request-info`, {
        method: "POST",
        body: { requestedFields: [...selected], note: note.trim() || undefined },
      });
      onSent(resp);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // Show whether each field already has a value, so the admin can see what's missing.
  function currentValueFor(key: string): string | null {
    const dbKey = (AMENDMENT_FIELDS.find((f) => f.key === key)?.dbKey) ?? key;
    const v = (app as unknown as Record<string, unknown>)[dbKey];
    if (v == null || v === "") return null;
    return String(v);
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="brand-wordmark text-xl flex items-center gap-2">
            <MessageSquareWarning className="w-5 h-5 brand-gold" />
            Request more info from {app.firstName}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Tick each item you need the applicant to (re-)submit. They'll get an email
            with a secure link to complete just those fields. The link expires in 14 days.
          </p>
          <div className="border rounded divide-y">
            {AMENDMENT_FIELDS.map((f) => {
              const current = currentValueFor(f.key);
              const isOn = selected.has(f.key);
              return (
                <label key={f.key} className="flex items-start gap-3 px-3 py-2 hover:bg-accent/30 cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={isOn} onChange={() => toggle(f.key)} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{f.label}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {current ? <>Current: <span className="text-foreground/80">{f.type === "file" ? "uploaded" : current}</span></> : <em className="text-rose-700">Currently empty</em>}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide opacity-70">Note to applicant (optional)</div>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Your right-to-work document was unreadable — please upload a clearer copy." />
          </div>
          {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button className="bg-brand-navy hover:opacity-90 text-white" onClick={send} disabled={busy || selected.size === 0}>
            {busy ? "Sending…" : `Send request (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestInfoResultDialog({ resp, onClose }: { resp: RequestInfoResp; onClose: () => void }) {
  function copy(text: string) { navigator.clipboard.writeText(text).catch(() => {}); }
  const fullName = `${resp.application.firstName} ${resp.application.lastName}`;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="brand-wordmark text-xl">Info request sent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {resp.emailSent ? (
            <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded">
              <MailCheck className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Email sent to {resp.application.email}</div>
                <div className="text-xs mt-0.5">
                  {fullName} has been asked to update {resp.fieldLabels.length} item{resp.fieldLabels.length === 1 ? "" : "s"}.
                  The link expires {new Date(resp.expiresAt).toLocaleDateString()}.
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded text-xs">
              Email delivery isn't configured — copy the link below and send it to <strong>{resp.application.email}</strong> manually.
            </div>
          )}
          <Field label="Requested items">
            <ul className="text-xs list-disc pl-5 space-y-0.5">
              {resp.fieldLabels.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </Field>
          <Field label="Secure link (single-use, expires 14 days)">
            <div className="flex gap-1">
              <Input readOnly value={resp.amendUrl} />
              <Button type="button" variant="outline" onClick={() => copy(resp.amendUrl)}><Copy className="w-4 h-4" /></Button>
              <a className="inline-flex items-center" href={resp.amendUrl} target="_blank" rel="noreferrer">
                <Button type="button" variant="outline"><ExternalLink className="w-4 h-4" /></Button>
              </a>
            </div>
          </Field>
        </div>
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalSuccessDialog({ resp, onClose }: { resp: ApproveResp; onClose: () => void }) {
  function copy(text: string) { navigator.clipboard.writeText(text).catch(() => {}); }
  const fullName = `${resp.application.firstName} ${resp.application.lastName}`;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="brand-wordmark text-xl">Application approved</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {resp.emailSent ? (
            <>
              <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded">
                <MailCheck className="w-5 h-5 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">Onboarding email sent to {resp.application.email}</div>
                  <div className="text-xs mt-0.5">
                    Employee <strong>{fullName}</strong> has been created and emailed their onboarding link plus
                    temporary login. The link expires in 14 days and can be used once.
                  </div>
                </div>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Show link &amp; temporary password (for backup)
                </summary>
                <div className="mt-2 space-y-2">
                  <Field label="Onboarding link">
                    <div className="flex gap-1">
                      <Input readOnly value={resp.onboardingUrl} />
                      <Button type="button" variant="outline" onClick={() => copy(resp.onboardingUrl)}><Copy className="w-4 h-4" /></Button>
                      <a className="inline-flex items-center" href={resp.onboardingUrl} target="_blank" rel="noreferrer">
                        <Button type="button" variant="outline"><ExternalLink className="w-4 h-4" /></Button>
                      </a>
                    </div>
                  </Field>
                  <Field label="Temporary password">
                    <Input readOnly value="Last 4 of SSN" />
                    <p className="text-xs text-muted-foreground">
                      Use the last 4 digits of the SSN provided on the application. The employee will be prompted to set a new password on first login.
                    </p>
                  </Field>
                </div>
              </details>
            </>
          ) : (
            <>
              <p>
                Employee <strong>{fullName}</strong> has been created.
                Share the onboarding link below — it expires in 14 days and can be used once.
              </p>
              <Field label="Onboarding link">
                <div className="flex gap-1">
                  <Input readOnly value={resp.onboardingUrl} />
                  <Button type="button" variant="outline" onClick={() => copy(resp.onboardingUrl)}><Copy className="w-4 h-4" /></Button>
                  <a className="inline-flex items-center" href={resp.onboardingUrl} target="_blank" rel="noreferrer">
                    <Button type="button" variant="outline"><ExternalLink className="w-4 h-4" /></Button>
                  </a>
                </div>
              </Field>
              <Field label="Temporary password (for SecureOps mobile app)">
                <Input readOnly value="Last 4 of SSN" />
                <p className="text-xs text-muted-foreground">
                  Email login: <strong>{resp.application.email}</strong>. Use the last 4 digits of the SSN provided on the application — the employee will be prompted to set a new password on first login.
                </p>
              </Field>
              <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 p-2 rounded">
                Email delivery isn't configured — copy and send the link manually.
                Set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code>
                {" "}(and optionally <code>SMTP_FROM</code>) to enable automatic emails.
              </div>
            </>
          )}
        </div>
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
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
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
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

function RejectionResultDialog({ resp, onClose }: { resp: RejectResp; onClose: () => void }) {
  const fullName = `${resp.firstName} ${resp.lastName}`;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="brand-wordmark text-xl">Application rejected</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {resp.emailSent ? (
            <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded">
              <MailCheck className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Rejection email sent to {resp.email}</div>
                <div className="text-xs mt-0.5">
                  {fullName} has been notified that their application won't be moving forward.
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded">
              <div className="font-medium">{fullName} marked as rejected</div>
              <div className="text-xs mt-1">
                No email was sent — SMTP isn't configured. Set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>,
                <code> SMTP_USER</code>, <code>SMTP_PASS</code> (and optionally <code>SMTP_FROM</code>) to send
                rejection emails automatically. You may want to follow up with the applicant manually.
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
