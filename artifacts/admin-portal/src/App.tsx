import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { setToken } from "@/lib/api";
import { LoginPage } from "@/pages/Login";
import { AppShell } from "@/pages/AppShell";
import { TablePage, HomeRedirect } from "@/pages/TablePage";
import { SiteDetailPage } from "@/pages/SiteDetailPage";
import { ApplyPage } from "@/pages/Apply";
import { OnboardPage } from "@/pages/Onboard";
import { ResetPasswordPage } from "@/pages/ResetPassword";
import { AmendApplication } from "@/pages/AmendApplication";
import SubcontractorClockInPage from "@/pages/SubcontractorClockIn";
import SubcontractorEntriesPage from "@/pages/SubcontractorEntries";
import { PrivacyPage, TermsPage, DataRightsPage } from "@/pages/Legal";
import { ApplicationsPage } from "@/pages/Applications";
import { OnboardingPage } from "@/pages/Onboarding";
import { PoliciesPage } from "@/pages/Policies";
import PayRunPage from "@/pages/PayRun";
import SubcontractorPayRunPage from "@/pages/SubcontractorPayRun";
import PayrollBoardPage from "@/pages/PayrollBoard";
import InvoiceBoardPage from "@/pages/InvoiceBoard";
import { InvitationsPage } from "@/pages/Invitations";
import ShiftsPage from "@/pages/Shifts";
import CalendarPage from "@/pages/Calendar";
import AuditLogPage from "@/pages/AuditLog";
import ShiftRecoveryPage from "@/pages/ShiftRecovery";
import SwapRequestsPage from "@/pages/SwapRequests";
import LicenseRenewalsPage from "@/pages/LicenseRenewals";
import IncidentShareLinksPage from "@/pages/IncidentShareLinks";
import PublicIncidentPage from "@/pages/PublicIncident";
import EmployeeShareLinksPage from "@/pages/EmployeeShareLinks";
import PublicEmployeeProfilePage from "@/pages/PublicEmployeeProfile";
import SecurityPage from "@/pages/Security";
import RadioPage from "@/pages/Radio";
import { DailyReportsPage } from "@/pages/DailyReports";
import CompliancePage from "@/pages/Compliance";
import ExportsPage from "@/pages/Exports";
import DispatchPage from "@/pages/Dispatch";
import ChatPage from "@/pages/Chat";
import PersonnelPage from "@/pages/Personnel";
import OfficerProfilePage from "@/pages/OfficerProfile";
import StaffingPage from "@/pages/Staffing";
import StaffingEventPage from "@/pages/StaffingEvent";
import SchedulerIntegrationPage from "@/pages/SchedulerIntegration";
import NotFound from "@/pages/not-found";
import { ClientShell } from "@/pages/ClientShell";
import { MandatoryPasswordChange } from "@/pages/MandatoryPasswordChange";
import ClientUsers from "@/pages/ClientUsers";
import CoverageRequests from "@/pages/CoverageRequests";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 10s stale window + refetch on focus/reconnect keeps the admin grids
      // in sync with mobile officer actions (clock in/out, claim, decline,
      // incidents) without forcing a manual refresh.
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
      retry: 1,
    },
  },
});

function Routed() {
  const { user, loading } = useAuth();
  const [location] = useLocation();

  // Public routes — no admin auth required
  if (location === "/apply" || location.startsWith("/apply/")) return <ApplyPage />;
  if (location.startsWith("/onboard/")) return <OnboardPage />;
  if (location.startsWith("/reset-password/")) return <ResetPasswordPage />;
  if (location.startsWith("/amend/")) return <AmendApplication />;
  if (location === "/privacy") return <PrivacyPage />;
  if (location === "/terms") return <TermsPage />;
  if (location === "/data-rights") return <DataRightsPage />;
  if (location.startsWith("/share/incident/")) return <PublicIncidentPage />;
  if (location.startsWith("/share/employee/")) return <PublicEmployeeProfilePage />;
  if (location.startsWith("/subcontractor/clock/")) return <SubcontractorClockInPage />;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-navy text-white">
        <div className="text-sm opacity-70">Loading…</div>
      </div>
    );
  }
  if (!user) return <LoginPage />;

  // First-login credential rotation: invited users (notably client contacts)
  // arrive with a temporary password and mustChangePassword=true. The API
  // blocks every non-/auth route with 403 until they rotate it, so gate the
  // whole portal behind a mandatory change screen before any role routing.
  if (user.mustChangePassword) {
    return <MandatoryPasswordChange />;
  }

  // Client portal users get their own isolated shell
  if (user.role === "client") {
    return <ClientShell />;
  }

  if (user.role !== "admin" && user.role !== "dispatcher") {
    // Officers/employees don't belong in the admin portal — they end up here
    // when they open the portal URL (old invite links, a bookmark, word of
    // mouth) and sign in. Instead of dead-ending them on an "admin access
    // required" screen, send them to the SecureOps app served at the domain
    // root, which is where officers actually sign in.
    return <OfficerAppRedirect email={user.email} />;
  }

  const isDispatcher = user.role === "dispatcher";

  return (
    <AppShell>
      {isDispatcher ? (
        <Switch>
          <Route path="/" component={DispatchHomeRedirect} />
          <Route path="/dispatch" component={DispatchPage} />
          <Route path="/chat" component={ChatPage} />
          <Route path="/personnel" component={PersonnelPage} />
          <Route path="/personnel/:id" component={OfficerProfilePage} />
          <Route path="/shifts/calendar" component={CalendarPage} />
          <Route path="/tables/shifts" component={ShiftsPage} />
          <Route path="/account/security" component={SecurityPage} />
          <Route path="/radio" component={RadioPage} />
          <Route component={RootAwareNotFound} />
        </Switch>
      ) : (
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/dispatch" component={DispatchPage} />
          <Route path="/chat" component={ChatPage} />
          <Route path="/personnel" component={PersonnelPage} />
          <Route path="/personnel/share-links" component={EmployeeShareLinksPage} />
          <Route path="/personnel/:id" component={OfficerProfilePage} />
          <Route path="/hr/applications" component={ApplicationsPage} />
          <Route path="/hr/onboarding" component={OnboardingPage} />
          <Route path="/hr/policies" component={PoliciesPage} />
          <Route path="/hr/invitations" component={InvitationsPage} />
          <Route path="/hr/client-users" component={ClientUsers} />
          <Route path="/hr/coverage-requests" component={CoverageRequests} />
          <Route path="/payroll/board" component={PayrollBoardPage} />
          <Route path="/invoices/board" component={InvoiceBoardPage} />
          <Route path="/payroll/pay-run" component={PayRunPage} />
          <Route path="/subcontractors/pay-run" component={SubcontractorPayRunPage} />
          <Route path="/subcontractors/clock-in-entries" component={SubcontractorEntriesPage} />
          <Route path="/audit-log" component={AuditLogPage} />
          <Route path="/recovery/shifts" component={ShiftRecoveryPage} />
          <Route path="/swap-requests" component={SwapRequestsPage} />
          <Route path="/hr/license-renewals" component={LicenseRenewalsPage} />
          <Route path="/incidents/share-links" component={IncidentShareLinksPage} />
          <Route path="/account/security" component={SecurityPage} />
          <Route path="/settings/scheduler-integration" component={SchedulerIntegrationPage} />
          <Route path="/radio" component={RadioPage} />
          <Route path="/dar" component={DailyReportsPage} />
          <Route path="/compliance" component={CompliancePage} />
          <Route path="/exports" component={ExportsPage} />
          <Route path="/sites/:id" component={SiteDetailPage} />
          <Route path="/staffing" component={StaffingPage} />
          <Route path="/staffing/:id" component={StaffingEventPage} />
          <Route path="/shifts/calendar" component={CalendarPage} />
          <Route path="/tables/shifts" component={ShiftsPage} />
          <Route path="/tables/:table" component={TablePage} />
          <Route component={RootAwareNotFound} />
        </Switch>
      )}
    </AppShell>
  );
}

function OfficerAppRedirect({ email }: { email: string }) {
  const appUrl =
    typeof window !== "undefined" ? `${window.location.origin}/` : "/";
  useEffect(() => {
    // Drop the admin-portal session so the officer isn't left half-signed-in
    // here, then bounce to the SecureOps app at the domain root.
    setToken(null);
    const t = setTimeout(() => {
      window.location.replace(appUrl);
    }, 1600);
    return () => clearTimeout(t);
  }, [appUrl]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-navy text-white p-6 text-center">
      <div className="max-w-sm">
        <div className="brand-wordmark text-xl mb-2">Taking you to the SecureOps app…</div>
        <p className="text-sm opacity-70 mb-4">
          Officer accounts ({email}) sign in through the SecureOps app, not the admin
          portal. Redirecting you now.
        </p>
        <a href={appUrl} className="text-sm underline" style={{ color: "#c9a84c" }}>
          Continue now
        </a>
      </div>
    </div>
  );
}

function RootAwareNotFound() {
  // When the URL is the bare base (`/admin-portal` with no trailing slash),
  // wouter reports the location as "" which matches no route. Treat it as the
  // root so the role's home redirect fires; everything else is a real 404.
  const [location] = useLocation();
  if (location === "") return <Redirect to="/" />;
  return <NotFound />;
}

function DispatchHomeRedirect() {
  const [, navigate] = useLocation();
  // Dispatchers land on the unified command center.
  if (typeof window !== "undefined") {
    queueMicrotask(() => navigate("/dispatch", { replace: true }));
  }
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <Routed />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
