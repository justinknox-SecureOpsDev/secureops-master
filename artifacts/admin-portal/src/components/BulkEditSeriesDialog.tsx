import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";
import { Repeat } from "lucide-react";

export type BulkSeriesTarget = {
  ids: string[];
  title: string;
  siteLabel: string;
};

export function BulkEditSeriesDialog({
  open, onOpenChange, target, onSaved,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  target: BulkSeriesTarget | null;
  onSaved: () => void;
}) {
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [payRate, setPayRate] = useState("");
  const [billRate, setBillRate] = useState("");
  const [licenseLevel, setLicenseLevel] = useState<"" | "2" | "3" | "4">("");
  const [headcount, setHeadcount] = useState("");
  const [notes, setNotes] = useState("");
  const [includeNotes, setIncludeNotes] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStartTime(""); setEndTime(""); setPayRate(""); setBillRate("");
      setLicenseLevel(""); setHeadcount(""); setNotes(""); setIncludeNotes(false);
      setError(null);
    }
  }, [open]);

  if (!target) return null;

  const handleSave = async () => {
    setError(null);
    const changes: Record<string, unknown> = {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
    };
    if (startTime) changes.startTime = startTime;
    if (endTime) changes.endTime = endTime;
    if (payRate !== "") changes.payRate = payRate;
    if (billRate !== "") changes.billRate = billRate;
    if (licenseLevel) changes.requiredLicenseLevel = Number(licenseLevel);
    if (headcount !== "") changes.headcount = headcount;
    if (includeNotes) changes.notes = notes;

    if (Object.keys(changes).length <= 1) {
      setError("Pick at least one field to change.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await api<{ updated: number; total: number }>("/shifts/bulk", {
        method: "PUT",
        body: { ids: target.ids, changes },
      });
      alert(`Updated ${result.updated} of ${result.total} shifts in this series.`);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      const m = e instanceof ApiError
        ? (typeof e.data === "object" && e.data && "message" in e.data
            ? String((e.data as { message: unknown }).message) : e.message)
        : (e as Error).message;
      setError(m || "Failed to update series");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(b) => { if (!submitting) onOpenChange(b); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="w-5 h-5 text-brand-gold" />
            Edit series — {target.title}
          </DialogTitle>
          <DialogDescription>
            {target.siteLabel} · applies to <b>all {target.ids.length} occurrence{target.ids.length === 1 ? "" : "s"}</b> in this series.
            Leave a field blank to keep it unchanged.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start time</Label>
              <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div>
              <Label>End time</Label>
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              {startTime && endTime && endTime <= startTime && (
                <p className="text-xs text-muted-foreground mt-1">Overnight — ends next day.</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Pay rate ($/hr)</Label>
              <Input type="number" step="0.01" placeholder="unchanged" value={payRate} onChange={(e) => setPayRate(e.target.value)} />
            </div>
            <div>
              <Label>Bill rate ($/hr)</Label>
              <Input type="number" step="0.01" placeholder="unchanged" value={billRate} onChange={(e) => setBillRate(e.target.value)} />
            </div>
            <div>
              <Label>Min licence</Label>
              <Select value={licenseLevel} onValueChange={(v) => setLicenseLevel(v as "" | "2" | "3" | "4")}>
                <SelectTrigger><SelectValue placeholder="unchanged" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">Level 2 (unarmed)</SelectItem>
                  <SelectItem value="3">Level 3 (armed)</SelectItem>
                  <SelectItem value="4">Level 4 (PPO)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Headcount</Label>
              <Input type="number" min="1" placeholder="unchanged" value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
              Replace notes
            </label>
            {includeNotes && (
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="New notes (empty clears them)" className="mt-2" />
            )}
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={submitting}
            className="bg-brand-navy text-white hover:opacity-90"
          >
            {submitting ? "Saving…" : `Apply to ${target.ids.length} shift${target.ids.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
