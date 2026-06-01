import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { ClipboardList, Search, Loader2, Copy, ExternalLink, MailCheck, MailWarning, MailX, MessageSquare, MessageSquareWarning } from "lucide-react";
import { openSignedObject } from "@/lib/upload";
import { AMENDMENT_FIELDS } from "@/lib/amendmentFields";

type ApplicationStatus = "submitted" | "under_review" | "info_requested" | "approved" | "rejected";

type Application = {
  id: string;
  status: ApplicationStatus;
  firstName: string; lastName: string; email: string; phone: string; address: string;
  city: string | null; state: string | null; zip: string | null;
  locationLat: number | null; locationLng: number | null;
  distanceMiles: number | null;
  dateOfBirth: string | null; cityOfBirth: string | null; stateOfBirth: string | null;
  niNumber: string | null; rightToWorkStatus: string | null; rightToWorkDocKey: string | null;
  i9DocKey: string | null; ssnCardDocKey: string | null;
  idDocType: "drivers_license" | "passport" | null; idDocKey: string | null;
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
  onboardingEmailStatus: "not_configured" | "sent" | "bounced" | "failed" | null;
  onboardingEmailMessageId: string | null;
  onboardingEmailResponse: string | null;
  onboardingEmailError: string | null;
  onboardingEmailSentAt: string | null;
  onboardingEmailAttemptedAt: string | null;
  createdAt: string;
};

type DeliveryBadge = {
  label: string;
  className: string;
  Icon: typeof MailCheck;
  tooltip: string;
};

function deliveryBadge(a: Application): DeliveryBadge | null {
  if (a.status !== "approved") return null;
  const s = a.onboardingEmailStatus;
  if (s === "sent") {
    return {
      label: "Delivered",
      className: "bg-emerald-100 text-emerald-900 border-emerald-300",
      Icon: MailCheck,
      tooltip: a.onboardingEmailSentAt
        ? `SMTP accepted ${new Date(a.onboardingEmailSentAt).toLocaleString()}`
        : "SMTP accepted",
    };
  }
  if (s === "bounced") {
    return {
      label: "Bounced",
      className: "bg-rose-100 text-rose-900 border-rose-400",
      Icon: MailX,
      tooltip: a.onboardingEmailError ?? "Recipient rejected by mail server",
    };
  }
  if (s === "failed") {
    return {
      label: "Failed",
      className: "bg-rose-100 text-rose-900 border-rose-400",
      Icon: MailX,
      tooltip: a.onboardingEmailError ?? "SMTP transport error",
    };
  }
  if (s === "not_configured") {
    return {
      label: "No SMTP",
      className: "bg-amber-100 text-amber-900 border-amber-300",
      Icon: MailWarning,
      tooltip: "SMTP isn't configured — admin must share link manually",
    };
  }
  return {
    label: "Unknown",
    className: "bg-muted text-foreground border-muted-foreground/30",
    Icon: MailWarning,
    tooltip: "No delivery status recorded yet",
  };
}

type ApproveResp = {
  application: Application;
  onboardingUrl: string;
  onboardingToken: string;
  employeeId: string;
  tempPassword: string;
  emailSent: boolean;
  smsStatus: "sent" | "skipped" | "failed";
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
  const [cityFilter, setCityFilter] = useState("");
  const [nearSiteId, setNearSiteId] = useState("");
  const [maxMiles, setMaxMiles] = useState("25");
  const [sites, setSites] = useState<{ id: string; name: string; locationLat: string | null; locationLng: string | null }[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApproveResp | null>(null);
  const [rejection, setRejection] = useState<RejectResp | null>(null);
  const [requestInfo, setRequestInfo] = useState<RequestInfoResp | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBatch, setShowBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [geoBackfillBusy, setGeoBackfillBusy] = useState(false);
  const [geoBackfillResult, setGeoBackfillResult] = useState<string | null>(null);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (search) qs.set("search", search);
      if (cityFilter.trim()) qs.set("city", cityFilter.trim());
      if (nearSiteId && maxMiles) {
        qs.set("nearSiteId", nearSiteId);
        qs.set("maxMiles", maxMiles);
      }
      const data = await api<Application[]>(`/admin/applications${qs.toString() ? `?${qs}` : ""}`);
      setItems(data);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [status, nearSiteId, maxMiles]);
  useEffect(() => {
    // /admin/tables/:table returns { rows, total, limit, offset }, not a bare array.
    api<{ rows: { id: string; name: string; locationLat: string | null; locationLng: string | null }[] }>(
      "/admin/tables/sites?limit=500"
    )
      .then((resp) => setSites((resp.rows ?? []).map((r) => ({
        id: r.id, name: r.name, locationLat: r.locationLat, locationLng: r.locationLng,
      }))))
      .catch(() => { /* sites list is optional; distance filter just won't appear */ });
  }, []);
  const distanceActive = !!nearSiteId && !!maxMiles;

  const opened = useMemo(() => items.find((i) => i.id === openId) ?? null, [items, openId]);

  const eligible = useMemo(
    () => items.filter((a) => a.status !== "approved" && a.status !== "rejected"),
    [items],
  );
  const selectedItems = useMemo(
    () => eligible.filter((a) => selected.has(a.id)),
    [eligible, selected],
  );
  // Drop selections that are no longer eligible (e.g. after approve/reject in dialog).
  useEffect(() => {
    setSelected((prev) => {
      const eligibleIds = new Set(eligible.map((a) => a.id));
      const next = new Set<string>();
      prev.forEach((id) => { if (eligibleIds.has(id)) next.add(id); });
      return next.size === prev.size ? prev : next;
    });
  }, [eligible]);

  function toggleRow(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === eligible.length && eligible.length > 0) return new Set();
      return new Set(eligible.map((a) => a.id));
    });
  }
  const allSelected = eligible.length > 0 && selected.size === eligible.length;

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
        <div className="flex items-center gap-1" role="group" aria-label="Filter by status">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setStatus(s.value)}
              aria-pressed={status === s.value}
              className={`text-xs px-3 py-1.5 rounded border ${
                status === s.value ? "bg-brand-navy text-white border-brand-navy" : "bg-background hover:bg-accent/40"
              }`}
            >{s.label}</button>
          ))}
        </div>
        <form className="flex gap-2 ml-auto" onSubmit={(e) => { e.preventDefault(); refresh(); }}>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name / email / phone / city" className="w-64" />
          <Button type="submit" variant="outline" aria-label="Search applications"><Search className="w-4 h-4" /></Button>
        </form>
      </div>

      <div className="flex flex-wrap items-end gap-3 bg-muted/40 border rounded-md p-3">
        <div className="flex flex-col">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">City contains</label>
          <form onSubmit={(e) => { e.preventDefault(); refresh(); }}>
            <Input
              value={cityFilter}
              onChange={(e) => setCityFilter(e.target.value)}
              placeholder="e.g. Dallas"
              className="w-48"
            />
          </form>
        </div>
        <div className="flex flex-col">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Within distance of site</label>
          <select
            aria-label="Within distance of site"
            value={nearSiteId}
            onChange={(e) => setNearSiteId(e.target.value)}
            className="h-9 px-2 rounded border bg-background text-sm w-64"
          >
            <option value="">— Any location —</option>
            {sites
              .filter((s) => s.locationLat != null && s.locationLng != null)
              .map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Max miles</label>
          <select
            aria-label="Maximum miles from site"
            value={maxMiles}
            onChange={(e) => setMaxMiles(e.target.value)}
            disabled={!nearSiteId}
            className="h-9 px-2 rounded border bg-background text-sm w-28 disabled:opacity-50"
          >
            {[5, 10, 15, 25, 50, 100, 200].map((n) => (
              <option key={n} value={String(n)}>{n} mi</option>
            ))}
          </select>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setCityFilter(""); setNearSiteId(""); setMaxMiles("25"); refresh(); }}
          disabled={!cityFilter && !nearSiteId}
        >
          Clear
        </Button>
        <Button variant="default" size="sm" onClick={() => refresh()}>Apply</Button>
        <Button
          variant="outline"
          size="sm"
          disabled={geoBackfillBusy}
          onClick={async () => {
            setGeoBackfillBusy(true);
            setGeoBackfillResult(null);
            try {
              const r = await api<{ candidates: number; resolved: number; unresolved: number }>(
                "/admin/applications/geocode-missing",
                { method: "POST" },
              );
              setGeoBackfillResult(
                r.candidates === 0
                  ? "All applicant addresses already have coordinates on file."
                  : `Geocoded ${r.resolved} of ${r.candidates} applicants (${r.unresolved} unresolved). Re-apply your filter.`,
              );
              await refresh();
            } catch (e) {
              setGeoBackfillResult((e as Error).message);
            } finally {
              setGeoBackfillBusy(false);
            }
          }}
          title="Look up coordinates for applicants whose home address has never been geocoded. Required for the distance filter."
        >
          {geoBackfillBusy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
          Geocode applicant addresses
        </Button>
        {distanceActive && (
          <div className="text-xs text-muted-foreground ml-auto">
            Showing applicants within {maxMiles} mi of the selected site. Applicants without a geocoded address are hidden — click "Geocode applicant addresses" to backfill.
          </div>
        )}
      </div>
      {geoBackfillResult && (
        <div className="text-xs px-3 py-2 rounded border bg-muted/30">{geoBackfillResult}</div>
      )}

      {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}

      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-brand-navy text-white px-4 py-2 rounded shadow">
          <span className="text-sm">
            <strong>{selected.size}</strong> selected
          </span>
          <Button size="sm" variant="secondary" className="ml-auto"
            onClick={() => setShowBatch(true)}>
            <MessageSquareWarning className="w-4 h-4 mr-1" /> Request more info from {selected.size}
          </Button>
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/10"
            onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <div className="bg-card rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                  onChange={toggleAll}
                  disabled={eligible.length === 0}
                />
              </th>
              <th className="text-left px-3 py-2">Applicant</th>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Phone</th>
              <th className="text-left px-3 py-2">City</th>
              {distanceActive && <th className="text-left px-3 py-2">Distance</th>}
              <th className="text-left px-3 py-2">TX Lic</th>
              <th className="text-left px-3 py-2">Submitted</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Onboarding email</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={distanceActive ? 11 : 10} className="px-3 py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 inline-block animate-spin" /></td></tr>)}
            {!loading && items.length === 0 && (<tr><td colSpan={distanceActive ? 11 : 10} className="px-3 py-10 text-center text-muted-foreground">No applications.</td></tr>)}
            {items.map((a) => {
              const isEligible = a.status !== "approved" && a.status !== "rejected";
              const badge = deliveryBadge(a);
              const needsAttention = a.onboardingEmailStatus === "bounced" || a.onboardingEmailStatus === "failed";
              return (
                <tr key={a.id} className={`border-t hover:bg-accent/30 ${needsAttention ? "bg-rose-50/60" : ""}`}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${a.firstName} ${a.lastName}`}
                      checked={selected.has(a.id)}
                      onChange={() => toggleRow(a.id)}
                      disabled={!isEligible}
                      title={isEligible ? undefined : `Cannot request info on ${a.status} applications`}
                    />
                  </td>
                  <td className="px-3 py-2 font-medium">{a.firstName} {a.lastName}</td>
                  <td className="px-3 py-2">{a.email}</td>
                  <td className="px-3 py-2">{a.phone}</td>
                  <td className="px-3 py-2">{[a.city, a.state].filter(Boolean).join(", ") || "—"}</td>
                  {distanceActive && (
                    <td className="px-3 py-2 font-mono text-xs">
                      {a.distanceMiles != null ? `${a.distanceMiles.toFixed(1)} mi` : "—"}
                    </td>
                  )}
                  <td className="px-3 py-2">{a.siaLicenseLevel ? `L${a.siaLicenseLevel}` : "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 text-[11px] uppercase rounded border ${STATUS_STYLES[a.status]}`}>
                      {a.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {badge ? (
                      <span
                        title={badge.tooltip}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] uppercase rounded border ${badge.className}`}
                      >
                        <badge.Icon className="w-3 h-3" />
                        {badge.label}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => setOpenId(a.id)}>Review</Button>
                  </td>
                </tr>
              );
            })}
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
          onDeleted={(id) => {
            setItems((arr) => arr.filter((x) => x.id !== id));
            setOpenId(null);
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
      {showBatch && selectedItems.length > 0 && (
        <BatchRequestInfoDialog
          apps={selectedItems}
          onClose={() => setShowBatch(false)}
          onDone={(result) => {
            setShowBatch(false);
            // Apply per-row updates from any successful sends.
            setItems((arr) => arr.map((x) => {
              const updated = result.successes.find((s) => s.application.id === x.id);
              return updated ? updated.application : x;
            }));
            setSelected(new Set());
            setBatchResult(result);
          }}
        />
      )}
      {batchResult && (
        <BatchResultDialog result={batchResult} onClose={() => setBatchResult(null)} />
      )}
    </div>
  );
}

type BatchResult = {
  successes: RequestInfoResp[];
  failures: { app: Application; error: string }[];
};

function ApplicationDialog({
  app, onClose, onUpdated, onApproved, onRejected, onInfoRequested, onDeleted,
}: {
  app: Application;
  onClose: () => void;
  onUpdated: (a: Application) => void;
  onApproved: (resp: ApproveResp) => void;
  onRejected: (resp: RejectResp) => void;
  onInfoRequested: (resp: RequestInfoResp) => void;
  onDeleted: (id: string) => void;
}) {
  const [notes, setNotes] = useState(app.reviewerNotes ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRequestInfo, setShowRequestInfo] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleDelete() {
    setBusy("delete"); setError(null);
    try {
      await api(`/admin/applications/${app.id}`, { method: "DELETE" });
      onDeleted(app.id);
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); setConfirmDelete(false); }
  }

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
          <Info k="Photo ID type" v={app.idDocType === "passport" ? "Passport" : app.idDocType === "drivers_license" ? "Driver's License" : null} />
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
            <FileLink k="Form I-9" path={app.i9DocKey} />
            <FileLink k="SSN card" path={app.ssnCardDocKey} />
            <FileLink
              k={app.idDocType === "passport" ? "Passport" : app.idDocType === "drivers_license" ? "Driver's License" : "Photo ID"}
              path={app.idDocKey}
            />
            {app.rightToWorkDocKey && <FileLink k="Right-to-work (legacy)" path={app.rightToWorkDocKey} />}
            <FileLink k="Photo" path={app.photoKey} />
            <FileLink k="Resume" path={app.cvKey} />
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
        {app.status === "approved" && app.onboardingEmailStatus && (
          <Section title="Onboarding email delivery">
            <DeliveryDetails app={app} />
          </Section>
        )}
        {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}
        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {app.status !== "approved" && !confirmDelete && (
            <Button
              variant="outline"
              className="text-destructive border-destructive/40 hover:bg-destructive/5 mr-auto"
              disabled={!!busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete applicant
            </Button>
          )}
          {confirmDelete && (
            <div className="flex items-center gap-2 mr-auto">
              <span className="text-sm text-destructive">Permanently delete this applicant?</span>
              <Button variant="destructive" size="sm" disabled={busy === "delete"} onClick={handleDelete}>
                {busy === "delete" ? "Deleting…" : "Yes, delete"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </div>
          )}
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
          ) : (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded">
              <MailCheck className="w-5 h-5 mt-0.5 shrink-0 opacity-60" />
              <div>
                <div className="font-medium">Onboarding email NOT sent to {resp.application.email}</div>
                <div className="text-xs mt-0.5">
                  Email delivery isn't configured or the send failed. Use the link below to share onboarding details manually.
                </div>
              </div>
            </div>
          )}

          {/* SMS status is always shown so admins know whether the fallback reached the candidate,
              independent of whether email succeeded. */}
          {resp.smsStatus === "sent" && (
            <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded">
              <MessageSquare className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Onboarding link also texted to {resp.application.phone}</div>
                <div className="text-xs mt-0.5">SMS fallback delivered via Twilio.</div>
              </div>
            </div>
          )}
          {resp.smsStatus === "failed" && (
            <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 text-rose-900 p-3 rounded">
              <MessageSquare className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">SMS to {resp.application.phone} failed</div>
                <div className="text-xs mt-0.5">Twilio rejected the message — share the onboarding link manually.</div>
              </div>
            </div>
          )}
          {resp.smsStatus === "skipped" && (
            <div className="text-xs text-muted-foreground border border-dashed rounded p-2">
              SMS fallback not sent — Twilio isn't connected, or the applicant's phone isn't in E.164 format (e.g. <code>+12145551234</code>).
            </div>
          )}

          {!resp.emailSent && (
            <p>
              Share the onboarding link below — it expires in 14 days and can be used once.
            </p>
          )}
          <details className="text-xs" open={!resp.emailSent}>
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {resp.emailSent ? "Show link & temporary password (for backup)" : "Onboarding link & temporary password"}
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
              <Field label={`Temporary password (for ${(window as any).__BRAND__?.appName ?? "SecureOps"} mobile app)`}>
                <div className="flex gap-1">
                  <Input readOnly value={resp.tempPassword} />
                  <Button type="button" variant="outline" onClick={() => copy(resp.tempPassword)}><Copy className="w-4 h-4" /></Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Email login: <strong>{resp.application.email}</strong>. Shown once — the employee will be prompted to set a new password on first login.
                </p>
              </Field>
            </div>
          </details>
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
function DeliveryDetails({ app }: { app: Application }) {
  const badge = deliveryBadge(app);
  const isBad = app.onboardingEmailStatus === "bounced" || app.onboardingEmailStatus === "failed";
  const isNoSmtp = app.onboardingEmailStatus === "not_configured";
  const cls = isBad
    ? "bg-rose-50 border-rose-300 text-rose-900"
    : isNoSmtp
      ? "bg-amber-50 border-amber-200 text-amber-900"
      : "bg-emerald-50 border-emerald-200 text-emerald-900";
  return (
    <div className={`text-sm border rounded p-3 space-y-2 ${cls}`}>
      <div className="flex items-center gap-2">
        {badge && (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] uppercase rounded border ${badge.className}`}>
            <badge.Icon className="w-3 h-3" />{badge.label}
          </span>
        )}
        <span className="text-xs">→ {app.email}</span>
      </div>
      {isBad && (
        <div className="text-xs">
          <strong>Needs attention:</strong> the candidate likely never received their onboarding link.
          Confirm the email address with them and use "Resend onboarding link" on the Onboarding page once it's corrected.
        </div>
      )}
      {isNoSmtp && (
        <div className="text-xs">
          SMTP isn't configured, so no email was attempted. Copy the onboarding link from the approval confirmation and share it manually.
        </div>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        {app.onboardingEmailAttemptedAt && (
          <><dt className="opacity-70">Last attempt</dt><dd>{new Date(app.onboardingEmailAttemptedAt).toLocaleString()}</dd></>
        )}
        {app.onboardingEmailSentAt && (
          <><dt className="opacity-70">Accepted at</dt><dd>{new Date(app.onboardingEmailSentAt).toLocaleString()}</dd></>
        )}
        {app.onboardingEmailMessageId && (
          <><dt className="opacity-70">Message ID</dt><dd className="font-mono break-all">{app.onboardingEmailMessageId}</dd></>
        )}
        {app.onboardingEmailResponse && (
          <><dt className="opacity-70">SMTP response</dt><dd className="font-mono break-all">{app.onboardingEmailResponse}</dd></>
        )}
        {app.onboardingEmailError && (
          <><dt className="opacity-70">Reason</dt><dd className="break-all">{app.onboardingEmailError}</dd></>
        )}
      </dl>
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

function BatchRequestInfoDialog({
  apps, onClose, onDone,
}: {
  apps: Application[];
  onClose: () => void;
  onDone: (result: BatchResult) => void;
}) {
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  function toggle(key: string) {
    setSelectedFields((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  // Per-field count of how many selected applicants are missing it — so the
  // admin can see "8 of 10 selected applicants are missing photo".
  function missingCount(fieldKey: string): number {
    const dbKey = AMENDMENT_FIELDS.find((f) => f.key === fieldKey)?.dbKey ?? fieldKey;
    return apps.filter((a) => {
      const v = (a as unknown as Record<string, unknown>)[dbKey];
      return v == null || v === "";
    }).length;
  }

  async function send() {
    if (selectedFields.size === 0) { setError("Select at least one field."); return; }
    setBusy(true); setError(null);
    setProgress({ done: 0, total: apps.length });
    const fields = [...selectedFields];
    const trimmedNote = note.trim() || undefined;
    const successes: RequestInfoResp[] = [];
    const failures: { app: Application; error: string }[] = [];

    // Limit concurrency so we don't hammer SMTP. 4 at a time.
    const queue = [...apps];
    async function worker() {
      while (queue.length) {
        const app = queue.shift();
        if (!app) return;
        try {
          const resp = await api<RequestInfoResp>(`/admin/applications/${app.id}/request-info`, {
            method: "POST",
            body: { requestedFields: fields, note: trimmedNote },
          });
          successes.push(resp);
        } catch (e) {
          failures.push({ app, error: (e as Error).message });
        } finally {
          setProgress((p) => p ? { done: p.done + 1, total: p.total } : p);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, apps.length) }, worker));
    setBusy(false);
    setProgress(null);
    onDone({ successes, failures });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="brand-wordmark text-xl flex items-center gap-2">
            <MessageSquareWarning className="w-5 h-5 brand-gold" />
            Request more info — {apps.length} applicant{apps.length === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="bg-muted/40 border rounded p-3 max-h-32 overflow-y-auto">
            <div className="text-xs uppercase tracking-wide opacity-70 mb-1">Recipients</div>
            <div className="text-xs space-y-0.5">
              {apps.map((a) => (
                <div key={a.id}>
                  <strong>{a.firstName} {a.lastName}</strong>
                  <span className="text-muted-foreground"> · {a.email}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-muted-foreground">
            Each applicant gets their own secure link to the items you tick below. The same note (if any)
            goes to everyone. Links expire in 14 days. Any prior unconsumed link for an applicant is invalidated.
          </p>
          <div className="border rounded divide-y">
            {AMENDMENT_FIELDS.map((f) => {
              const isOn = selectedFields.has(f.key);
              const missing = missingCount(f.key);
              return (
                <label key={f.key} className="flex items-start gap-3 px-3 py-2 hover:bg-accent/30 cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={isOn} onChange={() => toggle(f.key)} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{f.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {missing === 0
                        ? <span className="text-emerald-700">All selected applicants already have this</span>
                        : <span>{missing} of {apps.length} missing this</span>}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide opacity-70">Note to applicants (optional)</div>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. We need clearer copies of your right-to-work and license documents." />
          </div>
          {progress && (
            <div className="text-xs text-muted-foreground">
              Sending… {progress.done} / {progress.total}
            </div>
          )}
          {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button className="bg-brand-navy hover:opacity-90 text-white"
            onClick={send} disabled={busy || selectedFields.size === 0}>
            {busy ? "Sending…" : `Send to ${apps.length} applicant${apps.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BatchResultDialog({ result, onClose }: { result: BatchResult; onClose: () => void }) {
  function copy(text: string) { navigator.clipboard.writeText(text).catch(() => {}); }
  const emailedCount = result.successes.filter((s) => s.emailSent).length;
  const linkOnlyCount = result.successes.length - emailedCount;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="brand-wordmark text-xl">Batch info request — results</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Emailed" value={emailedCount} tone="emerald" />
            <Stat label="Link only" value={linkOnlyCount} tone="amber" />
            <Stat label="Failed" value={result.failures.length} tone="rose" />
          </div>
          {result.failures.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide opacity-70 mb-1">Failures</div>
              <ul className="text-xs bg-rose-50 border border-rose-200 rounded p-2 space-y-1">
                {result.failures.map((f) => (
                  <li key={f.app.id}>
                    <strong>{f.app.firstName} {f.app.lastName}</strong> — {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {linkOnlyCount > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide opacity-70 mb-1">
                Share these links manually (SMTP didn't send)
              </div>
              <ul className="text-xs space-y-1">
                {result.successes.filter((s) => !s.emailSent).map((s) => (
                  <li key={s.application.id} className="flex items-center gap-1">
                    <span className="shrink-0">{s.application.firstName} {s.application.lastName} ({s.application.email}):</span>
                    <Input readOnly value={s.amendUrl} className="text-xs h-7 flex-1" />
                    <Button type="button" size="sm" variant="outline" onClick={() => copy(s.amendUrl)}>
                      <Copy className="w-3 h-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {emailedCount > 0 && result.failures.length === 0 && linkOnlyCount === 0 && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded">
              All {emailedCount} applicant{emailedCount === 1 ? "" : "s"} have been emailed.
            </div>
          )}
        </div>
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "emerald" | "amber" | "rose" }) {
  const cls = tone === "emerald"
    ? "bg-emerald-50 border-emerald-200 text-emerald-900"
    : tone === "amber"
      ? "bg-amber-50 border-amber-200 text-amber-900"
      : "bg-rose-50 border-rose-200 text-rose-900";
  return (
    <div className={`border rounded p-2 text-center ${cls}`}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-[11px] uppercase tracking-wide opacity-80">{label}</div>
    </div>
  );
}
