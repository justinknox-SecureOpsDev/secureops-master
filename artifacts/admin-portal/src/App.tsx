import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { LoginPage } from "@/pages/Login";
import { AppShell } from "@/pages/AppShell";
import { TablePage, HomeRedirect } from "@/pages/TablePage";
import { SiteDetailPage } from "@/pages/SiteDetailPage";
import { ApplyPage } from "@/pages/Apply";
import { OnboardPage } from "@/pages/Onboard";
import { ApplicationsPage } from "@/pages/Applications";
import { OnboardingPage } from "@/pages/Onboarding";
import { PoliciesPage } from "@/pages/Policies";
import { MondaySyncPage } from "@/pages/MondaySync";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Routed() {
  const { user, loading } = useAuth();
  const [location] = useLocation();

  // Public routes — no admin auth required
  if (location === "/apply" || location.startsWith("/apply/")) return <ApplyPage />;
  if (location.startsWith("/onboard/")) return <OnboardPage />;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-navy text-white">
        <div className="text-sm opacity-70">Loading…</div>
      </div>
    );
  }
  if (!user) return <LoginPage />;
  if (user.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-navy text-white p-6 text-center">
        <div>
          <div className="brand-wordmark text-xl mb-2">Admin access required</div>
          <p className="text-sm opacity-70">
            Your account ({user.email}) is not an admin. Sign in with an admin account.
          </p>
        </div>
      </div>
    );
  }

  return (
    <AppShell>
      <Switch>
        <Route path="/" component={HomeRedirect} />
        <Route path="/hr/applications" component={ApplicationsPage} />
        <Route path="/hr/onboarding" component={OnboardingPage} />
        <Route path="/hr/policies" component={PoliciesPage} />
        <Route path="/integrations/monday" component={MondaySyncPage} />
        <Route path="/sites/:id" component={SiteDetailPage} />
        <Route path="/tables/:table" component={TablePage} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
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
