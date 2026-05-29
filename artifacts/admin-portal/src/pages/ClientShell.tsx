import { useState } from "react";
import { Link, useLocation, Redirect } from "wouter";
import { Switch, Route } from "wouter";
import {
  LayoutDashboard,
  Users,
  CalendarClock,
  FileText,
  Receipt,
  LogOut,
  Menu,
  X,
  Shield,
  ChevronRight,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import ClientDashboard from "@/pages/ClientDashboard";
import ClientShifts from "@/pages/ClientShifts";
import ClientCoverageRequest from "@/pages/ClientCoverageRequest";
import ClientReports from "@/pages/ClientReports";
import ClientInvoices from "@/pages/ClientInvoices";
import SecurityPage from "@/pages/Security";
import NotFound from "@/pages/not-found";

const NAV = [
  { href: "/client", label: "Dashboard", Icon: LayoutDashboard, exact: true },
  { href: "/client/shifts", label: "Officers on Shift", Icon: Users },
  { href: "/client/request", label: "Request Coverage", Icon: CalendarClock },
  { href: "/client/reports", label: "Reports", Icon: FileText },
  { href: "/client/invoices", label: "Invoices", Icon: Receipt },
];

export function ClientShell() {
  const { user, logout } = useAuth();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  function isActive(href: string, exact?: boolean) {
    if (exact) return location === href || location === "/";
    return location.startsWith(href);
  }

  const brand = (window as any).__BRAND__ as
    | { companyName: string; shortName: string }
    | undefined;
  const companyName = brand?.companyName ?? "Williams Council Security Group";
  const shortName = brand?.shortName ?? "WCSG";

  return (
    <div className="flex flex-col h-screen w-full overflow-hidden bg-background">
      {/* Top navigation */}
      <header className="shrink-0 bg-[#080c18] text-white border-b border-[#c9a84c]/30 px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Shield className="w-5 h-5 text-[#c9a84c] shrink-0" />
          <div className="min-w-0">
            <div className="text-[#c9a84c] font-bold text-sm leading-none tracking-wide truncate">
              {shortName}
            </div>
            <div className="text-[#f0e6c8]/60 text-[10px] tracking-widest uppercase leading-none mt-0.5 truncate hidden sm:block">
              {companyName}
            </div>
          </div>
          <div className="hidden md:flex items-center gap-1 ml-6">
            <span className="text-[#f0e6c8]/40 text-xs">Client Portal</span>
            <ChevronRight className="w-3 h-3 text-[#f0e6c8]/30" />
          </div>
        </div>

        {/* Desktop nav */}
        <nav className="hidden lg:flex items-center gap-1 flex-1 justify-center">
          {NAV.map(({ href, label, Icon, exact }) => (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                isActive(href, exact)
                  ? "bg-[#c9a84c]/20 text-[#c9a84c]"
                  : "text-[#f0e6c8]/70 hover:text-[#f0e6c8] hover:bg-white/5"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden sm:flex flex-col items-end mr-1">
            <span className="text-[#f0e6c8] text-xs font-medium leading-none">
              {user?.firstName} {user?.lastName}
            </span>
            <span className="text-[#f0e6c8]/50 text-[10px] leading-none mt-0.5">
              {user?.email}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className="text-[#f0e6c8]/60 hover:text-[#f0e6c8] hover:bg-white/10 h-8 px-2"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden sm:inline ml-1.5">Sign out</span>
          </Button>
          {/* Mobile hamburger */}
          <button
            className="lg:hidden text-[#f0e6c8]/70 hover:text-[#f0e6c8] p-1"
            onClick={() => setMobileOpen((o) => !o)}
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {/* Mobile nav drawer */}
      {mobileOpen && (
        <div className="lg:hidden bg-[#080c18] border-b border-[#c9a84c]/20 px-4 py-2 flex flex-col gap-1">
          {NAV.map(({ href, label, Icon, exact }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-2 px-3 py-2 rounded text-sm font-medium transition-colors ${
                isActive(href, exact)
                  ? "bg-[#c9a84c]/20 text-[#c9a84c]"
                  : "text-[#f0e6c8]/70 hover:text-[#f0e6c8] hover:bg-white/5"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          ))}
        </div>
      )}

      {/* Page content */}
      <main className="flex-1 overflow-auto">
        <Switch>
          {/* Root redirect: clients land on /admin-portal/ after login — send them to dashboard. */}
          <Route path="/">
            <Redirect to="/client" />
          </Route>
          <Route path="/client" component={ClientDashboard} />
          <Route path="/client/shifts" component={ClientShifts} />
          <Route path="/client/request" component={ClientCoverageRequest} />
          <Route path="/client/reports" component={ClientReports} />
          <Route path="/client/invoices" component={ClientInvoices} />
          <Route path="/account/security" component={SecurityPage} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}
