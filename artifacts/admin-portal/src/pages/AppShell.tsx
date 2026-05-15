import { useState, useEffect } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { LogOut, ClipboardList, UserPlus, FileText, ChevronsLeft, ChevronsRight, Database, Banknote } from "lucide-react";
import { TABLES } from "@/lib/tables";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const COLLAPSE_KEY = "wcsg.sidebarCollapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [match, params] = useRoute("/tables/:table");
  const [location] = useLocation();
  const activeTable = match ? params?.table : null;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);

  const hrLinks = [
    { href: "/hr/applications", label: "Applications", Icon: ClipboardList },
    { href: "/hr/onboarding", label: "Onboarding", Icon: UserPlus },
    { href: "/hr/policies", label: "Policies", Icon: FileText },
    { href: "/payroll/pay-run", label: "Pay Run", Icon: Banknote },
    { href: "/integrations/monday", label: "Monday Sync", Icon: Database },
  ];

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
          {!collapsed && (
            <div className="px-3 text-[10px] uppercase tracking-widest opacity-50 mb-1">Human Resources</div>
          )}
          {hrLinks.map(({ href, label, Icon }) => {
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
                {!collapsed && <span>{label}</span>}
              </Link>
            );
          })}

          {!collapsed && (
            <div className="px-3 text-[10px] uppercase tracking-widest opacity-50 mb-1 mt-3">Data Tables</div>
          )}
          {collapsed && <div className="my-2 mx-3 border-t border-sidebar-border/40" />}
          {TABLES.map((t) => {
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
        {children}
      </main>
    </div>
  );
}
