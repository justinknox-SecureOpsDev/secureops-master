import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import employeesRouter from "./employees";
import clientsRouter from "./clients";
import sitesRouter from "./sites";
import shiftsRouter from "./shifts";
import protectionRouter from "./protection";
import timeEntriesRouter from "./timeEntries";
import payrollRouter from "./payroll";
import invoicesRouter from "./invoices";
import incidentsRouter from "./incidents";
import licensesRouter from "./licenses";
import dashboardRouter from "./dashboard";
import chatRouter from "./chat";
import liveOpsRouter from "./liveOps";
import adminRouter from "./admin";
import storageRouter from "./storage";
import applicationsRouter from "./applications";
import policiesRouter from "./policies";
import systemRouter from "./system";
import auditRouter from "./audit";
import myPayrollRouter from "./myPayroll";
import notificationsRouter from "./notifications";
import appVersionsRouter from "./appVersions";
import shiftSwapsRouter from "./shiftSwaps";
import totpRouter from "./totp";
import licenseRenewalsRouter from "./licenseRenewals";
import incidentSharesRouter from "./incidentShares";
import employeeSharesRouter from "./employeeShares";
import availabilityRouter from "./availability";
import patrolRouter from "./patrol";
import darRouter from "./dar";
import trainingsRouter from "./trainings";
import exportsRouter from "./exports";
import radioRouter from "./radio";
import dispatchRouter from "./dispatch";
import brandConfigRouter from "./brandConfig";
import orgDirectoryRouter from "./orgDirectory";
import clientPortalRouter from "./clientPortal";
import subcontractorPayRunRouter from "./subcontractorPayRun";
import subcontractorRouter from "./subcontractor";
import schedulerWebhookRouter from "./schedulerWebhook";
import schedulerAdminRouter from "./schedulerAdmin";
import controlPlaneRouter from "./controlPlane";
import paymentDiscrepanciesRouter from "./paymentDiscrepancies";
import platformRouter from "./platform";
import agreementSignaturesRouter from "./agreementSignatures";
import leadsRouter from "./leads";
import searchRouter from "./search";
import analyticsRouter from "./analytics";
import adminTasksRouter from "./adminTasks";
import employeeReportsRouter from "./employeeReports";
import companyOwnersRouter from "./companyOwners";
import permissionsRouter from "./permissions";
import { auditLogMiddleware } from "../lib/auditLog";

const router: IRouter = Router();

// Audit log first so every downstream write is recorded. The middleware
// only persists 2xx writes and runs after the response is sent — so it
// adds no latency to the request path.
router.use(auditLogMiddleware);

// Public brand config — no auth required, registered before auth middleware.
router.use(brandConfigRouter);

// Public organization directory — resolves a multi-org code to a customer
// backend origin. No auth; registered before auth middleware. Rate-limited.
router.use(orgDirectoryRouter);

router.use(healthRouter);
router.use(authRouter);
router.use(employeesRouter);
router.use(clientsRouter);
router.use(sitesRouter);
router.use(shiftsRouter);
// Protection-detail (PPO) package routes share the /shifts prefix so the
// audit middleware classifies the PUT as shifts.write (with counts-only
// redaction — see lib/auditLog.ts).
router.use(protectionRouter);
router.use(timeEntriesRouter);
// ─── Feature-gating convention ────────────────────────────────────────────────
// Each router that covers a paid or optional product surface MUST apply its own
// `requireFeature()` gate *inside* the router file, via a path-scoped call:
//
//   router.use(["/your-path", "/your-path/:id"], requireFeature("<key>"));
//
// Path-scoping means the gate fires ONLY when one of that router's own paths is
// matched — disabling one feature cannot accidentally block unrelated endpoints
// mounted later in this file.
//
// MANDATORY: after adding a new router.use() call below you MUST add the router
// variable name to one of the two explicit allow-lists in:
//
//   src/__tests__/featureGating.test.ts
//
//   • SELF_GATED_ROUTERS  — paid/optional surfaces (has requireFeature() inside)
//   • CORE_UNGATED_ROUTERS — ships in every tier (auth, health, shifts, …)
//
// The guard test "every router is on the core allow-list or is self-gated" will
// fail loudly with remediation instructions if you forget — preventing a new
// paid product area from shipping without a gate.
// ──────────────────────────────────────────────────────────────────────────────
router.use(payrollRouter);
router.use(invoicesRouter);
router.use(incidentsRouter);
router.use(licensesRouter);
router.use(dashboardRouter);
router.use(chatRouter);
router.use(liveOpsRouter);
router.use(adminRouter);
router.use(companyOwnersRouter);
router.use(permissionsRouter);
router.use(adminTasksRouter);
router.use(employeeReportsRouter);
router.use(storageRouter);
router.use(applicationsRouter);
router.use(policiesRouter);
router.use(systemRouter);
router.use(platformRouter);
router.use(agreementSignaturesRouter);
router.use(auditRouter);
router.use(myPayrollRouter);
router.use(notificationsRouter);
router.use(appVersionsRouter);
router.use(shiftSwapsRouter);
router.use(totpRouter);
router.use(licenseRenewalsRouter);
router.use(incidentSharesRouter);
router.use(employeeSharesRouter);
router.use(availabilityRouter);
router.use(patrolRouter);
router.use(darRouter);
router.use(trainingsRouter);
router.use(exportsRouter);
router.use(radioRouter);
router.use(dispatchRouter);
router.use(clientPortalRouter);
router.use(subcontractorPayRunRouter);
router.use(subcontractorRouter);
router.use(schedulerWebhookRouter);
router.use(schedulerAdminRouter);
// Remote control-plane management surface — HMAC-authed (own auth), inert
// (503) until CONTROL_PLANE_SHARED_SECRET is set. Core infra, not a paid
// feature, so it is intentionally ungated.
router.use(controlPlaneRouter);
router.use(paymentDiscrepanciesRouter);
// Public sales / sign-up lead capture from the marketing site (no auth).
router.use(leadsRouter);
// Global search — admin-only, ungated at the router level. Individual domain
// results are excluded by internal isFeatureEnabled checks (same pattern as
// dashboard and exports cross-domain guards). See routes/search.ts.
router.use(searchRouter);
router.use(analyticsRouter);

// Catch-all JSON 404 for any unmatched /api/* path. Without this, an unknown
// API route falls through to Express's default finalhandler, which returns a
// `text/html` "Cannot GET ..." page — an HTML body to an API client. Mounted
// last so it only fires after every real route has had a chance to match. The
// root marketing fallback (staticFrontends) is mounted AFTER `/api` but already
// excludes `/api`, so unknown API paths terminate here with a JSON 404 and are
// never swallowed by the marketing shell.
router.use((req, res) => {
  res.status(404).json({ error: "not_found", message: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

export default router;
