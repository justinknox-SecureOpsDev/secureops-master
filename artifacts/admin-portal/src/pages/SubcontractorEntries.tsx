import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { RefreshCw, Download, Clock, AlertTriangle, Pencil } from "lucide-react";

type Entry = {
  id: string;
  siteId: string;
  siteName: string | null;
  name: string;
  company: string;
  badgeId: string | null;
  clockInAt: string;
  clockOutAt: string | null;
  hoursWorked: string | null;
  notes: string | null;
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Convert an ISO string to a value suitable for <input type="datetime-local">
// (local time, no timezone, "YYYY-MM-DDTHH:mm").
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Convert a datetime-local value back to an ISO string (interpreting it as local time).
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function exportCsv(entries: Entry[]): void {
  const headers = ["ID", "Name", "Company", "Badge ID", "Site", "Clock In", "Clock Out", "Hours"];
  const rows = entries.map((e) => [
    e.id,
    e.name,
    e.company,
    e.badgeId ?? "",
    e.siteName ?? "",
    e.clockInAt,
    e.clockOutAt ?? "",
    e.hoursWorked ?? "",
  ]);
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `subcontractor-entries-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SubcontractorEntriesPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [version, setVersion] = useState(0);

  const [forceClockOutTarget, setForceClockOutTarget] = useState<Entry | null>(null);
  const [forceClockOutBusy, setForceClockOutBusy] = useState(false);
  const [forceClockOutError, setForceClockOutError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<Entry | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    company: "",
    badgeId: "",
    clockInAt: "",
    clockOutAt: "",
    notes: "",
  });
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  function openEdit(e: Entry) {
    setEditTarget(e);
    setEditError(null);
    setEditForm({
      name: e.name,
      company: e.company,
      badgeId: e.badgeId ?? "",
      clockInAt: isoToLocalInput(e.clockInAt),
      clockOutAt: isoToLocalInput(e.clockOutAt),
      notes: e.notes ?? "",
    });
  }

  async function handleEditSave() {
    if (!editTarget) return;
    if (!editForm.name.trim()) { setEditError("Name is required."); return; }
    if (!editForm.company.trim()) { setEditError("Company is required."); return; }
    if (!editForm.clockInAt) { setEditError("Clock-in time is required."); return; }

    const clockInIso = localInputToIso(editForm.clockInAt);
    if (!clockInIso) { setEditError("Clock-in time is invalid."); return; }

    let clockOutIso: string | null = null;
    if (editForm.clockOutAt) {
      clockOutIso = localInputToIso(editForm.clockOutAt);
      if (!clockOutIso) { setEditError("Clock-out time is invalid."); return; }
      if (new Date(clockOutIso).getTime() <= new Date(clockInIso).getTime()) {
        setEditError("Clock-out must be after clock-in.");
        return;
      }
    }

    setEditBusy(true);
    setEditError(null);
    try {
      await api(`/admin/subcontractor-entries/${editTarget.id}`, {
        method: "PATCH",
        body: {
          name: editForm.name.trim(),
          company: editForm.company.trim(),
          badgeId: editForm.badgeId.trim() ? editForm.badgeId.trim() : null,
          clockInAt: clockInIso,
          clockOutAt: clockOutIso,
          notes: editForm.notes.trim() ? editForm.notes.trim() : null,
        },
      });
      setEditTarget(null);
      refresh();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditBusy(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params: Record<string, string> = {};
    if (dateFrom) params.dateFrom = new Date(dateFrom).toISOString();
    if (dateTo) params.dateTo = new Date(dateTo + "T23:59:59").toISOString();
    const qs = new URLSearchParams(params).toString();
    api<Entry[]>(`/admin/subcontractor-entries${qs ? `?${qs}` : ""}`)
      .then((data) => setEntries(data))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, version]);

  async function handleForceClockOut() {
    if (!forceClockOutTarget) return;
    setForceClockOutBusy(true);
    setForceClockOutError(null);
    try {
      await api(`/admin/subcontractor-entries/${forceClockOutTarget.id}/clock-out`, {
        method: "PATCH",
        body: {},
      });
      setForceClockOutTarget(null);
      refresh();
    } catch (e) {
      setForceClockOutError((e as Error).message);
    } finally {
      setForceClockOutBusy(false);
    }
  }

  const openEntries = entries.filter((e) => !e.clockOutAt);
  const closedEntries = entries.filter((e) => e.clockOutAt);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "#080c18" }}>Subcontractor Entries</h1>
          <p className="text-sm text-muted-foreground">QR clock-in records for non-system subcontractors</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportCsv(entries)} disabled={entries.length === 0}>
            <Download className="w-4 h-4 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 flex-wrap items-end">
        <div className="space-y-1">
          <Label className="text-xs">From date</Label>
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To date</Label>
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-40" />
        </div>
        {(dateFrom || dateTo) && (
          <Button variant="ghost" size="sm" onClick={() => { setDateFrom(""); setDateTo(""); }}>
            Clear
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Open entries */}
      {openEntries.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-amber-700 flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Currently Clocked In ({openEntries.length})
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-amber-50 border-b">
                <tr>
                  <th className="text-left p-3 font-medium">Name</th>
                  <th className="text-left p-3 font-medium">Company</th>
                  <th className="text-left p-3 font-medium">Badge ID</th>
                  <th className="text-left p-3 font-medium">Site</th>
                  <th className="text-left p-3 font-medium">Clock In</th>
                  <th className="text-left p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {openEntries.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="p-3 font-medium">{e.name}</td>
                    <td className="p-3 text-muted-foreground">{e.company}</td>
                    <td className="p-3 text-muted-foreground">{e.badgeId ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{e.siteName ?? "—"}</td>
                    <td className="p-3">{fmtDateTime(e.clockInAt)}</td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEdit(e)}
                        >
                          <Pencil className="w-3.5 h-3.5 mr-1" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-amber-700 border-amber-300 hover:bg-amber-50"
                          onClick={() => { setForceClockOutTarget(e); setForceClockOutError(null); }}
                        >
                          Force Clock-Out
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Completed entries */}
      <div className="space-y-2">
        <div className="text-sm font-semibold text-slate-700">
          Completed Entries ({closedEntries.length})
        </div>
        {loading ? (
          <div className="text-sm text-muted-foreground p-4">Loading…</div>
        ) : closedEntries.length === 0 ? (
          <div className="text-sm text-muted-foreground p-4 text-center border rounded-lg bg-slate-50">
            No completed entries for the selected date range.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b">
                <tr>
                  <th className="text-left p-3 font-medium">Name</th>
                  <th className="text-left p-3 font-medium">Company</th>
                  <th className="text-left p-3 font-medium">Badge ID</th>
                  <th className="text-left p-3 font-medium">Site</th>
                  <th className="text-left p-3 font-medium">Clock In</th>
                  <th className="text-left p-3 font-medium">Clock Out</th>
                  <th className="text-left p-3 font-medium">Hours</th>
                  <th className="text-left p-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {closedEntries.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="p-3 font-medium">{e.name}</td>
                    <td className="p-3 text-muted-foreground">{e.company}</td>
                    <td className="p-3 text-muted-foreground">{e.badgeId ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{e.siteName ?? "—"}</td>
                    <td className="p-3">{fmtDateTime(e.clockInAt)}</td>
                    <td className="p-3">{fmtDateTime(e.clockOutAt)}</td>
                    <td className="p-3 font-medium">{e.hoursWorked ? `${e.hoursWorked} hrs` : "—"}</td>
                    <td className="p-3">
                      <Button variant="outline" size="sm" onClick={() => openEdit(e)}>
                        <Pencil className="w-3.5 h-3.5 mr-1" />
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit entry dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Clock-In Entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Company</Label>
                <Input
                  value={editForm.company}
                  onChange={(e) => setEditForm((f) => ({ ...f, company: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Badge ID</Label>
              <Input
                value={editForm.badgeId}
                onChange={(e) => setEditForm((f) => ({ ...f, badgeId: e.target.value }))}
                placeholder="Optional"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Clock In</Label>
                <Input
                  type="datetime-local"
                  value={editForm.clockInAt}
                  onChange={(e) => setEditForm((f) => ({ ...f, clockInAt: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Clock Out</Label>
                <Input
                  type="datetime-local"
                  value={editForm.clockOutAt}
                  onChange={(e) => setEditForm((f) => ({ ...f, clockOutAt: e.target.value }))}
                />
                <p className="text-[11px] text-muted-foreground">Leave blank to keep the entry open.</p>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes</Label>
              <Input
                value={editForm.notes}
                onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional"
              />
            </div>
            {editError && (
              <div className="text-red-600 bg-red-50 border border-red-200 rounded p-2 text-xs">
                {editError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={editBusy}>
              Cancel
            </Button>
            <Button
              style={{ background: "#080c18", color: "#f0e6c8" }}
              onClick={handleEditSave}
              disabled={editBusy}
            >
              {editBusy ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Force clock-out dialog */}
      <Dialog open={!!forceClockOutTarget} onOpenChange={(open) => { if (!open) setForceClockOutTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force Clock-Out</DialogTitle>
          </DialogHeader>
          <div className="text-sm space-y-2">
            <p>
              Clock out <strong>{forceClockOutTarget?.name}</strong> ({forceClockOutTarget?.company}) now?
            </p>
            <p className="text-muted-foreground">
              This will record the current time as the clock-out time. Use this for stuck entries where the subcontractor was unable to clock out themselves.
            </p>
            {forceClockOutError && (
              <div className="text-red-600 bg-red-50 border border-red-200 rounded p-2 text-xs">
                {forceClockOutError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForceClockOutTarget(null)} disabled={forceClockOutBusy}>
              Cancel
            </Button>
            <Button
              style={{ background: "#080c18", color: "#f0e6c8" }}
              onClick={handleForceClockOut}
              disabled={forceClockOutBusy}
            >
              {forceClockOutBusy ? "Clocking out…" : "Confirm Clock-Out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
