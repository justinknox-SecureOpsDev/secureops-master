import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import employeesRouter from "./employees";
import clientsRouter from "./clients";
import sitesRouter from "./sites";
import shiftsRouter from "./shifts";
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
import { auditLogMiddleware } from "../lib/auditLog";

const router: IRouter = Router();

// Audit log first so every downstream write is recorded. The middleware
// only persists 2xx writes and runs after the response is sent — so it
// adds no latency to the request path.
router.use(auditLogMiddleware);

router.use(healthRouter);
router.use(authRouter);
router.use(employeesRouter);
router.use(clientsRouter);
router.use(sitesRouter);
router.use(shiftsRouter);
router.use(timeEntriesRouter);
router.use(payrollRouter);
router.use(invoicesRouter);
router.use(incidentsRouter);
router.use(licensesRouter);
router.use(dashboardRouter);
router.use(chatRouter);
router.use(liveOpsRouter);
router.use(adminRouter);
router.use(storageRouter);
router.use(applicationsRouter);
router.use(policiesRouter);
router.use(systemRouter);
router.use(auditRouter);
router.use(myPayrollRouter);
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

export default router;
