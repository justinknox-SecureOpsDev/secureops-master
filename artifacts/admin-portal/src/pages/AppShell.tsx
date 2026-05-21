import { useState, useEffect, useMemo } from "react";
import { Link, useRoute, useLocation } from "wouter";
import {
  LogOut, ClipboardList, UserPlus, FileText, ChevronsLeft, ChevronsRight,
  Database, Banknote, Receipt, Wallet, MailPlus,
  AlertTriangle, ShieldCheck, Repeat, KeyRound, IdCard, Link2, Download,
  Radio as RadioIcon, Radar, MessageCircle, Users as UsersIcon,
  Briefcase, Calculator, Shield, Settings,
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
  geofenceRadiusTooTight?: boolean;
};

function useSystemStatus(role: string | undefined) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  useEffect(() => {
    if (role !== "admin") return;
    let cancelled = false;
    const token = (() => { try { return localStorage.getItem("wcsg.adminToken") || ""; } catch { return ""; } })();
    if (!token) return;
    fetch("/api/admin/system/status", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data) setStatus(data); })
      .catch(() => {});
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
  if (status.geofenceRadiusTooTight && typeof status.geofenceRadiusMiles === "number") {
    const feet = Math.round(status.geofenceRadiusMiles * 5280);
    issues.push(
      `GEOFENCE_RADIUS_MILES is set to ${status.geofenceRadiusMiles} mi (~${feet.toLocaleString()} ft) — tighter than typical phone GPS accuracy (~30–65 ft). Every site without a per-site override will page admins on normal GPS drift; recommend ≥ 0.1 mi (~528 ft).`,
    );
  }
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
const ACTIVE_GROUP_KEY = "wcsg.activeGroup";

type LinkItem = { href: string; label: string; Icon: LucideIcon; badge?: string };
type NavGroup = {
  key: string;
  label: string;
  Icon: LucideIcon;
  items: LinkItem[];
};

const ACCOUNTING_TABLE_NAMES = new Set(["payroll_entries", "invoices"]);

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [match, params] = useRoute("/tables/:table");
  const [location, setLocation] = useLocation();
  const activeTable = match ? params?.table : null;
  const isDispatcher = user?.role === "dispatcher";
  const systemStatus = useSystemStatus(user?.role);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);

  const groups: NavGroup[] = useMemo(() => {
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
      { href: "/tables/payroll_entries", label: "Payroll entries", Icon: Wallet },
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
    ];

    const operationsTables = TABLES.filter((t) => !ACCOUNTING_TABLE_NAMES.has(t.name));
    const operationsLinks: LinkItem[] = operationsTables.map((t) => ({
      href: `/tables/${t.name}`,
      label: t.label,
      Icon: Database,
      badge: t.importSupported ? "IMPORT" : undefined,
    }));

    const settingsLinks: LinkItem[] = [
      { href: "/account/security", label: "My 2FA", Icon: KeyRound },
    ];

    const dispatchGroup: NavGroup = {
      key: "dispatch",
      label: "Dispatch",
      Icon: Radar,
      items: [{ href: "/dispatch", label: "Live Map", Icon: Radar }],
    };

    if (isDispatcher) {
      return [
        dispatchGroup,
        {
          key: "security",
          label: "Security",
          Icon: Shield,
          items: [
            { href: "/chat", label: "Chat", Icon: MessageCircle },
            { href: "/personnel", label: "Personnel", Icon: UsersIcon },
            { href: "/radio", label: "Radio", Icon: RadioIcon },
          ],
        },
        {
          key: "operations",
          label: "Operations",
          Icon: Database,
          items: operationsTables
            .filter((t) => t.name === "shifts")
            .map((t) => ({ href: `/tables/${t.name}`, label: t.label, Icon: Database })),
        },
        { key: "settings", label: "Settings", Icon: Settings, items: settingsLinks },
      ];
    }

    return [
      dispatchGroup,
      { key: "hr", label: "Human Resources", Icon: Briefcase, items: hrLinks },
      { key: "accounting", label: "Accounting", Icon: Calculator, items: accountingLinks },
      { key: "security", label: "Security", Icon: Shield, items: securityLinks },
      { key: "operations", label: "Operations", Icon: Database, items: operationsLinks },
      { key: "settings", label: "Settings", Icon: Settings, items: settingsLinks },
    ];
  }, [isDispatcher]);

  const groupForLocation = useMemo(() => {
    const startsWith = (prefix: string) => location === prefix || location.startsWith(prefix + "/");
    for (const g of groups) {
      for (const item of g.items) {
        if (location === item.href || startsWith(item.href)) return g.key;
      }
    }
    if (startsWith("/dispatch")) return "dispatch";
    if (startsWith("/hr")) return "hr";
    if (startsWith("/payroll")) return "accounting";
    if (startsWith("/tables")) {
      if (activeTable && ACCOUNTING_TABLE_NAMES.has(activeTable)) return "accounting";
      return "operations";
    }
    if (startsWith("/sites")) return "operations";
    if (startsWith("/personnel") || startsWith("/chat") || startsWith("/radio")
      || startsWith("/dar") || startsWith("/compliance") || startsWith("/audit-log")
      || startsWith("/swap-requests") || startsWith("/incidents") || startsWith("/exports")) {
      return "security";
    }
    if (startsWith("/account")) return "settings";
    return null;
  }, [groups, location, activeTable]);

  const [activeGroupKey, setActiveGroupKey] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_GROUP_KEY);
      if (saved) return saved;
    } catch {}
    return groups[0]?.key ?? "dispatch";
  });

  useEffect(() => {
    if (groupForLocation && groupForLocation !== activeGroupKey) {
      setActiveGroupKey(groupForLocation);
    }
  }, [groupForLocation]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try { localStorage.setItem(ACTIVE_GROUP_KEY, activeGroupKey); } catch {}
  }, [activeGroupKey]);

  const activeGroup = groups.find((g) => g.key === activeGroupKey) ?? groups[0];

  const onTabClick = (g: NavGroup) => {
    setActiveGroupKey(g.key);
    if (g.items.length === 1) {
      setLocation(g.items[0].href);
      return;
    }
    const alreadyInGroup = g.items.some(
      (it) => location === it.href || location.startsWith(it.href + "/"),
    );
    if (!alreadyInGroup && g.items[0]) {
      setLocation(g.items[0].href);
    }
  };

  const renderLink = ({ href, label, Icon, badge }: LinkItem) => {
    const active = location === href || location.startsWith(href + "/");
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

  return (
    <div className="flex flex-col h-screen w-full overflow-hidden bg-background">
      <header className="shrink-0 bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
        <div className="flex items-center gap-3 px-4 py-2 border-b border-sidebar-border/60">
          <img
            src={`${import.meta.env.BASE_URL}logo-256.png`}
            alt="WCSG"
            className="w-9 h-9 shrink-0 rounded-md object-contain"
          />
          <div className="flex-1 min-w-0 text-center">
            <div className="brand-wordmark text-lg sm:text-xl leading-tight truncate">
              Williams Council <span className="brand-gold">Security Group Inc.</span>
            </div>
            <div className="text-[10px] uppercase tracking-[0.25em] opacity-60">Admin Portal</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden md:block text-right leading-tight">
              <div className="text-xs opacity-80">{user?.firstName} {user?.lastName}</div>
              <div className="text-[10px] opacity-50 truncate max-w-[180px]">{user?.email}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              className="text-sidebar-foreground hover:bg-sidebar-accent"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <nav
          aria-label="Primary"
          className="flex items-stretch overflow-x-auto"
        >
          {groups.map((g) => {
            const isActive = g.key === activeGroupKey;
            const Icon = g.Icon;
            return (
              <button
                key={g.key}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => onTabClick(g)}
                className={`flex items-center gap-2 px-4 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
                  isActive
                    ? "border-brand-gold text-white bg-sidebar-accent/40"
                    : "border-transparent opacity-70 hover:opacity-100 hover:bg-sidebar-accent/30"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{g.label}</span>
              </button>
            );
          })}
        </nav>
      </header>

      <SystemBanner status={systemStatus} />

      <div className="flex flex-1 overflow-hidden">
        <aside
          className={`shrink-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col transition-[width] duration-200 ease-out ${
            collapsed ? "w-14" : "w-60"
          }`}
        >
          {!collapsed && activeGroup && (
            <div className="px-4 py-3 border-b border-sidebar-border flex items-center gap-2">
              <activeGroup.Icon className="w-4 h-4 brand-gold" />
              <div className="text-[11px] uppercase tracking-widest opacity-70">{activeGroup.label}</div>
            </div>
          )}

          <nav className="flex-1 overflow-y-auto py-2">
            {activeGroup?.items.map(renderLink)}
          </nav>

          <div className={`border-t border-sidebar-border ${collapsed ? "p-2" : "p-2"}`}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? "Expand panel" : "Collapse panel"}
              aria-label={collapsed ? "Expand panel" : "Collapse panel"}
              className={`text-sidebar-foreground hover:bg-sidebar-accent w-full ${
                collapsed ? "justify-center px-0" : "justify-start"
              }`}
            >
              {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
              {!collapsed && <span className="ml-2 text-xs">Collapse</span>}
            </Button>
            {!collapsed && (
              <div className="text-[10px] opacity-40 text-center pt-2 select-none">
                v1.0 · © {new Date().getFullYear()} WCSG
              </div>
            )}
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto flex flex-col">
          {children}
        </main>
      </div>
    </div>
  );
}
