import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  Smartphone, Loader2, Copy, Check, Download, Printer, QrCode, AlertTriangle, Link2,
} from "lucide-react";

/**
 * Must match the Expo app's custom scheme (`scheme` in
 * artifacts/security-ops/app.json). The mobile app registers this scheme, so a
 * `<scheme>://connect?code=<code>` link opens it straight to the org-connect
 * screen with the code prefilled.
 */
const APP_SCHEME = "secureopscommand";

type OrgInvite = {
  code: string | null;
  name: string | null;
  appBaseUrl: string | null;
};

function CopyField({ label, value }: { label: string; value: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({
        title: "Couldn't copy",
        description: "Select the text and copy it manually.",
        variant: "destructive",
      });
    }
  }

  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 min-w-0 rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground break-all">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={copy}
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
          <span className="ml-1.5 hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}

export default function OrgInvitePage() {
  const { toast } = useToast();
  const [invite, setInvite] = useState<OrgInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await api<OrgInvite>("/admin/org-invite");
        if (!cancelled) setInvite(data);
      } catch (err) {
        if (!cancelled) {
          toast({
            title: "Couldn't load invite details",
            description: (err as Error).message,
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [toast]);

  const code = invite?.code ?? null;

  // The mobile app accepts BOTH forms: the custom scheme (opens the installed
  // app directly) and the https origin (works as a tappable link and, when
  // scanned, the in-app QR reader extracts the `?code=` either way).
  const appLink = useMemo(
    () => (code ? `${APP_SCHEME}://connect?code=${encodeURIComponent(code)}` : null),
    [code],
  );
  const webLink = useMemo(
    () => (code && invite?.appBaseUrl ? `${invite.appBaseUrl}/connect?code=${encodeURIComponent(code)}` : null),
    [code, invite?.appBaseUrl],
  );

  // Encode the https link in the QR when we have one — phone cameras open https
  // universally, and the in-app scanner reads the code from it too. Fall back to
  // the app-scheme link otherwise.
  const qrTarget = webLink ?? appLink;

  useEffect(() => {
    let cancelled = false;
    if (!qrTarget) { setQrDataUrl(null); return; }
    QRCode.toDataURL(qrTarget, { width: 512, margin: 2, errorCorrectionLevel: "M" })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [qrTarget]);

  function downloadQr() {
    if (!qrDataUrl || !code) return;
    const a = document.createElement("a");
    a.href = qrDataUrl;
    a.download = `invite-${code}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function printQr() {
    if (!qrDataUrl || !code) return;
    const w = window.open("", "_blank", "noopener,noreferrer,width=600,height=800");
    if (!w) {
      toast({
        title: "Couldn't open print window",
        description: "Allow pop-ups for this site, then try again.",
        variant: "destructive",
      });
      return;
    }
    const orgName = invite?.name ?? code;
    w.document.write(`<!doctype html><html><head><title>Invite QR — ${orgName}</title>
      <style>
        body { font-family: system-ui, sans-serif; text-align: center; padding: 48px; color: #0c0a08; }
        h1 { font-size: 22px; margin: 0 0 4px; }
        p { color: #555; margin: 0 0 24px; }
        .code { font-size: 28px; font-weight: 700; letter-spacing: 2px; margin: 24px 0 8px; }
        img { width: 360px; height: 360px; }
        small { color: #777; }
      </style></head><body>
        <h1>Join ${orgName} on SecureOps</h1>
        <p>Scan this code with your phone camera or in the SecureOps app to connect.</p>
        <img src="${qrDataUrl}" alt="Organization invite QR code" />
        <div class="code">${code}</div>
        <small>Or enter organization code <strong>${code}</strong> on the Connect screen.</small>
      </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
          <Smartphone className="w-5 h-5 text-brand-gold" />
          Mobile app invite
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Share this organization code, link, or QR code so staff can connect the
          SecureOps mobile app to your team. After connecting, they sign in with
          their own credentials.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading invite details…
        </div>
      ) : !code ? (
        <Card>
          <CardContent className="py-6">
            <div className="flex items-start gap-3 text-sm">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="space-y-2">
                <p className="font-medium text-foreground">
                  This deployment's organization code isn't configured yet.
                </p>
                <p className="text-muted-foreground">
                  Set an <code className="font-mono">ORG_CODE</code> environment
                  variable on this deployment (a short code like{" "}
                  <code className="font-mono">acme</code>), or register this
                  deployment's URL in the directory's{" "}
                  <code className="font-mono">ORG_DIRECTORY</code>. Once set,
                  reload this page and the invite link and QR code will appear here.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <QrCode className="w-4 h-4" /> Invite QR code
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div ref={printRef} className="flex items-center justify-center">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt={`Invite QR code for organization ${invite?.name ?? code}`}
                    className="w-56 h-56 rounded-lg border border-border bg-white p-2"
                  />
                ) : (
                  <div className="w-56 h-56 rounded-lg border border-border flex items-center justify-center text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin" />
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={downloadQr} disabled={!qrDataUrl}>
                  <Download className="w-4 h-4 mr-1.5" /> Download
                </Button>
                <Button variant="outline" size="sm" className="flex-1" onClick={printQr} disabled={!qrDataUrl}>
                  <Printer className="w-4 h-4 mr-1.5" /> Print
                </Button>
              </div>
              <p className="text-xs text-muted-foreground text-center">
                Staff scan this with their phone camera or the in-app scanner to
                connect instantly.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Link2 className="w-4 h-4" /> Code & links
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Organization code</div>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold tracking-widest text-foreground font-mono">{code}</span>
                  {invite?.name && invite.name !== code && (
                    <span className="text-sm text-muted-foreground">· {invite.name}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Staff can type this on the Connect screen if they can't scan.
                </p>
              </div>

              {webLink && <CopyField label="Invite link (https)" value={webLink} />}
              {appLink && <CopyField label="App link (deep link)" value={appLink} />}

              {!invite?.appBaseUrl && (
                <p className="text-xs text-amber-600 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  Set <code className="font-mono">APP_BASE_URL</code> to also generate
                  a shareable https link.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
