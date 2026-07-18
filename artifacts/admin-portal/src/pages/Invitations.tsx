import { useEffect, useMemo, useState } from "react";
import { MailPlus, KeyRound, Loader2, Eye, EyeOff, Copy, Download, Send, AlertTriangle, RefreshCw, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Row = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  tempPasswordPlain: string | null;
  tempPasswordSetAt: string | null;
  invitedAt: string | null;
  createdAt: string;
};

type GenerateResp = {
  generated: { userId: string; email: string; firstName: string; lastName: string; tempPassword: string }[];
  skipped: { userId: string; email: string; reason: string }[];
  counts: { total: number; generated: number; skipped: number };
};

type InviteResp = {
  sent: { userId: string; email: string; emailSent: boolean }[];
  failed: { userId: string; email: string; reason: string }[];
  counts: { total: number; sent: number; failed: number };
};

type Filter = "all" | "no_password" | "ready_to_invite" | "invited";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "no_password", label: "No password yet" },
  { value: "ready_to_invite", label: "Ready to invite" },
  { value: "invited", label: "Invited" },
];

export function InvitationsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reveal, setReveal] = useState<Set<string>>(new Set());
  const [revealAll, setRevealAll] = useState(false);

  const [confirmGen, setConfirmGen] = useState<null | { force: boolean }>(null);
  const [genResult, setGenResult] = useState<GenerateResp | null>(null);
  const [genBusy, setGenBusy] = useState(false);

  const [confirmInvite, setConfirmInvite] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResp | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const data = await api<Row[]>("/admin/users/invitations");
      setRows(data);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.firstName} ${r.lastName} ${r.email}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      switch (filter) {
        case "no_password": return !r.tempPasswordPlain && !r.invitedAt;
        case "ready_to_invite": return !!r.tempPasswordPlain && !r.invitedAt;
        case "invited": return !!r.invitedAt;
      }
      return true;
    });
  }, [rows, filter, search]);

  const counts = useMemo(() => ({
    total: rows.length,
    noPassword: rows.filter((r) => !r.tempPasswordPlain && !r.invitedAt).length,
    ready: rows.filter((r) => !!r.tempPasswordPlain && !r.invitedAt).length,
    invited: rows.filter((r) => !!r.invitedAt).length,
  }), [rows]);

  const selectedReadyRows = useMemo(
    () => filtered.filter((r) => selected.has(r.id) && r.tempPasswordPlain && !r.invitedAt),
    [filtered, selected],
  );

  function toggleRow(id: string) {
    setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((p) => p.size === filtered.length && filtered.length > 0
      ? new Set()
      : new Set(filtered.map((r) => r.id)));
  }
  const allSelected = filtered.length > 0 && selected.size === filtered.length;

  function copy(text: string) { navigator.clipboard.writeText(text).catch(() => {}); }

  function downloadCsv() {
    const ready = rows.filter((r) => r.tempPasswordPlain && !r.invitedAt);
    if (ready.length === 0) return;
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = ["First Name","Last Name","Email","Role","Status","Temporary Password","Set At"].map(escape).join(",");
    const lines = ready.map((r) => [
      r.firstName, r.lastName, r.email, r.role, r.status,
      r.tempPasswordPlain ?? "", r.tempPasswordSetAt ?? "",
    ].map((v) => escape(String(v ?? ""))).join(","));
    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `wcsg-temp-passwords-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  async function runGenerate(opts: { force: boolean; scope: "all" | "selected" }) {
    setGenBusy(true); setError(null);
    try {
      const body = opts.scope === "all"
        ? { scope: "all_non_admin" as const, force: opts.force }
        : { scope: "by_ids" as const, userIds: [...selected], force: opts.force };
      const resp = await api<GenerateResp>("/admin/users/bulk-temp-passwords", { method: "POST", body });
      setGenResult(resp);
      setConfirmGen(null);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setGenBusy(false); }
  }

  async function runInvite() {
    setInviteBusy(true); setError(null);
    try {
      const ids = selectedReadyRows.map((r) => r.id);
      if (ids.length === 0) { setError("No ready-to-invite users selected."); return; }
      const resp = await api<InviteResp>("/admin/users/bulk-invite", { method: "POST", body: { userIds: ids } });
      setInviteResult(resp);
      setConfirmInvite(false);
      setSelected(new Set());
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setInviteBusy(false); }
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      <header>
        <h1 className="brand-wordmark text-2xl flex items-center gap-2">
          <MailPlus className="w-6 h-6 brand-gold" /> Invitations
        </h1>
        <p className="text-sm text-muted-foreground">
          Generate temporary passwords for non-admin users now, then send invite emails when you're ready.
          Admins are never included.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Total non-admin" value={counts.total} tone="navy" />
        <Stat label="No password yet" value={counts.noPassword} tone="slate" />
        <Stat label="Ready to invite" value={counts.ready} tone="amber" />
        <Stat label="Invited" value={counts.invited} tone="emerald" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Filter invitations">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={`text-xs px-3 py-1.5 rounded border ${
                filter === f.value ? "bg-brand-navy text-white border-brand-navy" : "bg-background hover:bg-accent/40"
              }`}>{f.label}</button>
          ))}
        </div>
        <Input value={search} onChange={(e) => setSearch(e.target.value)}
          aria-label="Search invitations"
          placeholder="Search name or email" className="w-64" />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={downloadCsv} disabled={counts.ready === 0}>
            <Download className="w-4 h-4 mr-1" /> Download credentials CSV
          </Button>
          <Button className="bg-brand-navy hover:opacity-90 text-white"
            onClick={() => setConfirmGen({ force: false })}>
            <KeyRound className="w-4 h-4 mr-1" /> Generate temp passwords
          </Button>
        </div>
      </div>

      {error && <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">{error}</div>}

      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-brand-navy text-white px-4 py-2 rounded shadow">
          <span className="text-sm">
            <strong>{selected.size}</strong> selected
            {selected.size !== selectedReadyRows.length && (
              <span className="opacity-70"> · {selectedReadyRows.length} ready to invite</span>
            )}
          </span>
          <Button size="sm" variant="secondary" className="ml-auto"
            onClick={() => setConfirmInvite(true)}
            disabled={selectedReadyRows.length === 0}>
            <Send className="w-4 h-4 mr-1" /> Send invite to {selectedReadyRows.length}
          </Button>
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/10"
            onClick={() => runGenerate({ force: true, scope: "selected" })}
            disabled={genBusy || selected.size === 0}>
            <RefreshCw className="w-4 h-4 mr-1" /> Regenerate password
          </Button>
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/10"
            onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <div className="bg-card rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 w-8">
                <input type="checkbox" aria-label="Select all" checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                  onChange={toggleAll} disabled={filtered.length === 0} />
              </th>
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Role</th>
              <th className="text-left px-3 py-2">
                <button className="inline-flex items-center gap-1 hover:text-foreground"
                  onClick={() => setRevealAll((v) => !v)}
                  title={revealAll ? "Hide all passwords" : "Reveal all passwords"}>
                  Temp password {revealAll ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
              </th>
              <th className="text-left px-3 py-2">Set</th>
              <th className="text-left px-3 py-2">Invited</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                <Loader2 className="w-5 h-5 inline-block animate-spin" />
              </td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                No users match.
              </td></tr>
            )}
            {filtered.map((r) => {
              const showPw = revealAll || reveal.has(r.id);
              const isInvited = !!r.invitedAt;
              return (
                <tr key={r.id} className="border-t hover:bg-accent/30">
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={`Select ${r.firstName} ${r.lastName}`}
                      checked={selected.has(r.id)} onChange={() => toggleRow(r.id)} />
                  </td>
                  <td className="px-3 py-2 font-medium">{r.firstName} {r.lastName}</td>
                  <td className="px-3 py-2">{r.email}</td>
                  <td className="px-3 py-2 text-xs uppercase tracking-wide">{r.role}</td>
                  <td className="px-3 py-2">
                    {r.tempPasswordPlain ? (
                      <div className="flex items-center gap-1">
                        <code className="font-mono text-xs bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                          {showPw ? r.tempPasswordPlain : "••••••••••"}
                        </code>
                        <button type="button" title={showPw ? "Hide" : "Show"}
                          aria-label={showPw ? "Hide temporary password" : "Show temporary password"}
                          onClick={() => setReveal((p) => { const n = new Set(p); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })}
                          className="opacity-60 hover:opacity-100">
                          {showPw ? <EyeOff aria-hidden="true" className="w-3.5 h-3.5" /> : <Eye aria-hidden="true" className="w-3.5 h-3.5" />}
                        </button>
                        <button type="button" title="Copy email + password"
                          aria-label="Copy email and temporary password"
                          onClick={() => copy(`${r.email}\t${r.tempPasswordPlain}`)}
                          className="opacity-60 hover:opacity-100">
                          <Copy aria-hidden="true" className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {isInvited ? "(cleared after invite)" : "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.tempPasswordSetAt ? formatDate(r.tempPasswordSetAt) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {isInvited
                      ? <span className="inline-flex items-center gap-1 text-emerald-700 text-xs">
                          <CheckCircle2 className="w-3.5 h-3.5" /> {formatDate(r.invitedAt!)}
                        </span>
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!isInvited && (
                      <Button size="sm" variant="outline"
                        onClick={() => { setSelected(new Set([r.id])); setConfirmGen({ force: !!r.tempPasswordPlain }); }}
                        title={r.tempPasswordPlain ? "Regenerate temp password" : "Generate temp password"}>
                        <KeyRound className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Generate confirmation */}
      {confirmGen && (
        <AlertDialog open onOpenChange={(o) => { if (!o && !genBusy) setConfirmGen(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Generate temporary passwords?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>
                    A random 10-character password will be created for each non-admin user
                    {selected.size > 0 ? ` in your selection (${selected.size})` : " who doesn't already have one"}.
                    Existing logins for those users will stop working until the new password is shared.
                  </p>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={confirmGen.force}
                      onChange={(e) => setConfirmGen({ force: e.target.checked })} />
                    <span>Also rotate users that already have an unsent temp password</span>
                  </label>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={genBusy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); runGenerate({ force: confirmGen.force, scope: selected.size > 0 ? "selected" : "all" }); }}
                disabled={genBusy}>
                {genBusy ? "Generating…" : "Generate"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Generate result */}
      {genResult && (
        <Dialog open onOpenChange={(o) => { if (!o) setGenResult(null); }}>
          <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="brand-wordmark text-xl flex items-center gap-2">
                <KeyRound className="w-5 h-5 brand-gold" /> Temporary passwords generated
              </DialogTitle>
              <DialogDescription className="sr-only">
                Review the temporary passwords that were generated for the selected users.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Generated" value={genResult.counts.generated} tone="emerald" />
                <Stat label="Skipped" value={genResult.counts.skipped} tone="amber" />
                <Stat label="Total" value={genResult.counts.total} tone="navy" />
              </div>
              {genResult.generated.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs uppercase tracking-wide opacity-70">New credentials</div>
                    <Button size="sm" variant="outline"
                      onClick={() => copy(genResult.generated.map((g) => `${g.email}\t${g.tempPassword}`).join("\n"))}>
                      <Copy className="w-3 h-3 mr-1" /> Copy all
                    </Button>
                  </div>
                  <div className="border rounded max-h-72 overflow-y-auto">
                    <table className="w-full text-xs">
                      <tbody>
                        {genResult.generated.map((g) => (
                          <tr key={g.userId} className="border-t">
                            <td className="px-2 py-1">{g.firstName} {g.lastName}</td>
                            <td className="px-2 py-1">{g.email}</td>
                            <td className="px-2 py-1 font-mono">{g.tempPassword}</td>
                            <td className="px-2 py-1 text-right">
                              <button type="button" onClick={() => copy(`${g.email}\t${g.tempPassword}`)}
                                aria-label={`Copy ${g.email} and temporary password`}
                                className="opacity-60 hover:opacity-100">
                                <Copy aria-hidden="true" className="w-3 h-3" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 text-amber-900 p-2 rounded mt-2 text-xs flex gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>These passwords are also stored on each user's record until you invite them. Use the table or CSV export anytime — you don't need to copy them right now.</span>
                  </div>
                </div>
              )}
              {genResult.skipped.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wide opacity-70 mb-1">Skipped</div>
                  <ul className="text-xs bg-muted/40 border rounded p-2 space-y-0.5 max-h-40 overflow-y-auto">
                    {genResult.skipped.map((s) => (
                      <li key={s.userId}>{s.email} — {s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <DialogFooter><Button onClick={() => setGenResult(null)}>Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Invite confirmation */}
      {confirmInvite && (
        <AlertDialog open onOpenChange={(o) => { if (!o && !inviteBusy) setConfirmInvite(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Send invite emails?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>
                    Each of the <strong>{selectedReadyRows.length}</strong> selected user{selectedReadyRows.length === 1 ? "" : "s"} will get an
                    email containing the sign-in URL, their email address, and their temporary password.
                  </p>
                  <p>
                    After a successful send, the temporary password is cleared from the system —
                    they'll need to use the password from the email to sign in.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={inviteBusy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); runInvite(); }}
                disabled={inviteBusy}>
                {inviteBusy ? "Sending…" : `Send ${selectedReadyRows.length}`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Invite result */}
      {inviteResult && (
        <Dialog open onOpenChange={(o) => { if (!o) setInviteResult(null); }}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="brand-wordmark text-xl">Invite emails — results</DialogTitle>
              <DialogDescription className="sr-only">
                Summary of which invite emails were sent and which failed.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Sent" value={inviteResult.counts.sent} tone="emerald" />
                <Stat label="Failed" value={inviteResult.counts.failed} tone="rose" />
                <Stat label="Total" value={inviteResult.counts.total} tone="navy" />
              </div>
              {inviteResult.failed.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wide opacity-70 mb-1">Failures</div>
                  <ul className="text-xs bg-rose-50 border border-rose-200 rounded p-2 space-y-1">
                    {inviteResult.failed.map((f) => (
                      <li key={f.userId}><strong>{f.email}</strong> — {f.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              {inviteResult.counts.sent > 0 && inviteResult.counts.failed === 0 && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded">
                  All {inviteResult.counts.sent} invite{inviteResult.counts.sent === 1 ? "" : "s"} sent.
                  Temp passwords have been cleared from the system.
                </div>
              )}
            </div>
            <DialogFooter><Button onClick={() => setInviteResult(null)}>Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "navy" | "slate" | "emerald" | "amber" | "rose" }) {
  const cls = {
    navy: "bg-brand-navy/5 border-brand-navy/20 text-brand-navy",
    slate: "bg-slate-50 border-slate-200 text-slate-800",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    rose: "bg-rose-50 border-rose-200 text-rose-900",
  }[tone];
  return (
    <div className={`border rounded p-2 text-center ${cls}`}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-[11px] uppercase tracking-wide opacity-80">{label}</div>
    </div>
  );
}
