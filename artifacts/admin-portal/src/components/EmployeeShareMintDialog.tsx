import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Link2 } from "lucide-react";

export type VisibleSections = {
  license: boolean;
  experience: boolean;
  skills: boolean;
  uniform: boolean;
  trainingCerts: boolean;
  documents: boolean;
};

// Matches the server default in `lib/db/src/schema/employeeShareLinks.ts`.
// Every optional section is enabled, which preserves the historical
// "redacted but everything-optional-shown" share behaviour.
const DEFAULT_SECTIONS: VisibleSections = {
  license: true,
  experience: true,
  skills: true,
  uniform: true,
  trainingCerts: true,
  documents: true,
};

const SECTION_LABELS: Array<[keyof VisibleSections, string, string]> = [
  ["license", "TX security license", "License number, level, expiry, and any extra licenses on record."],
  ["experience", "Experience", "Years of experience and the prior-experience narrative."],
  ["skills", "Skills & qualifications", "The officer's skills tag list."],
  ["uniform", "Uniform sizes", "Shirt, trousers, jacket, boots — useful when prepping kit."],
  ["trainingCerts", "Training certificates", "Filenames of training certs on file (no downloads)."],
  ["documents", "Documents on file", "Filenames of CV, license scan, passport, right-to-work, pay stub (no downloads)."],
];

/**
 * Mint dialog for an officer-profile share link. Lets the admin pick
 * recipient label, expiry window, and exactly which sections the
 * recipient will see. Submits to `POST /admin/employees/:id/share`
 * and copies the URL to the clipboard on success.
 */
export function EmployeeShareMintDialog({
  open, onOpenChange, employeeUserId, employeeName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employeeUserId: string;
  employeeName?: string;
}) {
  const { toast } = useToast();
  const [recipientLabel, setRecipientLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [sections, setSections] = useState<VisibleSections>({ ...DEFAULT_SECTIONS });
  const [busy, setBusy] = useState(false);

  function reset() {
    setRecipientLabel("");
    setExpiresInDays(30);
    setSections({ ...DEFAULT_SECTIONS });
  }

  async function submit() {
    if (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 365) {
      toast({ title: "Invalid expiry", description: "Pick between 1 and 365 days.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const created = await api<{ url: string }>(
        `/admin/employees/${employeeUserId}/share`,
        {
          method: "POST",
          body: JSON.stringify({
            expiresInDays,
            recipientLabel: recipientLabel.trim() || null,
            visibleSections: sections,
          }),
        },
      );
      try { await navigator.clipboard?.writeText(created.url); } catch { /* clipboard blocked */ }
      toast({
        title: "Share link created",
        description: "Copied to clipboard. Manage at Officer shares in the sidebar.",
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Could not create share link", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) { onOpenChange(v); if (!v) reset(); } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 brand-navy">
            <Link2 className="w-4 h-4 brand-gold" />
            Share profile with a client
          </DialogTitle>
          <DialogDescription>
            Mint a no-login link {employeeName ? `for ${employeeName}` : ""}.
            Contact info, SSN, banking, emergency contact, references and
            acknowledgements are always hidden — pick which other sections
            this recipient should see.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="share-recipient">Recipient label (optional)</Label>
            <Input
              id="share-recipient"
              placeholder="Acme Mall — Janet Park"
              value={recipientLabel}
              onChange={(e) => setRecipientLabel(e.target.value)}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">Only you see this — it's for your records.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="share-expiry">Expires in (days)</Label>
            <Input
              id="share-expiry"
              type="number"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
              disabled={busy}
              className="w-32"
            />
          </div>

          <div className="space-y-2">
            <Label>Sections visible to recipient</Label>
            <div className="rounded-md border p-3 space-y-2.5">
              {SECTION_LABELS.map(([key, label, hint]) => (
                <label key={key} className="flex items-start gap-3 cursor-pointer">
                  <Checkbox
                    checked={sections[key]}
                    onCheckedChange={(v) =>
                      setSections((s) => ({ ...s, [key]: v === true }))
                    }
                    disabled={busy}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium brand-navy">{label}</div>
                    <div className="text-xs text-muted-foreground leading-snug">{hint}</div>
                  </div>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Name, photo, and right-to-work status are always shown.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-brand-navy text-white hover:opacity-90">
            {busy ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />Creating…</> : "Create share link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
