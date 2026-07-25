import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetAdminDashboardSummary,
  getGetAdminDashboardSummaryQueryKey,
  getGetAnalyticsSummaryQueryOptions,
  useListAdminTasks,
  getListAdminTasksQueryKey,
  useCreateAdminTask,
  useUpdateAdminTask,
  useDeleteAdminTask,
  type AdminTask,
} from "@workspace/api-client-react";
import {
  Users, UserCheck, Calendar, AlertTriangle, DollarSign, Clock,
  BadgeCheck, FileWarning, TrendingUp, TrendingDown, Loader2,
  ListTodo, Plus, Trash2, CheckCircle2, Circle, ChevronDown, ChevronUp,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatDateTime, formatTime } from "@/lib/format";

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Rolling last-30-days window for the financial snapshot. */
function last30Range(): { start: string; end: string } {
  const today = new Date();
  const ago = new Date(today);
  ago.setDate(today.getDate() - 29);
  return { start: toIsoDate(ago), end: toIsoDate(today) };
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function StatCard({
  label, value, sub, icon: Icon, href, colorClass = "text-foreground",
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  colorClass?: string;
}) {
  return (
    <Link
      href={href}
      className="border rounded-lg bg-card p-4 flex flex-col gap-1 transition-colors hover:border-primary/50 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${label}: ${value}${sub ? ` (${sub})` : ""}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </Link>
  );
}

function SectionHeader({ title, sub, linkTo, linkLabel }: {
  title: string;
  sub?: string;
  linkTo?: string;
  linkLabel?: string;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-2">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
      {linkTo && (
        <Link href={linkTo} className="text-xs text-primary hover:underline inline-flex items-center gap-1 shrink-0">
          {linkLabel ?? "View all"} <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-blue-100 text-blue-800",
  medium: "bg-amber-100 text-amber-800",
  high: "bg-orange-100 text-orange-800",
  critical: "bg-red-100 text-red-800",
};

// ── Tasks & reminders panel ───────────────────────────────────────────────────

function dueBadge(task: AdminTask): { label: string; className: string } | null {
  if (!task.dueAt || task.completedAt) return null;
  const due = new Date(task.dueAt);
  const now = new Date();
  if (due.getTime() < now.getTime()) {
    return { label: `Overdue · ${formatDateTime(task.dueAt)}`, className: "bg-red-100 text-red-800" };
  }
  if (due.getTime() - now.getTime() < 24 * 60 * 60 * 1000) {
    return { label: `Due ${formatTime(task.dueAt)}`, className: "bg-amber-100 text-amber-800" };
  }
  return { label: `Due ${formatDate(task.dueAt)}`, className: "bg-muted text-muted-foreground" };
}

function TaskRow({
  task, onToggle, onDelete, busy,
}: {
  task: AdminTask;
  onToggle: (t: AdminTask) => void;
  onDelete: (t: AdminTask) => void;
  busy: boolean;
}) {
  const done = Boolean(task.completedAt);
  const badge = dueBadge(task);
  return (
    <li className="flex items-start gap-2 py-2 border-b last:border-b-0 group">
      <button
        type="button"
        onClick={() => onToggle(task)}
        disabled={busy}
        aria-label={done ? `Reopen task: ${task.title}` : `Complete task: ${task.title}`}
        className="mt-0.5 text-muted-foreground hover:text-primary disabled:opacity-50"
      >
        {done ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Circle className="w-4 h-4" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className={`text-sm ${done ? "line-through text-muted-foreground" : ""}`}>{task.title}</div>
        {task.notes && <div className="text-xs text-muted-foreground truncate">{task.notes}</div>}
        <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
          {badge && <Badge variant="secondary" className={`${badge.className} text-[10px] px-1.5 py-0`}>{badge.label}</Badge>}
          {done && task.completedAt && (
            <span className="text-[10px] text-muted-foreground">Done {formatDate(task.completedAt)}</span>
          )}
          {task.createdByName && (
            <span className="text-[10px] text-muted-foreground">by {task.createdByName}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onDelete(task)}
        disabled={busy}
        aria-label={`Delete task: ${task.title}`}
        className="text-muted-foreground/50 hover:text-destructive disabled:opacity-50"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </li>
  );
}

function TasksPanel() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: tasks, isLoading, isError, queryKey } = useListAdminTasks(undefined, {
    query: { queryKey: getListAdminTasksQueryKey(), refetchInterval: 60_000 },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const createTask = useCreateAdminTask({
    mutation: {
      onSuccess: () => {
        setTitle("");
        setDue("");
        setFormError(null);
        invalidate();
      },
      onError: () => setFormError("Could not add the task. Please try again."),
    },
  });
  const updateTask = useUpdateAdminTask({
    mutation: { onSuccess: invalidate, onError: () => setFormError("Could not update the task. Please try again.") },
  });
  const deleteTask = useDeleteAdminTask({
    mutation: { onSuccess: invalidate, onError: () => setFormError("Could not delete the task. Please try again.") },
  });

  const busy = createTask.isPending || updateTask.isPending || deleteTask.isPending;

  const open = (tasks ?? []).filter((t) => !t.completedAt);
  const completed = (tasks ?? []).filter((t) => t.completedAt);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    createTask.mutate({
      data: {
        title: trimmed,
        dueAt: due ? new Date(due).toISOString() : null,
      },
    });
  };

  return (
    <div className="border rounded-lg bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <ListTodo className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Tasks &amp; Reminders</h2>
        {open.length > 0 && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{open.length} open</Badge>
        )}
      </div>

      <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2 mb-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a task or reminder…"
          maxLength={200}
          aria-label="New task title"
          className="flex-1"
        />
        <Input
          type="datetime-local"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          aria-label="Due date and time (optional)"
          className="sm:w-52"
        />
        <Button type="submit" disabled={!title.trim() || createTask.isPending} className="shrink-0">
          {createTask.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          <span className="ml-1">Add</span>
        </Button>
      </form>
      {formError && <p className="text-xs text-destructive mb-2" role="alert">{formError}</p>}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading tasks…
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive py-4">Failed to load tasks.</p>
      ) : open.length === 0 && completed.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No tasks yet — add your first reminder above.</p>
      ) : (
        <>
          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">All caught up — no open tasks.</p>
          ) : (
            <ul>
              {open.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  busy={busy}
                  onToggle={(task) => updateTask.mutate({ id: task.id, data: { completed: !task.completedAt } })}
                  onDelete={(task) => deleteTask.mutate({ id: task.id })}
                />
              ))}
            </ul>
          )}
          {completed.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowCompleted((s) => !s)}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                {showCompleted ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {completed.length} completed
              </button>
              {showCompleted && (
                <ul className="mt-1">
                  {completed.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      busy={busy}
                      onToggle={(task) => updateTask.mutate({ id: task.id, data: { completed: !task.completedAt } })}
                      onDelete={(task) => deleteTask.mutate({ id: task.id })}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { data: summary, isLoading, isError } = useGetAdminDashboardSummary({
    query: { refetchInterval: 30_000, queryKey: getGetAdminDashboardSummaryQueryKey() },
  });

  const range = useMemo(() => last30Range(), []);
  const { data: fin, isLoading: finLoading, isError: finError } = useQuery({
    ...getGetAnalyticsSummaryQueryOptions(range),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-end justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Dashboard</h1>
          <p className="text-xs text-muted-foreground">
            Live operations overview — refreshes automatically every 30 seconds.
          </p>
        </div>
      </div>

      {isError && (
        <p className="text-sm text-destructive" role="alert">Failed to load dashboard stats.</p>
      )}

      {/* Operations KPIs */}
      <section aria-label="Operations">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard
            label="Active officers"
            value={isLoading ? "—" : summary?.activeEmployees ?? 0}
            sub={summary ? `${summary.pendingEmployees} pending · ${summary.totalEmployees} total` : undefined}
            icon={Users}
            href="/personnel"
          />
          <StatCard
            label="On duty now"
            value={isLoading ? "—" : summary?.clockedInNow ?? 0}
            sub="Clocked in"
            icon={UserCheck}
            href="/dispatch"
            colorClass={summary && summary.clockedInNow > 0 ? "text-emerald-600" : "text-foreground"}
          />
          <StatCard
            label="Upcoming shifts"
            value={isLoading ? "—" : summary?.upcomingShifts ?? 0}
            sub="Next 7 days"
            icon={Calendar}
            href="/shifts"
          />
          <StatCard
            label="Open incidents"
            value={isLoading ? "—" : summary?.openIncidents ?? 0}
            sub={summary && summary.criticalIncidents > 0 ? `${summary.criticalIncidents} critical` : "No critical"}
            icon={AlertTriangle}
            href="/tables/incidents"
            colorClass={summary && summary.criticalIncidents > 0 ? "text-red-600" : "text-foreground"}
          />
          <StatCard
            label="Pending payroll"
            value={isLoading ? "—" : summary?.pendingPayroll ?? 0}
            sub="Entries to review"
            icon={DollarSign}
            href="/payroll/board"
          />
          <StatCard
            label="Expiring licenses"
            value={isLoading ? "—" : summary?.expiringLicenses ?? 0}
            sub="Within 30 days"
            icon={BadgeCheck}
            href="/compliance"
            colorClass={summary && summary.expiringLicenses > 0 ? "text-amber-600" : "text-foreground"}
          />
        </div>
      </section>

      {/* Financial snapshot */}
      <section aria-label="Financials">
        <SectionHeader
          title="Financials"
          sub={`Last 30 days · ${formatDate(range.start)} – ${formatDate(range.end)}`}
          linkTo="/analytics"
          linkLabel="Full analytics"
        />
        {finError ? (
          <p className="text-sm text-destructive" role="alert">Failed to load financials.</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard
              label="Revenue"
              value={finLoading ? "—" : fmtUSD(fin?.revenue ?? 0)}
              icon={TrendingUp}
              href="/analytics"
            />
            <StatCard
              label="Labor cost"
              value={finLoading ? "—" : fmtUSD(fin?.laborCost ?? 0)}
              icon={TrendingDown}
              href="/analytics"
            />
            <StatCard
              label="Profit"
              value={finLoading ? "—" : fmtUSD(fin?.pnl ?? 0)}
              sub={fin && fin.marginPct !== null ? `${fmtPct(fin.marginPct)} margin` : undefined}
              icon={DollarSign}
              href="/analytics"
              colorClass={fin && fin.pnl < 0 ? "text-red-600" : "text-emerald-600"}
            />
            <StatCard
              label="Hours worked"
              value={finLoading ? "—" : `${(fin?.hoursWorked ?? 0).toFixed(1)} h`}
              sub={fin && fin.coveragePct !== null ? `${fmtPct(fin.coveragePct)} shift coverage` : undefined}
              icon={Clock}
              href="/analytics"
            />
          </div>
        )}
      </section>

      {/* Tasks + lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <TasksPanel />

        <div className="space-y-4">
          <div className="border rounded-lg bg-card p-4">
            <SectionHeader title="Recent incidents" linkTo="/tables/incidents" />
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : (summary?.recentIncidents ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No incidents reported.</p>
            ) : (
              <ul>
                {(summary?.recentIncidents ?? []).map((inc) => (
                  <li key={inc.id} className="py-2 border-b last:border-b-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className={`${SEVERITY_COLORS[inc.severity] ?? ""} text-[10px] px-1.5 py-0 shrink-0`}>
                        {inc.severity}
                      </Badge>
                      <span className="text-sm truncate">{inc.title}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {inc.employeeName ? `${inc.employeeName} · ` : ""}{formatDateTime(inc.occurredAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border rounded-lg bg-card p-4">
            <SectionHeader title="Next shifts" linkTo="/shifts" />
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : (summary?.upcomingShiftsList ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No upcoming shifts scheduled.</p>
            ) : (
              <ul>
                {(summary?.upcomingShiftsList ?? []).map((s) => (
                  <li key={s.id} className="py-2 border-b last:border-b-0">
                    <div className="flex items-center gap-2">
                      <FileWarning className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
                      <span className="text-sm truncate">{s.title}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {s.siteName ? `${s.siteName} · ` : ""}{formatDateTime(s.startTime)} – {formatTime(s.endTime)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default DashboardPage;
