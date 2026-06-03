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
    <div className="flex items-start justify-between py-2 border-b border-white/10 last:border-0">
      <span className="text-white/60 text-sm">{label}</span>
      <span className="text-white text-sm font-medium text-right max-w-[55%] break-all">{value}</span>
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
          <h1 className="text-xl font-bold text-white">Scheduler Integration</h1>
          <p className="text-sm text-white/50">Two-way sync with the Event Staff Scheduler app</p>
        </div>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={loadStatus}
            disabled={loadingStatus}
            className="border-white/20 text-white/70 hover:text-white"
          >
            {loadingStatus ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span className="ml-1">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Connection status card */}
      <div className="bg-white/5 rounded-xl border border-white/10 p-5 space-y-1">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-4 h-4 text-brand-gold" />
          <span className="text-sm font-semibold text-white">Connection Status</span>
        </div>

        {loadingStatus && !status ? (
          <div className="flex items-center gap-2 text-white/50 text-sm py-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : !status?.configured ? (
          <div className="flex items-start gap-3 bg-amber-900/30 border border-amber-600/40 rounded-lg p-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="w-full">
              <p className="text-amber-300 font-medium text-sm">Integration not configured</p>
              <p className="text-amber-200/70 text-xs mt-2">
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
                  <div key={name} className="bg-black/30 rounded p-2">
                    <div className="flex items-center gap-2">
                      <code className="text-amber-200 text-xs font-mono">{name}</code>
                      <span className="text-white/30 text-xs">e.g. {example}</span>
                    </div>
                    <p className="text-white/40 text-xs mt-0.5">{desc}</p>
                  </div>
                ))}
              </div>
              <p className="text-amber-200/50 text-xs mt-3">
                On Replit: open the Secrets panel (🔒), add both variables, then restart the API Server workflow.
                The page will show "Configured" once the server picks them up.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-green-300 text-sm font-medium">Configured</span>
            </div>
            <StatRow label="Scheduler URL" value={status.baseUrl ?? "—"} />
            <StatRow label="Last sync" value={fmtTs(status.lastSyncAt)} />
            <StatRow
              label="Last sync error"
              value={
                status.lastSyncError ? (
                  <span className="text-red-300">{status.lastSyncError}</span>
                ) : (
                  <span className="text-green-400">None</span>
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
            className="border-white/20 text-white/80 hover:text-white"
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
        <div className={`flex items-center gap-2 text-sm p-3 rounded-lg ${testResult.ok ? "bg-green-900/30 text-green-300" : "bg-red-900/30 text-red-300"}`}>
          {testResult.ok ? <CheckCircle className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
          {testResult.ok ? "Connection successful — scheduler responded correctly." : (testResult.error ?? "Connection failed.")}
        </div>
      )}

      {/* Resync result */}
      {resyncResult && (
        <div className="bg-white/5 rounded-xl border border-white/10 p-4 space-y-1">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-brand-gold" />
            <span className="text-sm font-semibold text-white">Last Resync Result</span>
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
      <div className="bg-white/5 rounded-xl border border-white/10 p-5">
        <h2 className="text-sm font-semibold text-white mb-3">How it works</h2>
        <ul className="space-y-2 text-sm text-white/60 list-none">
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-white/80">Outbound (SecureOps → Scheduler):</strong> Every shift create/update/delete and clock in/out fires a signed webhook to the scheduler automatically.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-white/80">Inbound (Scheduler → SecureOps):</strong> The scheduler calls <code className="bg-white/10 px-1 rounded text-xs">/api/scheduler-webhook/shifts</code> and <code className="bg-white/10 px-1 rounded text-xs">/api/scheduler-webhook/clock-events</code> to push changes here.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-white/80">Reconciliation:</strong> Every 15 minutes a safety-net job pulls any missed events from the scheduler and applies them. Use "Resync Now" to run it immediately.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-white/80">Conflict resolution:</strong> Last-write-wins by <code className="bg-white/10 px-1 rounded text-xs">updatedAt</code> timestamp. SecureOps wins on ties within 1 second.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-gold shrink-0">→</span>
            <span><strong className="text-white/80">Loop prevention:</strong> Changes that arrived from the scheduler are tagged and never echoed back, preventing infinite sync loops.</span>
          </li>
        </ul>
        <p className="mt-4 text-xs text-white/40">
          For the full integration contract (endpoint shapes, HMAC signing, identity mapping), see{" "}
          <code className="bg-white/10 px-1 rounded">lib/api-spec/scheduler-integration-contract.md</code> in the codebase.
        </p>
      </div>
    </div>
  );
}
