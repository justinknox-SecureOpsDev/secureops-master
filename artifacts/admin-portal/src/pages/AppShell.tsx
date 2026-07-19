import { useState, useEffect, useMemo } from "react";
import { Link, useLocation } from "wouter";
import {
  LogOut, ClipboardList, UserPlus, FileText, ChevronsLeft, ChevronsRight, Smartphone,
  Database, Banknote, Receipt, Wallet, MailPlus,
  AlertTriangle, ShieldCheck, Repeat, KeyRound, IdCard, Link2, Download,
  Radio as RadioIcon, Radar, MessageCircle, Users as UsersIcon,
  Briefcase, Calculator, Shield, Settings, CalendarRange, Menu, X, Building2,
  ArrowLeftRight, GraduationCap, LifeBuoy, FormInput, BarChart3, LayoutDashboard,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { fetchWithAuth } from "@/lib/api";
import { isFeatureEnabled, type FeatureKey } from "@/lib/brand";
import { Button } from "@/components/ui/button";
import { useChatUnreadTotal } from "@/hooks/useChatUnreadTotal";
import { GlobalSearch } from "@/components/GlobalSearch";
import { CustomizeTabsDialog } from "@/components/CustomizeTabsDialog";

type SystemStatus = {
  env: string;
  smtpConfigured: boolean;
  sessionSecretOk: boolean;
  baseUrlConfigured: boolean;
  corsOriginsConfigured: boolean;
  geofenceRadiusMiles?: number;
  geofenceRadiusTooTight?: boolean;
  schedulerConfigured?: boolean;
  schedulerSyncHealthy?: boolean;
};

function useSystemStatus(role: string | undefined) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  useEffect(() => {
    if (role !== "admin") return;
    let cancelled = false;
    const token = (() => { try { return localStorage.getItem("wcsg.adminToken") || ""; } catch { return ""; } })();
    if (!token) return;
    fetchWithAuth("/api/admin/system/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data) setStatus(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [role]);
  return status;
}

function useIsSuperAdmin(role: string | undefined) {
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  useEffect(() => {
    if (role !== "admin") return;
    let cancelled = false;
    fetchWithAuth("/api/admin/platform/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data) setIsSuperAdmin(!!data.isSuperAdmin); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [role]);
  return isSuperAdmin;
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
  if (status.schedulerConfigured && status.schedulerSyncHealthy === false) {
    issues.push("Scheduler integration is failing or falling behind — the last sync errored or is more than 30 minutes overdue. Open Settings → Scheduler Integration to view the error and resync.");
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

/** Small red pill for unread counts, capped at "99+". */
function UnreadBadge({ count, className = "" }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[1.125rem] h-[1.125rem] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold leading-none ${className}`}
      aria-hidden="true"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

type LinkItem = { href: string; label: string; Icon: LucideIcon; badge?: string; feature?: FeatureKey };
type NavGroup = {
  key: string;
  label: string;
  Icon: LucideIcon;
  items: LinkItem[];
};

/**
 * Builds the role-aligned top-level navigation. Pure (depends only on role) so
 * the route→group mapping can be unit-tested without rendering the shell.
 *
 * Admins get the full set of operational tabs; dispatchers get a leaner IA.
 * The dispatcher Dispatch tab is intentionally Live-Map-only — reusing the
 * admin Dispatch group (which also owns chat/radio/personnel) would duplicate
 * those routes and make the dispatcher Security tab non-authoritative, because
 * `resolveGroupKey` returns the first group whose item matches the location.
 */
export function buildNavGroups(
  isDispatcher: boolean,
  isSuperAdmin = false,
  featureEnabled: (key: FeatureKey) => boolean = () => true,
): NavGroup[] {
  // Admin-only landing dashboard. Listed first so `/` resolves here (exact
  // match — "/" only prefix-matches itself, so it never shadows other routes).
  const overviewGroup: NavGroup = {
    key: "overview",
    label: "Dashboard",
    Icon: LayoutDashboard,
    items: [{ href: "/", label: "Dashboard", Icon: LayoutDashboard }],
  };

  const dispatchGroup: NavGroup = {
    key: "dispatch",
    label: "Dispatch",
    Icon: Radar,
    items: [
      { href: "/dispatch", label: "Live Map", Icon: Radar, feature: "liveMap" },
      { href: "/chat", label: "Chat", Icon: MessageCircle, feature: "chat" },
      { href: "/radio", label: "Radio", Icon: RadioIcon, feature: "radio" },
      { href: "/personnel", label: "Personnel", Icon: UsersIcon },
      { href: "/tables/incidents", label: "Incidents", Icon: AlertTriangle, feature: "incidents" },
      { href: "/dar", label: "Daily Reports", Icon: ClipboardList, feature: "dar" },
      { href: "/incidents/share-links", label: "Incident shares", Icon: Link2, feature: "incidents" },
      { href: "/personnel/share-links", label: "Officer shares", Icon: Link2, feature: "officerShares" },
    ],
  };

  const staffingGroup: NavGroup = {
    key: "staffing",
    label: "Staffing",
    Icon: CalendarRange,
    items: [
      { href: "/shifts/calendar", label: "Shift Calendar", Icon: CalendarRange },
      { href: "/tables/shifts", label: "Shifts", Icon: Database },
      { href: "/tables/shift_assignments", label: "Shift Assignments", Icon: ClipboardList },
      { href: "/tables/time_entries", label: "Time Entries", Icon: Database },
      { href: "/swap-requests", label: "Swap Requests", Icon: Repeat, feature: "swapRequests" },
      { href: "/staffing", label: "Events", Icon: CalendarRange },
      { href: "/hr/coverage-requests", label: "Coverage Requests", Icon: ClipboardList },
    ],
  };

  const hrGroup: NavGroup = {
    key: "hr",
    label: "Personnel Management",
    Icon: Briefcase,
    items: [
      { href: "/hr/applications", label: "Applications", Icon: ClipboardList, feature: "hr" },
      { href: "/hr/application-builder", label: "Application Builder", Icon: FormInput, feature: "hr" },
      { href: "/hr/onboarding", label: "Onboarding", Icon: UserPlus, feature: "hr" },
      { href: "/hr/invitations", label: "Invitations", Icon: MailPlus, feature: "hr" },
      { href: "/hr/policies", label: "Policies", Icon: FileText, feature: "policies" },
      { href: "/hr/reports", label: "Employee Reports", Icon: BarChart3, feature: "hr" },
      { href: "/tables/employees", label: "Employees", Icon: UsersIcon },
    ],
  };

  const complianceGroup: NavGroup = {
    key: "compliance",
    label: "Compliance & Training",
    Icon: ShieldCheck,
    items: [
      { href: "/hr/license-renewals", label: "License Renewals", Icon: IdCard, feature: "licenseRenewals" },
      { href: "/compliance", label: "Compliance", Icon: ShieldCheck },
      { href: "/tables/licenses", label: "Licences", Icon: IdCard },
      { href: "/tables/training-certifications", label: "Training", Icon: GraduationCap, feature: "trainings" },
    ],
  };

  const administrationGroup: NavGroup = {
    key: "administration",
    label: "Administration",
    Icon: Building2,
    items: [
      { href: "/tables/sales_leads", label: "Sales Leads", Icon: MailPlus },
      { href: "/tables/clients", label: "Clients", Icon: Briefcase },
      { href: "/tables/sites", label: "Sites", Icon: Building2 },
      { href: "/hr/client-users", label: "Client Users", Icon: UsersIcon },
      { href: "/tables/subcontractors", label: "Subcontractors", Icon: Building2 },
      { href: "/tables/subcontractor_cois", label: "Certificates of Insurance", Icon: ShieldCheck },
      { href: "/tables/subcontractor_contracts", label: "Contracts", Icon: FileText },
      { href: "/tables/subcontractor_invoices", label: "Invoices", Icon: Receipt },
      { href: "/subcontractors/pay-run", label: "Subcontractor Pay Run", Icon: Banknote },
      { href: "/subcontractors/clock-in-entries", label: "Clock-In Entries", Icon: ClipboardList },
    ],
  };

  const accountingGroup: NavGroup = {
    key: "accounting",
    label: "Accounting",
    Icon: Calculator,
    items: [
      { href: "/analytics", label: "Analytics", Icon: BarChart3 },
      { href: "/payroll/board", label: "Payroll Board", Icon: Wallet, feature: "payroll" },
      { href: "/payroll/pay-run", label: "Pay Run", Icon: Banknote, feature: "payroll" },
      { href: "/invoices/board", label: "Invoice Board", Icon: Receipt, feature: "invoicing" },
      { href: "/tables/invoices", label: "Invoices (raw)", Icon: Receipt, feature: "invoicing" },
      { href: "/tables/payroll_entries", label: "Payroll entries", Icon: Wallet, feature: "payroll" },
      { href: "/tables/payment_discrepancies", label: "Payment Discrepancies", Icon: AlertTriangle, feature: "payroll" },
    ],
  };

  const settingsGroup: NavGroup = {
    key: "settings",
    label: "Settings",
    Icon: Settings,
    items: [
      { href: "/account/security", label: "My Account", Icon: KeyRound },
      { href: "/tables/users", label: "Users", Icon: UsersIcon },
      { href: "/settings/invite", label: "App Invite", Icon: Smartphone },
      { href: "/audit-log", label: "Audit Log", Icon: ShieldCheck },
      { href: "/recovery/shifts", label: "Shift Recovery", Icon: LifeBuoy },
      { href: "/exports", label: "Exports", Icon: Download },
      { href: "/settings/scheduler-integration", label: "Scheduler Integration", Icon: ArrowLeftRight },
      { href: "/legal/agreements", label: "Legal & Agreements", Icon: FileText },
    ],
  };

  // Drop any nav item whose feature the active plan doesn't include, then drop
  // any group left empty. Items with no `feature` are always-on (auth, CRUD,
  // dashboard, etc.) and never filtered.
  const applyFeatures = (groups: NavGroup[]): NavGroup[] =>
    groups
      .map((g) => ({
        ...g,
        items: g.items.filter((it) => !it.feature || featureEnabled(it.feature)),
      }))
      .filter((g) => g.items.length > 0);

  if (isDispatcher) {
    return applyFeatures([
      {
        key: "dispatch",
        label: "Dispatch",
        Icon: Radar,
        items: [{ href: "/dispatch", label: "Live Map", Icon: Radar, feature: "liveMap" }],
      },
      {
        key: "security",
        label: "Security",
        Icon: Shield,
        items: [
          { href: "/chat", label: "Chat", Icon: MessageCircle, feature: "chat" },
          { href: "/personnel", label: "Personnel", Icon: UsersIcon },
          { href: "/radio", label: "Radio", Icon: RadioIcon, feature: "radio" },
        ],
      },
      {
        key: "operations",
        label: "Operations",
        Icon: Database,
        items: [
          { href: "/shifts/calendar", label: "Shift Calendar", Icon: CalendarRange },
          { href: "/tables/shifts", label: "Shifts", Icon: Database },
        ],
      },
      {
        key: "settings",
        label: "Settings",
        Icon: Settings,
        items: [
          { href: "/account/security", label: "My Account", Icon: KeyRound },
          { href: "/settings/scheduler-integration", label: "Scheduler Integration", Icon: ArrowLeftRight },
        ],
      },
    ]);
  }

  // Platform owner surface (feature flags + pricing tiers). Only the
  // dedicated super-admin sees it; regular admins never do. Lives in Settings
  // so the role-aligned 7-group IA is unchanged.
  if (isSuperAdmin) {
    settingsGroup.items.push({ href: "/platform/features", label: "Platform & Pricing", Icon: Shield });
  }

  return applyFeatures([
    overviewGroup,
    dispatchGroup,
    staffingGroup,
    hrGroup,
    complianceGroup,
    administrationGroup,
    accountingGroup,
    settingsGroup,
  ]);
}

/**
 * Applies a user's saved nav-group order preference to the default group list.
 * Saved keys come first (in saved order); unknown/stale keys are ignored; any
 * groups missing from the preference are appended in default order, so newly
 * shipped tabs always remain reachable. Pure so it can be unit-tested.
 */
export function applyNavOrder(groups: NavGroup[], order?: string[] | null): NavGroup[] {
  if (!order || order.length === 0) return groups;
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const seen = new Set<string>();
  const out: NavGroup[] = [];
  for (const key of order) {
    const g = byKey.get(key);
    if (g && !seen.has(key)) {
      out.push(g);
      seen.add(key);
    }
  }
  for (const g of groups) {
    if (!seen.has(g.key)) out.push(g);
  }
  return out;
}

/**
 * Resolves the current location to a nav group key. First match wins: an exact
 * item href (or a sub-path of one) takes precedence, then a small set of
 * fallback heuristics handle dynamic routes (e.g. `/sites/:id`, `/staffing/:id`)
 * that have no nav item of their own. Returns null when nothing matches.
 */
export function resolveGroupKey(groups: NavGroup[], location: string): string | null {
  const startsWith = (prefix: string) => location === prefix || location.startsWith(prefix + "/");
  for (const g of groups) {
    for (const item of g.items) {
      if (location === item.href || startsWith(item.href)) return g.key;
    }
  }
  // Dynamic sub-routes that aren't represented by their own nav item.
  if (startsWith("/sites") || startsWith("/subcontractors")) return "administration";
  if (startsWith("/payroll") || startsWith("/invoices") || startsWith("/analytics")) return "accounting";
  if (startsWith("/shifts") || startsWith("/staffing") || startsWith("/swap-requests")) return "staffing";
  if (startsWith("/compliance")) return "compliance";
  if (startsWith("/dispatch") || startsWith("/chat") || startsWith("/radio")
    || startsWith("/dar") || startsWith("/personnel") || startsWith("/incidents")) {
    return "dispatch";
  }
  if (startsWith("/account") || startsWith("/settings") || startsWith("/platform")
    || startsWith("/audit-log") || startsWith("/exports") || startsWith("/tables")) {
    return "settings";
  }
  if (startsWith("/hr")) return "hr";
  return null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const isDispatcher = user?.role === "dispatcher";
  const isSuperAdmin = useIsSuperAdmin(user?.role);
  const systemStatus = useSystemStatus(user?.role);
  // Aggregate unread chat badge — enabled for any admin/dispatcher (the only
  // roles that reach the shell), surfaced on the Chat nav link and the group
  // tab that hosts it so unread messages are visible from anywhere.
  const chatUnread = useChatUnreadTotal(!!user);
  const brandCfg = (window as any).__BRAND__ as { companyName: string; shortName: string; appName: string } | undefined;

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);

  // Mobile sidebar drawer (hidden by default, toggled by hamburger). Auto-closes on navigation.
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { setMobileOpen(false); }, [location]);

  // Per-user tab order: role defaults, reordered by the account's saved
  // preference. `navOrderOverride` reflects a save made this session without
  // waiting for a /auth/me refetch.
  const defaultGroups = useMemo(
    () => buildNavGroups(isDispatcher, isSuperAdmin, isFeatureEnabled),
    [isDispatcher, isSuperAdmin],
  );
  const [navOrderOverride, setNavOrderOverride] = useState<string[] | null>(null);
  const savedNavOrder = navOrderOverride ?? user?.uiPreferences?.navGroupOrder ?? null;
  const groups = useMemo(
    () => applyNavOrder(defaultGroups, savedNavOrder),
    [defaultGroups, savedNavOrder],
  );
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const groupForLocation = useMemo(
    () => resolveGroupKey(groups, location),
    [groups, location],
  );

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
    const unread = href === "/chat" ? chatUnread : 0;
    const ariaLabel =
      unread > 0
        ? `${label}, ${unread > 99 ? "99+" : unread} unread message${unread === 1 ? "" : "s"}`
        : undefined;
    return (
      <Link
        key={href}
        href={href}
        title={collapsed ? label : undefined}
        aria-label={ariaLabel}
        className={`relative flex items-center text-sm border-l-2 transition-colors ${
          collapsed ? "justify-center px-0 py-2.5" : "gap-2 px-4 py-2"
        } ${
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary"
            : "border-transparent hover:bg-sidebar-accent/50"
        }`}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {collapsed && unread > 0 && (
          <UnreadBadge count={unread} className="absolute top-1 right-1 scale-90" />
        )}
        {!collapsed && (
          <span className="flex-1 flex items-center justify-between gap-2">
            <span>{label}</span>
            {unread > 0 ? (
              <UnreadBadge count={unread} />
            ) : (
              badge && <span className="text-[9px] brand-gold opacity-80">{badge}</span>
            )}
          </span>
        )}
      </Link>
    );
  };

  return (
    <div className="flex flex-col h-dvh w-full overflow-hidden bg-background">
      <header className="shrink-0 bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-sidebar-border/60">
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden text-sidebar-foreground hover:bg-sidebar-accent shrink-0 px-2"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </Button>
          <img
            src={`${import.meta.env.BASE_URL}logo-256.png`}
            alt={brandCfg?.shortName ?? "WCSG"}
            className="w-9 h-9 shrink-0 rounded-md object-contain"
          />
          <div className="hidden md:block shrink-0 text-center">
            <div className="brand-wordmark text-base sm:text-xl leading-tight truncate">
              <span className="sm:hidden">{brandCfg?.shortName ?? "WCSG"}</span>
              <span className="hidden sm:inline">{brandCfg?.companyName ?? "Williams Council Security Group"}</span>
            </div>
            <div className="text-[10px] uppercase tracking-[0.25em] flex items-center justify-center gap-2">
              <span className="opacity-60">Admin Portal</span>
              {import.meta.env.DEV && (
                <span
                  className="px-1.5 py-px rounded-sm bg-amber-400 text-amber-950 font-bold tracking-widest text-[9px]"
                  title="You are viewing the development preview. Writes here do NOT reach the production database or TestFlight mobile app."
                >
                  DEV
                </span>
              )}
            </div>
          </div>
          <div className="flex-1 flex items-center justify-center px-2 sm:px-4">
            {isDispatcher
              ? <GlobalSearch allowedDomainKeys={["employees", "shifts", "chatRooms"]} />
              : <GlobalSearch />}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden md:block text-right leading-tight">
              <div className="text-xs opacity-80">{user?.firstName} {user?.lastName}</div>
              <div className="text-[10px] opacity-50 truncate max-w-[180px]">{user?.email}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open("/", "_blank", "noopener,noreferrer")}
              title="Open the SecureOps mobile app in a new tab"
              aria-label="Open mobile app"
              className="text-sidebar-foreground hover:bg-sidebar-accent gap-1.5"
            >
              <Smartphone className="w-4 h-4" />
              <span className="hidden sm:inline text-xs">Open app</span>
            </Button>
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
            // Surface the aggregate chat badge on the tab that hosts the Chat
            // link when that group isn't the one currently open.
            const hasChat = g.items.some((it) => it.href === "/chat");
            const showTabBadge = hasChat && !isActive && chatUnread > 0;
            return (
              <button
                key={g.key}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => onTabClick(g)}
                className={`group flex items-center gap-2 px-4 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
                  isActive
                    ? "border-brand-gold text-white bg-sidebar-accent/40"
                    : "border-transparent hover:bg-sidebar-accent/30"
                }`}
              >
                {/* Dim only the icon + label on inactive tabs — never an
                    ancestor of the unread badge, since CSS opacity composites
                    the whole subtree and would drop the badge below the WCAG
                    contrast threshold (axe color-contrast). */}
                <Icon
                  className={`w-4 h-4 ${isActive ? "" : "opacity-70 group-hover:opacity-100 transition-opacity"}`}
                />
                <span className={isActive ? "" : "opacity-70 group-hover:opacity-100 transition-opacity"}>
                  {g.label}
                </span>
                {showTabBadge && <UnreadBadge count={chatUnread} />}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setCustomizeOpen(true)}
            title="Customize tab order"
            aria-label="Customize tab order"
            className="ml-auto flex items-center px-3 py-2 border-b-2 border-transparent opacity-60 hover:opacity-100 hover:bg-sidebar-accent/30 transition-all"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>
        </nav>
      </header>

      <CustomizeTabsDialog
        open={customizeOpen}
        onOpenChange={setCustomizeOpen}
        groups={groups.map((g) => ({ key: g.key, label: g.label, Icon: g.Icon }))}
        defaultKeys={defaultGroups.map((g) => g.key)}
        onSaved={(order) => setNavOrderOverride(order)}
      />

      <SystemBanner status={systemStatus} />

      <div className="flex flex-1 overflow-hidden relative">
        {mobileOpen && (
          <button
            type="button"
            aria-label="Close menu"
            className="md:hidden fixed inset-0 top-[var(--mobile-top,0)] bg-black/50 z-30"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          className={`bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col transition-[width,transform] duration-200 ease-out
            md:shrink-0 md:relative md:translate-x-0
            fixed inset-y-0 left-0 z-40 w-60
            ${mobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full md:translate-x-0"}
            ${collapsed ? "md:w-14" : "md:w-60"}`}
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
              <div className="text-[10px] opacity-60 text-center pt-2 select-none">
                v1.0 · © {new Date().getFullYear()} {brandCfg?.shortName ?? "WCSG"}
              </div>
            )}
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-auto flex flex-col">
          {children}
        </main>
      </div>
    </div>
  );
}
