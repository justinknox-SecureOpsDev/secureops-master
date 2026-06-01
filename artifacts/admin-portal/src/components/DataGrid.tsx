import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowUpDown, ArrowDown, ArrowUp, Pencil, Trash2, Plus, Upload, Download, RefreshCw, ExternalLink, Repeat, KeyRound, Copy, ShieldOff, FileText, MapPin, UserPlus, Mail } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { type TableDescriptor, type Field, singularize } from "@/lib/tables";
import { api, getToken } from "@/lib/api";
import { formatCell } from "@/lib/format";
import { useFkOptions } from "@/lib/fk";
import { openSignedObject } from "@/lib/upload";
import { RowFormDialog } from "./RowFormDialog";
import { ImportWizard } from "./ImportWizard";
import { RepeatingShiftDialog } from "./RepeatingShiftDialog";
import { downloadTemplateXlsx } from "@/lib/import";
import { useDeepLinkFocus } from "@/hooks/useDeepLinkFocus";

type Row = Record<string, unknown>;

function FkCell({ field, value }: { field: { fkTable?: string; fkLabel?: string }; value: unknown }) {
  const { options } = useFkOptions(field.fkTable);
  if (!value) return <>—</>;
  const o = options.find((x) => x.id === String(value));
  return <span title={String(value)}>{o?.label ?? String(value).slice(0, 8) + "…"}</span>;
}

function FileKeyCell({ value }: { value: unknown }) {
  if (!value || typeof value !== "string") return <>—</>;
  const name = value.split("/").pop() ?? value;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openSignedObject(value); }}
      className="inline-flex items-center gap-1 text-blue-700 hover:underline"
      title={value}
    >
      <ExternalLink className="w-3 h-3" />
      <span className="truncate">{name}</span>
    </button>
  );
}

function FileKeyListCell({ value }: { value: unknown }) {
  const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  if (arr.length === 0) return <>—</>;
  return (
    <div className="flex flex-col gap-0.5">
      {arr.slice(0, 3).map((p, i) => (
        <button
          key={i}
          type="button"
          onClick={(e) => { e.stopPropagation(); openSignedObject(p); }}
          className="inline-flex items-center gap-1 text-blue-700 hover:underline text-left"
          title={p}
        >
          <ExternalLink className="w-3 h-3 shrink-0" />
          <span className="truncate">{p.split("/").pop()}</span>
        </button>
      ))}
      {arr.length > 3 && <span className="text-xs text-muted-foreground">+{arr.length - 3} more</span>}
    </div>
  );
}

function DerivedCell({
  field, sourceField, row,
}: { field: Field; sourceField: Field | undefined; row: Row }) {
  const { options } = useFkOptions(sourceField?.fkTable);
  if (!field.derived || !sourceField) return <>—</>;
  const fkValue = (row as any)[field.derived.fromField];
  if (!fkValue) return <>—</>;
  const match = options.find((o) => o.id === String(fkValue));
  const label = field.derived.render(match?.row ?? null);
  const text = label.trim() || "—";
  const linkTo = field.derived.linkTo;
  if (linkTo && text !== "—") {
    const href = `/tables/${linkTo.table}?filter[${linkTo.filterField}]=${encodeURIComponent(String(fkValue))}`;
    return (
      <Link
        href={href}
        onClick={(e) => e.stopPropagation()}
        className="text-blue-700 hover:underline"
        title={`Open ${linkTo.table} record`}
      >
        {text}
      </Link>
    );
  }
  return <>{text}</>;
}

function renderCell(f: Field, value: unknown) {
  if (f.type === "fk") return <FkCell field={f} value={value} />;
  if (f.type === "fileKey") return <FileKeyCell value={value} />;
  if (f.type === "fileKeyList") return <FileKeyListCell value={value} />;
  return formatCell(value, f);
}

export function DataGrid({
  descriptor, filter, presetValues, lockedFields, hideHeader, compact, focusId,
}: {
  descriptor: TableDescriptor;
  /** Equality filters appended to the list query, e.g. { siteId: "abc" }. */
  filter?: Record<string, string>;
  /** Pre-fill these field values when adding a new row (e.g. siteId on the Site detail page). */
  presetValues?: Record<string, string>;
  /** Hide these fields from the add/edit form. */
  lockedFields?: string[];
  /** Hide the page-style header (used when embedded in another page). */
  hideHeader?: boolean;
  /** Tighter padding for embedded use. */
  compact?: boolean;
  /** Deep-link target: scroll to + highlight the row whose id matches (when on the loaded page). */
  focusId?: string | null;
}) {
  const visibleFields = useMemo(
    () => descriptor.fields.filter((f) => !f.hiddenInGrid),
    [descriptor],
  );

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // Deep-link: scroll to + highlight the row whose id matches focusId once it
  // is present in the currently loaded page (mirrors the mobile notification
  // deep links). If the target lives on another page it simply no-ops.
  const focusPresent = focusId != null && rows.some((r) => String((r as any).id) === focusId);
  const { ref: focusRowRef, flashing: focusFlashing } = useDeepLinkFocus(
    focusPresent ? focusId : null,
    !loading && rows.length > 0,
  );
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" }>({
    field: "createdAt", dir: "desc",
  });
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const [editing, setEditing] = useState<Row | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  type UserRow = { id: string; firstName?: unknown; lastName?: unknown; email?: unknown; lastActiveAt?: unknown };
  const toUserRow = (r: Row): UserRow => r as UserRow;
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<UserRow | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeDone, setRevokeDone] = useState<{ email: string; revokedAt: string } | null>(null);
  const [resetResult, setResetResult] = useState<{
    user: { firstName: string; lastName: string; email: string };
    resetUrl: string | null;
    expiresInMinutes: number;
    emailSent: boolean;
  } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const isShifts = descriptor.name === "shifts";
  const isUsers = descriptor.name === "users";
  const isIncidents = descriptor.name === "incidents";
  const isSites = descriptor.name === "sites";
  const isClients = descriptor.name === "clients";
  const [inviteTarget, setInviteTarget] = useState<Row | null>(null);
  const [inviteForm, setInviteForm] = useState({ email: "", firstName: "", lastName: "" });
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<{
    email: string;
    status: string;
    emailSent: boolean;
    tempPassword?: string;
    loginUrl?: string;
  } | null>(null);
  const [geocodeBackfillBusy, setGeocodeBackfillBusy] = useState(false);
  const [geocodeBackfillResult, setGeocodeBackfillResult] = useState<{
    candidates: number;
    resolved: number;
    refreshed?: number;
    unresolved: number;
    unresolvedSites: Array<{ id: string; name: string }>;
    mode?: string;
  } | null>(null);
  const [geocodeBackfillError, setGeocodeBackfillError] = useState<string | null>(null);
  // Opt-in: when true, the bulk backfill also re-resolves sites whose
  // address text has drifted since the last successful geocode.
  const [geocodeRefreshChanged, setGeocodeRefreshChanged] = useState(false);

  async function runGeocodeBackfill() {
    setGeocodeBackfillBusy(true);
    setGeocodeBackfillError(null);
    setGeocodeBackfillResult(null);
    try {
      const r = await api<{
        candidates: number;
        resolved: number;
        refreshed?: number;
        unresolved: number;
        unresolvedSites: Array<{ id: string; name: string }>;
        mode?: string;
      }>(`/sites/geocode-missing`, {
        method: "POST",
        body: JSON.stringify({ refreshChanged: geocodeRefreshChanged }),
        headers: { "Content-Type": "application/json" },
      });
      setGeocodeBackfillResult(r);
      load();
    } catch (e) {
      setGeocodeBackfillError((e as Error).message);
    } finally {
      setGeocodeBackfillBusy(false);
    }
  }

  async function downloadIncidentPdf(row: Row) {
    const id = String((row as { id?: unknown }).id ?? "");
    if (!id) return;
    try {
      // Direct fetch (the shared `api` helper is JSON-only) so we can read
      // the bytes as a Blob and honor the server's Content-Disposition.
      const token = getToken();
      const res = await fetch(`/api/incidents/${id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^";]+)"?/i.exec(cd);
      const filename = m?.[1] ?? `wcsg-incident-${id.slice(0, 8)}.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alert(`Could not download PDF: ${(e as Error).message}`);
    }
  }

  async function confirmRevokeSessions() {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      const r = await api<{ email: string; revokedAt: string }>(
        `/admin/users/${revokeTarget.id}/revoke-sessions`,
        { method: "POST" },
      );
      setRevokeDone(r);
      setRevokeTarget(null);
    } catch (e) {
      setRevokeError((e as Error).message);
    } finally {
      setRevokeBusy(false);
    }
  }

  async function confirmPasswordReset() {
    if (!resetTarget) return;
    setResetBusy(true);
    setResetError(null);
    try {
      const r = await api<{ resetUrl: string | null; expiresInMinutes: number; emailSent: boolean }>(
        `/admin/users/${resetTarget.id}/password-reset`,
        { method: "POST" },
      );
      setResetResult({
        user: {
          firstName: String(resetTarget.firstName ?? ""),
          lastName: String(resetTarget.lastName ?? ""),
          email: String(resetTarget.email ?? ""),
        },
        ...r,
      });
      setResetTarget(null);
    } catch (e) {
      setResetError((e as Error).message);
    } finally {
      setResetBusy(false);
    }
  }

  async function confirmInvite() {
    if (!inviteTarget) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const res = await api<{
        id: string;
        email: string;
        status: string;
        emailSent: boolean;
        loginUrl?: string;
        tempPassword?: string;
      }>("/admin/client-users/invite", {
        method: "POST",
        body: { ...inviteForm, clientId: String((inviteTarget as any).id) },
      });
      setInviteResult(res);
      setInviteTarget(null);
      setInviteForm({ email: "", firstName: "", lastName: "" });
    } catch (e) {
      setInviteError((e as Error).message);
    } finally {
      setInviteBusy(false);
    }
  }

  useEffect(() => { setPage(0); }, [descriptor.name]);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  const filterKey = useMemo(
    () => (filter ? Object.entries(filter).map(([k, v]) => `${k}=${v}`).sort().join("&") : ""),
    [filter],
  );

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String(page * pageSize));
      if (debounced) params.set("search", debounced);
      params.set("sort", sort.field);
      params.set("dir", sort.dir);
      if (filter) {
        for (const [k, v] of Object.entries(filter)) {
          if (v) params.set(`filter[${k}]`, v);
        }
      }
      const data = await api<{ rows: Row[]; total: number }>(
        `/admin/tables/${descriptor.name}?${params}`,
      );
      setRows(data.rows);
      setTotal(data.total);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptor.name, debounced, page, sort, filterKey]);

  const lockedSet = useMemo(() => new Set(lockedFields ?? []), [lockedFields]);
  const gridFields = useMemo(
    () => visibleFields.filter((f) => !lockedSet.has(f.key)),
    [visibleFields, lockedSet],
  );

  function toggleSort(fieldKey: string) {
    setSort((s) => s.field === fieldKey
      ? { field: fieldKey, dir: s.dir === "asc" ? "desc" : "asc" }
      : { field: fieldKey, dir: "asc" });
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api(`/admin/tables/${descriptor.name}/${(deleting as any).id}`, { method: "DELETE" });
      setDeleting(null);
      load();
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const padX = compact ? "px-3" : "px-6";

  return (
    <div className="flex flex-col h-full">
      {!hideHeader && (
        <div className={`flex items-center justify-between gap-3 ${padX} py-4 border-b bg-card`}>
          <div>
            <h1 className="text-2xl brand-navy" style={{ fontFamily: "Georgia, serif", fontWeight: 700 }}>
              {descriptor.label}
            </h1>
            <p className="text-xs text-muted-foreground">
              {loading ? "Loading…" : `${total.toLocaleString()} ${descriptor.plural}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search…"
              aria-label={`Search ${descriptor.plural}`}
              className="w-64"
            />
            <Button variant="outline" size="icon" onClick={load} title="Refresh" aria-label="Refresh">
              <RefreshCw className="w-4 h-4" />
            </Button>
            {descriptor.importSupported && (
              <>
                <Button variant="outline" onClick={() => { void downloadTemplateXlsx(descriptor); }}>
                  <Download className="w-4 h-4 mr-2" />Template
                </Button>
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  <Upload className="w-4 h-4 mr-2" />Import
                </Button>
              </>
            )}
            {isShifts && (
              <Button variant="outline" onClick={() => setRepeatOpen(true)} title="Create a series of shifts on selected days">
                <Repeat className="w-4 h-4 mr-2" />Repeating Shift
              </Button>
            )}
            {isSites && (
              <div className="flex items-center gap-2">
                <label
                  className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
                  title="Also re-geocode sites whose address text has changed since the last successful lookup"
                >
                  <input
                    type="checkbox"
                    checked={geocodeRefreshChanged}
                    onChange={(e) => setGeocodeRefreshChanged(e.target.checked)}
                    disabled={geocodeBackfillBusy}
                    className="h-3.5 w-3.5"
                  />
                  Also refresh changed addresses
                </label>
                <Button
                  variant="outline"
                  onClick={runGeocodeBackfill}
                  disabled={geocodeBackfillBusy}
                  title={
                    geocodeRefreshChanged
                      ? "Look up lat/lng for sites missing coords AND re-resolve sites whose address has changed"
                      : "Look up lat/lng for every site that's still missing coordinates"
                  }
                >
                  <MapPin className="w-4 h-4 mr-2" />
                  {geocodeBackfillBusy
                    ? "Geocoding…"
                    : geocodeRefreshChanged
                      ? "Geocode missing + changed"
                      : "Geocode all missing"}
                </Button>
              </div>
            )}
            <Button onClick={() => setCreating(true)} className="bg-brand-navy text-white hover:opacity-90">
              <Plus className="w-4 h-4 mr-2" />Add {singularize(descriptor.label)}
            </Button>
          </div>
        </div>
      )}
      {hideHeader && (
        <div className={`flex items-center justify-between gap-2 ${padX} py-2 border-b bg-card`}>
          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search…"
              aria-label={`Search ${descriptor.plural}`}
              className="w-56 h-8"
            />
            <span className="text-xs text-muted-foreground">
              {loading ? "Loading…" : `${total.toLocaleString()} ${descriptor.plural}`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} title="Refresh" aria-label="Refresh">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
            <Button size="sm" onClick={() => setCreating(true)} className="bg-brand-navy text-white hover:opacity-90">
              <Plus className="w-3.5 h-3.5 mr-1" />Add {singularize(descriptor.label)}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto bg-background">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10">
            <TableRow>
              {gridFields.map((f) => {
                const isSorted = sort.field === f.key;
                const ariaSort: "ascending" | "descending" | "none" = isSorted
                  ? (sort.dir === "asc" ? "ascending" : "descending")
                  : "none";
                return (
                <TableHead key={f.key} aria-sort={f.derived ? undefined : ariaSort}>
                  {f.derived ? (
                    <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide text-xs brand-navy">
                      {f.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSort(f.key)}
                      aria-label={`Sort by ${f.label}${
                        isSorted
                          ? ` (currently ${sort.dir === "asc" ? "ascending" : "descending"})`
                          : ""
                      }`}
                      className="inline-flex items-center gap-1 font-semibold uppercase tracking-wide text-xs brand-navy"
                    >
                      {f.label}
                      {isSorted
                        ? (sort.dir === "asc" ? <ArrowUp aria-hidden="true" className="w-3 h-3" /> : <ArrowDown aria-hidden="true" className="w-3 h-3" />)
                        : <ArrowUpDown aria-hidden="true" className="w-3 h-3 opacity-30" />}
                    </button>
                  )}
                </TableHead>
                );
              })}
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={gridFields.length + 1} className="text-center text-muted-foreground py-12">
                  No {descriptor.plural} yet. Click <b>Add {singularize(descriptor.label)}</b> to create one
                  {descriptor.importSupported ? " or use Import to bulk-load." : "."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => {
              const isFocusRow = focusId != null && String((r as any).id) === focusId;
              return (
              <TableRow
                key={String((r as any).id)}
                ref={isFocusRow ? (focusRowRef as unknown as React.Ref<HTMLTableRowElement>) : undefined}
                className={`hover:bg-accent/40${isFocusRow && focusFlashing ? " wcsg-deep-link-flash" : ""}`}
              >
                {gridFields.map((f) => (
                  <TableCell key={f.key} className="text-sm max-w-[260px] truncate">
                    {f.derived
                      ? <DerivedCell field={f} sourceField={descriptor.fields.find((x) => x.key === f.derived!.fromField)} row={r} />
                      : renderCell(f, (r as any)[f.key])}
                  </TableCell>
                ))}
                <TableCell className="text-right">
                  {descriptor.name === "sites" && (
                    <Link href={`/sites/${(r as any).id}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        title="Open site detail (rate card, checkpoints, geofence)"
                        aria-label="Open site detail"
                        className="mr-1 h-8"
                      >
                        <ExternalLink className="w-3.5 h-3.5 mr-1" />
                        Open
                      </Button>
                    </Link>
                  )}
                  {isUsers && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { setResetError(null); setResetTarget(toUserRow(r)); }}
                      title="Send password reset"
                      aria-label="Send password reset"
                    >
                      <KeyRound className="w-4 h-4" />
                    </Button>
                  )}
                  {isUsers && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { setRevokeError(null); setRevokeTarget(toUserRow(r)); }}
                      title="Revoke all active sessions for this user"
                      aria-label="Revoke all active sessions for this user"
                    >
                      <ShieldOff className="w-4 h-4 text-destructive" />
                    </Button>
                  )}
                  {isIncidents && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => downloadIncidentPdf(r)}
                      title="Download incident report (PDF)"
                      aria-label="Download incident report (PDF)"
                    >
                      <FileText className="w-4 h-4" />
                    </Button>
                  )}
                  {isClients && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mr-1 h-8"
                      onClick={() => {
                        setInviteError(null);
                        setInviteForm({ email: "", firstName: "", lastName: "" });
                        setInviteTarget(r);
                      }}
                      title="Invite a portal user for this client"
                      aria-label="Invite portal user"
                    >
                      <UserPlus className="w-3.5 h-3.5 mr-1" />
                      Invite portal user
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" onClick={() => setEditing(r)} title="Edit" aria-label={`Edit ${singularize(descriptor.label).toLowerCase()}`}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleting(r)} title="Delete" aria-label={`Delete ${singularize(descriptor.label).toLowerCase()}`}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between px-6 py-3 border-t bg-card text-sm">
        <span className="text-muted-foreground">
          Page {page + 1} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">Prev</Button>
          <Button variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">Next</Button>
        </div>
      </div>

      <RowFormDialog
        open={creating}
        onOpenChange={setCreating}
        descriptor={descriptor}
        initial={null}
        onSaved={load}
        presetValues={presetValues}
        lockedFields={lockedFields}
      />
      <RowFormDialog
        open={!!editing}
        onOpenChange={(b) => { if (!b) setEditing(null); }}
        descriptor={descriptor}
        initial={editing}
        onSaved={load}
        lockedFields={lockedFields}
      />
      <ImportWizard
        open={importOpen}
        onOpenChange={setImportOpen}
        descriptor={descriptor}
        onDone={load}
      />
      {isShifts && (
        <RepeatingShiftDialog
          open={repeatOpen}
          onOpenChange={setRepeatOpen}
          onCreated={load}
        />
      )}

      <AlertDialog open={!!revokeTarget} onOpenChange={(b) => { if (!b && !revokeBusy) setRevokeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign this user out everywhere?</AlertDialogTitle>
            <AlertDialogDescription>
              All active sessions for{" "}
              <b>{String(revokeTarget?.firstName ?? "")} {String(revokeTarget?.lastName ?? "")}</b>{" "}
              ({String(revokeTarget?.email ?? "")}) — admin portal, mobile app, and any
              live chat connections — will be invalidated immediately. They'll need to
              sign in again with their existing password. Use this if their phone is
              lost or you suspect their account is compromised.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="text-xs text-muted-foreground bg-muted/40 rounded p-2 border">
            {revokeTarget?.lastActiveAt
              ? <>Last active: <b>{new Date(String(revokeTarget.lastActiveAt)).toLocaleString()}</b> — this account is currently signed in somewhere.</>
              : <>This account has no recorded activity yet — they may not be signed in anywhere right now.</>}
          </div>
          {revokeError && (
            <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
              {revokeError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmRevokeSessions(); }}
              disabled={revokeBusy}
              className="bg-destructive text-destructive-foreground"
            >
              {revokeBusy ? "Revoking…" : "Revoke all sessions"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {revokeDone && (
        <Dialog open onOpenChange={(o) => { if (!o) setRevokeDone(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="brand-wordmark text-xl">Sessions revoked</DialogTitle>
            </DialogHeader>
            <div className="text-sm space-y-2">
              <p>
                All active sessions for <b>{revokeDone.email}</b> were invalidated at{" "}
                {new Date(revokeDone.revokedAt).toLocaleString()}.
              </p>
              <p className="text-muted-foreground">
                Their next request from any device will return 401 and force a fresh sign-in.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => setRevokeDone(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={!!inviteTarget} onOpenChange={(b) => { if (!b && !inviteBusy) setInviteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="brand-wordmark text-xl flex items-center gap-2">
              <UserPlus className="w-5 h-5" /> Invite portal user
            </DialogTitle>
            <DialogDescription>
              Invite a client portal user for{" "}
              <b>{String((inviteTarget as any)?.name ?? "this client")}</b>. A temporary
              password is generated and emailed (if SMTP is configured); they'll set a new
              password on first login. They will appear in the Client Users list linked to
              this client.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => { e.preventDefault(); void confirmInvite(); }}
            className="space-y-4"
          >
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="invite-firstName">First name *</Label>
                <Input
                  id="invite-firstName"
                  required
                  value={inviteForm.firstName}
                  onChange={(e) => setInviteForm((f) => ({ ...f, firstName: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="invite-lastName">Last name *</Label>
                <Input
                  id="invite-lastName"
                  required
                  value={inviteForm.lastName}
                  onChange={(e) => setInviteForm((f) => ({ ...f, lastName: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="invite-email">Email address *</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={inviteForm.email}
                onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            {inviteError && (
              <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
                {inviteError}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={inviteBusy} onClick={() => setInviteTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={inviteBusy} className="bg-brand-navy text-white gap-1">
                <Mail className="w-4 h-4" />
                {inviteBusy ? "Inviting…" : "Send invitation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {inviteResult && (
        <Dialog open onOpenChange={(o) => { if (!o) setInviteResult(null); }}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="brand-wordmark text-xl">
                {inviteResult.status === "reinvited" ? "Client user re-invited" : "Client user invited"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div>
                Portal access for <b>{inviteResult.email}</b> is ready. They now appear in the{" "}
                <Link href="/hr/client-users" className="text-blue-700 hover:underline" onClick={() => setInviteResult(null)}>
                  Client Users
                </Link>{" "}
                list linked to this client.
              </div>
              {inviteResult.emailSent ? (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded">
                  <div className="font-medium">Invitation emailed to the user.</div>
                  <div className="text-xs mt-0.5">They'll be prompted to set a new password on first login.</div>
                </div>
              ) : (
                <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 p-2 rounded space-y-1">
                  <div className="font-medium">Email wasn't sent (SMTP not configured) — share credentials manually.</div>
                  {inviteResult.tempPassword && (
                    <div className="flex items-center gap-2">
                      <span>Temp password:</span>
                      <code className="bg-white border rounded px-1.5 py-0.5">{inviteResult.tempPassword}</code>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => navigator.clipboard.writeText(inviteResult.tempPassword!)}
                        title="Copy temp password"
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                  )}
                  {inviteResult.loginUrl && (
                    <div className="flex items-center gap-2">
                      <span>Login:</span>
                      <a href={inviteResult.loginUrl} className="underline" target="_blank" rel="noreferrer">{inviteResult.loginUrl}</a>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => navigator.clipboard.writeText(inviteResult.loginUrl!)}
                        title="Copy login URL"
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <DialogFooter><Button onClick={() => setInviteResult(null)}>Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <AlertDialog open={!!resetTarget} onOpenChange={(b) => { if (!b && !resetBusy) setResetTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send password reset link?</AlertDialogTitle>
            <AlertDialogDescription>
              This will invalidate any existing reset link for{" "}
              <b>{String(resetTarget?.firstName ?? "")} {String(resetTarget?.lastName ?? "")}</b>{" "}
              ({String(resetTarget?.email ?? "")}) and issue a new single-use link valid for 60 minutes.
              If email is configured the user will be emailed; otherwise you'll get a link to share manually.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {resetError && (
            <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
              {resetError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmPasswordReset(); }}
              disabled={resetBusy}
              className="bg-brand-navy text-white"
            >
              {resetBusy ? "Sending…" : "Send reset link"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {resetResult && (
        <Dialog open onOpenChange={(o) => { if (!o) setResetResult(null); }}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="brand-wordmark text-xl">Password reset link issued</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div>
                For <b>{resetResult.user.firstName} {resetResult.user.lastName}</b> ({resetResult.user.email}).
                Link expires in {resetResult.expiresInMinutes} minutes and can be used once.
              </div>
              {resetResult.emailSent ? (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 p-3 rounded">
                  <div className="font-medium">Reset link emailed to the user.</div>
                  <div className="text-xs mt-0.5">Any previous reset links have been invalidated.</div>
                </div>
              ) : (
                <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 p-2 rounded">
                  Email wasn't sent (SMTP not configured or delivery failed) — copy and share the link manually.
                </div>
              )}
              {resetResult.resetUrl ? (
                <details className="text-xs" open={!resetResult.emailSent}>
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    {resetResult.emailSent ? "Show link (for backup)" : "Reset link"}
                  </summary>
                  <div className="mt-2 flex gap-1">
                    <Input readOnly value={resetResult.resetUrl} />
                    <Button
                      variant="outline"
                      onClick={() => navigator.clipboard.writeText(resetResult.resetUrl!)}
                      title="Copy link"
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                    <a href={resetResult.resetUrl} target="_blank" rel="noreferrer">
                      <Button variant="outline" title="Open link"><ExternalLink className="w-4 h-4" /></Button>
                    </a>
                  </div>
                </details>
              ) : (
                <div className="text-xs text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
                  Server couldn't build a reset URL — set <code>APP_BASE_URL</code> (or <code>REPLIT_DOMAINS</code>) and try again.
                </div>
              )}
            </div>
            <DialogFooter><Button onClick={() => setResetResult(null)}>Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {(geocodeBackfillResult || geocodeBackfillError) && (
        <Dialog open onOpenChange={(o) => { if (!o) { setGeocodeBackfillResult(null); setGeocodeBackfillError(null); } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="brand-wordmark text-xl">Geocode backfill</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              {geocodeBackfillError ? (
                <div className="text-sm text-destructive bg-destructive/5 p-2 rounded border border-destructive/20">
                  {geocodeBackfillError}
                </div>
              ) : geocodeBackfillResult ? (
                <>
                  <div>
                    Checked <b>{geocodeBackfillResult.candidates}</b>{" "}
                    {geocodeBackfillResult.candidates === 1 ? "site" : "sites"}{" "}
                    {geocodeBackfillResult.mode === "refresh_changed"
                      ? "missing or with a changed address."
                      : "missing coordinates."}
                  </div>
                  <div className="flex gap-4">
                    <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 px-3 py-2 rounded flex-1">
                      <div className="text-xs uppercase tracking-wide">Resolved</div>
                      <div className="text-2xl font-semibold">{geocodeBackfillResult.resolved}</div>
                      {(geocodeBackfillResult.refreshed ?? 0) > 0 && (
                        <div className="text-[11px] text-emerald-800/80 mt-0.5">
                          incl. {geocodeBackfillResult.refreshed} refreshed
                        </div>
                      )}
                    </div>
                    <div className="bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 rounded flex-1">
                      <div className="text-xs uppercase tracking-wide">Still unresolved</div>
                      <div className="text-2xl font-semibold">{geocodeBackfillResult.unresolved}</div>
                    </div>
                  </div>
                  {geocodeBackfillResult.unresolvedSites.length > 0 && (
                    <div className="text-xs">
                      <div className="text-muted-foreground mb-1">
                        Couldn't find a match for these — open each one and check the address:
                      </div>
                      <ul className="list-disc pl-5 space-y-0.5">
                        {geocodeBackfillResult.unresolvedSites.map((s) => (
                          <li key={s.id}>{s.name}</li>
                        ))}
                        {geocodeBackfillResult.unresolved > geocodeBackfillResult.unresolvedSites.length && (
                          <li className="text-muted-foreground">
                            …and {geocodeBackfillResult.unresolved - geocodeBackfillResult.unresolvedSites.length} more
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </>
              ) : null}
            </div>
            <DialogFooter>
              <Button onClick={() => { setGeocodeBackfillResult(null); setGeocodeBackfillError(null); }}>
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(b) => { if (!b) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this {singularize(descriptor.label).toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Related records that depend on this row may be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
