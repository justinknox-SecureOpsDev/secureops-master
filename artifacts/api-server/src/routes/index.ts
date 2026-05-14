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

const router: IRouter = Router();

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

export default router;
