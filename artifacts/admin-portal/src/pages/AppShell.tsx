import { useState, useEffect } from "react";
import { Link, useRoute, useLocation } from "wouter";
import {
  LogOut, ClipboardList, UserPlus, FileText, ChevronsLeft, ChevronsRight,
  Database, Banknote, ChevronDown, ChevronRight, Receipt, Wallet, MailPlus,
  AlertTriangle, ShieldCheck, Repeat, KeyRound, IdCard, Link2, Download,
  Radio as RadioIcon, Radar, MessageCircle, Users as UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { TABLES } from "@/lib/tables";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

type SystemStatus = {
  env: string;
  smtpConfigured: boolean;
  sessionSecretOk: boolean;
  baseUrlConfigured: boolean;
  corsOriginsConfigured: boolean;
  geofenceRadiusMiles?: number;
};

function useSystemStatus(role: string | undefined) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  useEffect(() => {
    if (role !== "admin") return; // dispatcher is blocked from system status
    let cancelled = false;
    const token = (() => { try { return localStorage.getItem("wcsg.adminToken") || ""; } catch { return ""; } })();
    if (!token) return;
    fetch("/api/admin/system/status", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data) setStatus(data); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [role]);
  return status;
}

function SystemBanner({ status }: { status: SystemStatus | null }) {
  if (!status) return null;
  const issues: string[] = [];
  if (!status.smtpConfigured) issues.push("Email is not configured — invite, onboarding, password-reset and amendment links will NOT be sent automatically.");
  if (!status.baseUrlConfigured) issues.push("APP_BASE_URL / REPLIT_DOMAINS is not set — outgoing email links cannot be built.");
  if (!status.corsOriginsConfigured) issues.push("CORS origins are not configured — browser clients will be blocked in production.");
  if (!status.sessionSecretOk) issues.push("SESSION_SECRET is missing or too short — sessions are insecure.");
  if (issues.length === 0) return null;
  return (
    <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-xs px-4 py-2 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div>
        <div className="font-semibold">Action required — degraded configuration ({status.env}).</div>
        <ul className="list-disc pl-5 mt-1 space-y-0.5">
          {issues.map((i) => <li key={i}>{i}</li>)}
        </ul>
      </div>
    </div>
  );
}

const COLLAPSE_KEY = "wcsg.sidebarCollapsed";
const SECTIONS_KEY = "wcsg.sidebarSections";

type LinkItem = { href: string; label: string; Icon: LucideIcon; badge?: string };

// Tables surfaced under "Accounting" — kept out of the generic Operations list.
const ACCOUNTING_TABLE_NAMES = new Set(["payroll_entries", "invoices"]);

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [match, params] = useRoute("/tables/:table");
  const [location] = useLocation();
  const activeTable = match ? params?.table : null;
  const isDispatcher = user?.role === "dispatcher";
  const systemStatus = useSystemStatus(user?.role);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);

  // Per-section open/closed state (persisted). Defaults: all open.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(SECTIONS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { hr: true, accounting: true, operations: true };
  });
  useEffect(() => {
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(openSections)); } catch {}
  }, [openSections]);
  const toggleSection = (key: string) =>
    setOpenSections((s) => ({ ...s, [key]: !s[key] }));

  const hrLinks: LinkItem[] = [
    { href: "/hr/applications", label: "Applications", Icon: ClipboardList },
    { href: "/hr/onboarding", label: "Onboarding", Icon: UserPlus },
    { href: "/hr/invitations", label: "Invitations", Icon: MailPlus },
    { href: "/hr/license-renewals", label: "License renewals", Icon: IdCard },
    { href: "/hr/policies", label: "Policies", Icon: FileText },
  ];

  const accountingLinks: LinkItem[] = [
    { href: "/payroll/board", label: "Payroll Board", Icon: Wallet },
    { href: "/payroll/pay-run", label: "Pay Run", Icon: Banknote },
    { href: "/tables/invoices", label: "Invoices", Icon: Receipt },
    { href: "/tables/payroll_entries", label: "Payroll", Icon: Wallet },
  ];

  const securityLinks: LinkItem[] = [
    { href: "/chat", label: "Chat", Icon: MessageCircle },
    { href: "/personnel", label: "Personnel", Icon: UsersIcon },
    { href: "/radio", label: "Radio", Icon: RadioIcon },
    { href: "/dar", label: "Daily Reports", Icon: ClipboardList },
    { href: "/compliance", label: "Compliance", Icon: ShieldCheck },
    { href: "/audit-log", label: "Audit Log", Icon: ShieldCheck },
    { href: "/swap-requests", label: "Swap Requests", Icon: Repeat },
    { href: "/incidents/share-links", label: "Incident shares", Icon: Link2 },
    { href: "/personnel/share-links", label: "Officer shares", Icon: Link2 },
    { href: "/exports", label: "Exports", Icon: Download },
    { href: "/account/security", label: "My 2FA", Icon: KeyRound },
  ];

  const operationsTables = TABLES.filter((t) => !ACCOUNTING_TABLE_NAMES.has(t.name));

  // Dispatchers see a narrow side nav: Dispatch + Shifts board + Radio
  // + their own 2FA. Personnel and incidents are reached through the
  // Dispatch page itself, which uses dedicated dispatcher-safe read
  // endpoints (`/dispatch/*`, `/employees`, `/sites`) — the generic
  // `/admin/tables/*` grid stays admin-only.
  const dispatcherOpsTables = operationsTables.filter((t) => t.name === "shifts");

  const dispatchLink: LinkItem = { href: "/dispatch", label: "Dispatch", Icon: Radar };
  const dispatcherCoreLinks: LinkItem[] = [
    { href: "/chat", label: "Chat", Icon: MessageCircle },
    { href: "/personnel", label: "Personnel", Icon: UsersIcon },
  ];
  const dispatcherSecurityLinks: LinkItem[] = [
    { href: "/radio", label: "Radio", Icon: RadioIcon },
    { href: "/account/security", label: "My 2FA", Icon: KeyRound },
  ];

  const renderLink = ({ href, label, Icon, badge }: LinkItem) => {
    const active = location === href;
    return (
      <Link
        key={href}
        href={href}
        title={collapsed ? label : undefined}
        className={`flex items-center text-sm border-l-2 transition-colors ${
          collapsed ? "justify-center px-0 py-2.5" : "gap-2 px-4 py-2"
        } ${
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary"
            : "border-transparent hover:bg-sidebar-accent/50"
        }`}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {!collapsed && (
          <span className="flex-1 flex items-center justify-between">
            <span>{label}</span>
            {badge && <span className="text-[9px] brand-gold opacity-80">{badge}</span>}
          </span>
        )}
      </Link>
    );
  };

  const SectionHeader = ({ id, label }: { id: string; label: string }) => {
    const open = openSections[id] !== false;
    return (
      <button
        type="button"
        onClick={() => toggleSection(id)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-widest opacity-60 hover:opacity-100 hover:bg-sidebar-accent/30 transition-colors"
      >
        <span>{label}</span>
        {open
          ? <ChevronDown className="w-3 h-3" />
          : <ChevronRight className="w-3 h-3" />}
      </button>
    );
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside
        className={`shrink-0 bg-sidebar text-sidebar-foreground flex flex-col transition-[width] duration-200 ease-out ${
          collapsed ? "w-16" : "w-64"
        }`}
      >
        <div className={`border-b border-sidebar-border ${collapsed ? "p-3" : "p-5"}`}>
          <div className={`flex items-center ${collapsed ? "justify-center" : "gap-2"}`}>
            <img
              src={`${import.meta.env.BASE_URL}logo-256.png`}
              alt="WCSG"
              className="w-9 h-9 shrink-0 rounded-md object-contain"
            />
            {!collapsed && (
              <div>
                <div className="brand-wordmark text-sm leading-tight">Williams Council</div>
                <div className="brand-wordmark text-sm leading-tight brand-gold">Security Group Inc.</div>
              </div>
            )}
          </div>
          {!collapsed && (
            <div className="flex items-center gap-1.5 mt-2">
              <div className="text-[10px] uppercase tracking-widest opacity-60">Admin Portal</div>
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded-sm bg-brand-gold/20 brand-gold border border-brand-gold/40">
                Beta
              </span>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto py-3">
          {/* Dispatch — pinned at top for both admin and dispatcher. */}
          {renderLink(dispatchLink)}

          {/* Dispatchers see a narrow read-only nav only. */}
          {isDispatcher && (
            <>
              {dispatcherCoreLinks.map(renderLink)}

              {!collapsed
                ? <div className="mt-2"><SectionHeader id="security" label="Security" /></div>
                : <div className="my-2 mx-3 border-t border-sidebar-border/40" />}
              {(collapsed || openSections.security !== false) && dispatcherSecurityLinks.map(renderLink)}

              {!collapsed
                ? <div className="mt-2"><SectionHeader id="operations" label="Operations" /></div>
                : <div className="my-2 mx-3 border-t border-sidebar-border/40" />}
              {(collapsed || openSections.operations !== false) && dispatcherOpsTables.map((t) => {
                const active = activeTable === t.name;
                const initials = t.label.slice(0, 2).toUpperCase();
                return (
                  <Link
                    key={t.name}
                    href={`/tables/${t.name}`}
                    title={collapsed ? t.label : undefined}
                    className={`flex items-center text-sm border-l-2 transition-colors ${
                      collapsed ? "justify-center px-0 py-2" : "justify-between gap-2 px-4 py-2"
                    } ${
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary"
                        : "border-transparent hover:bg-sidebar-accent/50"
                    }`}
                  >
                    {collapsed
                      ? <span className="text-[11px] font-mono opacity-80">{initials}</span>
                      : <span>{t.label}</span>}
                  </Link>
                );
              })}
            </>
          )}

          {/* Admins see the full nav below. */}
          {!isDispatcher && <>
          {/* Human Resources */}
          {!collapsed && <div className="mt-2"><SectionHeader id="hr" label="Human Resources" /></div>}
          {(collapsed || openSections.hr !== false) && hrLinks.map(renderLink)}

          {/* Accounting */}
          {!collapsed
            ? <div className="mt-2"><SectionHeader id="accounting" label="Accounting" /></div>
            : <div className="my-2 mx-3 border-t border-sidebar-border/40" />}
          {(collapsed || openSections.accounting !== false) && accountingLinks.map(renderLink)}

          {/* Security */}
          {!collapsed
            ? <div className="mt-2"><SectionHeader id="security" label="Security" /></div>
            : <div className="my-2 mx-3 border-t border-sidebar-border/40" />}
          {(collapsed || openSections.security !== false) && securityLinks.map(renderLink)}

          {/* Operations (data tables) */}
          {!collapsed
            ? <div className="mt-2"><SectionHeader id="operations" label="Operations" /></div>
            : <div className="my-2 mx-3 border-t border-sidebar-border/40" />}
          {(collapsed || openSections.operations !== false) && operationsTables.map((t) => {
            const active = activeTable === t.name;
            const initials = t.label.slice(0, 2).toUpperCase();
            return (
              <Link
                key={t.name}
                href={`/tables/${t.name}`}
                title={collapsed ? t.label : undefined}
                className={`flex items-center text-sm border-l-2 transition-colors ${
                  collapsed ? "justify-center px-0 py-2" : "justify-between gap-2 px-4 py-2"
                } ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary"
                    : "border-transparent hover:bg-sidebar-accent/50"
                }`}
              >
                {collapsed ? (
                  <span className="text-[11px] font-mono opacity-80">{initials}</span>
                ) : (
                  <>
                    <span>{t.label}</span>
                    {t.importSupported && (
                      <span className="text-[9px] brand-gold opacity-80">IMPORT</span>
                    )}
                  </>
                )}
              </Link>
            );
          })}
          </>}
        </nav>

        <div className={`border-t border-sidebar-border ${collapsed ? "p-2" : "p-4"} text-xs space-y-2`}>
          {!collapsed && (
            <div>
              <div className="opacity-80">{user?.firstName} {user?.lastName}</div>
              <div className="opacity-60 text-[11px] truncate">{user?.email}</div>
            </div>
          )}
          <div className={`flex ${collapsed ? "flex-col gap-1" : "items-center gap-1"}`}>
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              title={collapsed ? "Sign out" : undefined}
              className={`text-sidebar-foreground hover:bg-sidebar-accent ${
                collapsed ? "w-full justify-center px-0" : "flex-1 justify-start"
              }`}
            >
              <LogOut className="w-4 h-4" />
              {!collapsed && <span className="ml-2">Sign out</span>}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={`text-sidebar-foreground hover:bg-sidebar-accent ${
                collapsed ? "w-full justify-center px-0" : "px-2"
              }`}
            >
              {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
            </Button>
          </div>
          {!collapsed && (
            <div className="text-[10px] opacity-40 text-center pt-1 select-none">
              v1.0 beta · © {new Date().getFullYear()} WCSG
            </div>
          )}
        </div>
      </aside>
      <main className="flex-1 overflow-hidden flex flex-col">
        <SystemBanner status={systemStatus} />
        {children}
      </main>
    </div>
  );
}
