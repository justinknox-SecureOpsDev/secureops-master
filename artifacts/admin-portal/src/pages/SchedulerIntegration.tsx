import { useState, useCallback, useEffect } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw, CheckCircle, XCircle, Loader2, Calendar, Clock,
  ArrowLeftRight, AlertTriangle,
} from "lucide-react";

type SchedulerStatus = {
  configured: boolean;
  baseUrl: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncShiftsProcessed: string;
  lastSyncEventsProcessed: string;
  shiftsCursor: string;
  eventsCursor: string;
};

const SYNC_STALE_MS = 30 * 60 * 1000;

type TestResult = { ok: boolean; error?: string };
type ResyncResult = {
  ok: boolean;
  shiftsCreated: number; shiftsUpdated: number; shiftsDeleted: number; shiftsSkipped: number;
  eventsCreated: number; eventsUpdated: number; eventsDeleted: number; eventsSkipped: number;
  since: string;
  nextCursor: string;
  error?: string;
};

function fmtTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-border last:border-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-foreground text-sm font-medium text-right max-w-[55%] break-all">{value}</span>
    </div>
  );
}

export default function SchedulerIntegrationPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [testingConn, setTestingConn] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [resyncResult, setResyncResult] = useState<ResyncResult | null>(null);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const data = await api<SchedulerStatus>("/admin/scheduler/status");
      setStatus(data);
    } catch (err) {
      toast({ title: "Could not load scheduler status", description: (err as Error).message, variant: "destructive" });
    } finally {
      setLoadingStatus(false);
    }
  }, [toast]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  async function testConnection() {
    setTestingConn(true);
    setTestResult(null);
    try {
      await api<{ ok: boolean }>("/admin/scheduler/test", { method: "POST" });
      setTestResult({ ok: true });
      toast({ title: "Connection successful", description: "Scheduler responded correctly." });
    } catch (err) {
      const msg = (err as Error).message;
      setTestResult({ ok: false, error: msg });
      toast({ title: "Connection failed", description: msg, variant: "destructive" });
    } finally {
      setTestingConn(false);
    }
  }

  async function triggerResync() {
    setResyncing(true);
    setResyncResult(null);
    try {
      const result = await api<ResyncResult>("/admin/scheduler/resync", { method: "POST" });
      setResyncResult(result);
      const total =
        result.shiftsCreated + result.shiftsUpdated + result.shiftsDeleted +
        result.eventsCreated + result.eventsUpdated + result.eventsDeleted;
      toast({
        title: total > 0 ? `Resync complete — ${total} change${total !== 1 ? "s" : ""} applied` : "Resync complete — nothing new",
        description: total > 0
          ? `Shifts: +${result.shiftsCreated} ~${result.shiftsUpdated} -${result.shiftsDeleted}  ·  Events: +${result.eventsCreated} ~${result.eventsUpdated} -${result.eventsDeleted}`
          : "The cursor is up to date.",
      });
      // Refresh status panel after resync
      void loadStatus();
    } catch (err) {
      toast({ title: "Resync failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setResyncing(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-brand-gold/20 flex items-center justify-center">
          <ArrowLeftRight className="w-5 h-5 text-brand-gold" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Scheduler Integration</h1>
          <p className="text-sm text-muted-foreground">Two-way sync with the Event Staff Scheduler app</p>
        </div>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={loadStatus}
            disabled={loadingStatus}
          >
            {loadingStatus ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span className="ml-1">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Connection status card */}
      <div className="bg-card rounded-xl border border-border p-5 space-y-1">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-4 h-4 text-brand-gold" />
          <span className="text-sm font-semibold text-foreground">Connection Status</span>
        </div>

        {loadingStatus && !status ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : !status?.configured ? (
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-300 rounded-lg p-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div className="w-full">
              <p className="text-amber-900 font-medium text-sm">Integration not configured</p>
              <p className="text-amber-800/80 text-xs mt-2">
                Set the following environment variables on the API server to enable two-way sync.
                These values are provided by your Event Staff Scheduler administrator.
                Because they contain a shared secret, they must be set as server environment variables
                (not stored in the database).
              </p>
              <div className="mt-3 space-y-1">
                {[
                  { name: "SCHEDULER_BASE_URL", example: "https://scheduler.example.com", desc: "Base URL of the scheduler app (no trailing slash)" },
                  { name: "SCHEDULER_SHARED_SECRET", example: "a-long-random-secret", desc: "HMAC-SHA256 signing secret, shared with the scheduler" },
                ].map(({ name, example, desc }) => (
                  <div key={name} className="bg-muted rounded p-2">
                    <div className="flex items-center gap-2">
                      <code className="text-amber-900 text-xs font-mono">{name}</code>
                      <span className="text-muted-foreground text-xs">e.g. {example}</span>
                    </div>
                    <p className="text-muted-foreground text-xs mt-0.5">{desc}</p>
                  </div>
                ))}
              </div>
              <p className="text-amber-800/70 text-xs mt-3">
                On Replit: open the Secrets panel (🔒), add both variables, then restart the API Server workflow.
                The page will show "Configured" once the server picks them up.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {(() => {
              const overdue =
                !status.lastSyncAt ||
                Date.now() - new Date(status.lastSyncAt).getTime() > SYNC_STALE_MS;
              const unhealthy = Boolean(status.lastSyncError) || overdue;
              return unhealthy ? (
                <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
                  <XCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-red-700 font-medium text-sm">
                      {status.lastSyncError ? "Last sync failed" : "Sync is overdue"}
                    </p>
                    <p className="text-red-600/80 text-xs mt-1">
                      {status.lastSyncError
                        ? "The most recent sync recorded an error. Resync now or check the scheduler connection."
                        : `No successful sync in over 30 minutes (last: ${fmtTs(status.lastSyncAt)}). The reconciliation job may be stalled or the scheduler unreachable.`}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                  <span className="text-green-700 text-sm font-medium">Configured · healthy</span>
                </div>
              );
            })()}
            <StatRow label="Scheduler URL" value={status.baseUrl ?? "—"} />
            <StatRow
              label="Last sync"
              value={
                !status.lastSyncAt ||
                Date.now() - new Date(status.lastSyncAt).getTime() > SYNC_STALE_MS ? (
                  <span className="text-red-600">{fmtTs(status.lastSyncAt)}</span>
                ) : (
                  fmtTs(status.lastSyncAt)
                )
              }
            />
            <StatRow
              label="Last sync error"
              value={
                status.lastSyncError ? (
                  <span className="text-red-600">{status.lastSyncError}</span>
                ) : (
                  <span className="text-green-700">None</span>
                )
              }
            />
            <StatRow label="Shifts processed (last run)" value={status.lastSyncShiftsProcessed} />
            <StatRow label="Clock events processed (last run)" value={status.lastSyncEventsProcessed} />
            <StatRow label="Shifts cursor" value={<span className="font-mono text-xs">{fmtTs(status.shiftsCursor)}</span>} />
          </div>
        )}
      </div>

      {/* Actions */}
      {status?.configured && (
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={testConnection}
            disabled={testingConn}
            variant="outline"
          >
            {testingConn ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Testing…</>
            ) : (
              <><CheckCircle className="w-4 h-4 mr-2" /> Test Connection</>
            )}
          </Button>

          <Button
            onClick={triggerResync}
            disabled={resyncing}
            className="bg-brand-gold hover:bg-brand-gold/90 text-brand-navy font-semibold"
          >
            {resyncing ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Resyncing…</>
            ) : (
              <><RefreshCw className="w-4 h-4 mr-2" /> Resync Now</>
            )}
          </Button>
        </div>
      )}

      {/* Test result inline feedback */}
      {testResult && (
        <div className={`flex items-center gap-2 text-sm p-3 rounded-lg border ${testResult.ok ? "bg-green-50 border-green-200 text-green-700" : "bg-red-50 border-red-200 text-red-700"}`}>
          {testResult.ok ? <CheckCircle className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
          {testResult.ok ? "Connection successful — scheduler responded correctly." : (testResult.error ?? "Connection failed.")}
        </div>
      )}

      {/* Resync result */}
      {resyncResult && (
        <div className="bg-card rounded-xl border border-border p-4 space-y-1">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-brand-gold" />
            <span className="text-sm font-semibold text-foreground">Last Resync Result</span>
          </div>
          <StatRow label="Shifts created / updated / deleted / skipped"
            value={`${resyncResult.shiftsCreated} / ${resyncResult.shiftsUpdated} / ${resyncResult.shiftsDeleted} / ${resyncResult.shiftsSkipped}`} />
          <StatRow label="Clock events created / updated / deleted / skipped"
            value={`${resyncResult.eventsCreated} / ${resyncResult.eventsUpdated} / ${resyncResult.eventsDeleted} / ${resyncResult.eventsSkipped}`} />
          <StatRow label="Pulled since" value={<span className="font-mono text-xs">{fmtTs(resyncResult.since)}</span>} />
          <StatRow label="New cursor" value={<span className="font-mono text-xs">{fmtTs(resyncResult.nextCursor)}</span>} />
        </div>
      )}

      {/* How it works */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-3">How it works</h2>
        <ul className="space-y-2 text-sm text-muted-foreground list-none">
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-foreground">Outbound (SecureOps → Scheduler):</strong> Every shift create/update/delete and clock in/out fires a signed webhook to the scheduler automatically.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-foreground">Inbound (Scheduler → SecureOps):</strong> The scheduler calls <code className="bg-muted px-1 rounded text-xs">/api/scheduler-webhook/shifts</code> and <code className="bg-muted px-1 rounded text-xs">/api/scheduler-webhook/clock-events</code> to push changes here.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-foreground">Reconciliation:</strong> Every 15 minutes a safety-net job pulls any missed events from the scheduler and applies them. Use "Resync Now" to run it immediately.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-foreground">Conflict resolution:</strong> Last-write-wins by <code className="bg-muted px-1 rounded text-xs">updatedAt</code> timestamp. SecureOps wins on ties within 1 second.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-foreground">Loop prevention:</strong> Changes that arrived from the scheduler are tagged and never echoed back, preventing infinite sync loops.</span>
          </li>
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          For the full integration contract (endpoint shapes, HMAC signing, identity mapping), see{" "}
          <code className="bg-muted px-1 rounded">lib/api-spec/scheduler-integration-contract.md</code> in the codebase.
        </p>
      </div>
    </div>
  );
}
