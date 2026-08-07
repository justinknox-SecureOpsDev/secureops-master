/**
 * Client Portal API routes  /client/*
 *
 * Security model: every endpoint calls `getClientSiteIds(userId)` first and
 * filters ALL data to only rows whose siteId is in that set. This single
 * chokepoint prevents a client user from reading another org's data.
 *
 * Admin routes for coverage-request review and client-user management live
 * here too: /admin/shift-requests/* and /admin/client-users/*.
 * The audit log middleware already covers /admin/* paths automatically.
 */
import { Router, type IRouter } from "express";
import { and, eq, inArray, gte, lte, desc, isNotNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod/v4";
import {
  db,
  usersTable,
  clientsTable,
  sitesTable,
  shiftsTable,
  shiftAssignmentsTable,
  incidentsTable,
  dailyActivityReportsTable,
  invoicesTable,
  shiftRequestsTable,
  licensesTable,
} from "@workspace/db";
import { requireClient, requireAdmin } from "../middlewares/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { buildIncidentReportPdf } from "../lib/incidentPdf";
import { buildInvoicePdf } from "../lib/invoicePdf";
import { sendEmail } from "../lib/email";

const objectStorageService = new ObjectStorageService();

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Security backbone: resolve the set of site IDs the caller may access.
// ---------------------------------------------------------------------------

export class ClientScopeError extends Error {
  constructor(
    public httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getClientSiteIds(userId: string): Promise<{
  siteIds: string[];
  clientId: string;
  client: typeof clientsTable.$inferSelect;
}> {
  const [user] = await db
    .select({ clientId: usersTable.clientId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user?.clientId) {
    throw new ClientScopeError(
      403,
      "This account is not associated with a client organisation.",
    );
  }

  const clientId = user.clientId;
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId))
    .limit(1);

  if (!client) {
    throw new ClientScopeError(403, "Client organisation not found.");
  }

  const sites = await db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(eq(sitesTable.clientId, clientId));

  return { siteIds: sites.map((s) => s.id), clientId, client };
}

function handleScopeError(
  err: unknown,
  res: import("express").Response,
): boolean {
  if (err instanceof ClientScopeError) {
    res
      .status(err.httpStatus)
      .json({ error: "Forbidden", message: err.message });
    return true;
  }
  return false;
}

function getTrustedBaseUrl(): string | null {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (replitDomain) return `https://${replitDomain}`;
  return null;
}

/**
 * For sent/overdue invoices whose processingFeeAmount is NULL (generated before
 * the fee toggle was enabled), compute the effective fee on-the-fly using the
 * site's current processing-fee setting and rate so client-facing reads always
 * reflect the correct current total.
 *
 * Paid invoices are intentionally left untouched — they are settled financial
 * records and must reflect what was actually charged, not the current fee rate.
 */
function computeEffectiveFee(params: {
  subtotal: string | null;
  processingFeeAmount: string | null;
  processingFeeRate: string | null;
  totalAmount: string | null;
  siteProcessingFeeEnabled: boolean | null;
  siteProcessingFeeRate: string | null;
  status: string;
}): {
  feeAmount: string | null;
  feeRate: string | null;
  totalAmount: string;
  isStale: boolean;
} {
  // Paid invoices: return stored values unchanged (settled financial record).
  if (params.status !== "sent" && params.status !== "overdue") {
    return {
      feeAmount: params.processingFeeAmount,
      feeRate: params.processingFeeRate,
      totalAmount: params.totalAmount ?? "0",
      isStale: false,
    };
  }

  const storedFee = parseFloat(String(params.processingFeeAmount ?? "0")) || 0;
  const siteHasFee = Boolean(params.siteProcessingFeeEnabled);

  if (storedFee === 0 && siteHasFee) {
    const subtotal = parseFloat(String(params.subtotal ?? "0")) || 0;
    const feeRate = parseFloat(String(params.siteProcessingFeeRate ?? "0")) || 0;
    if (feeRate > 0) {
      const feeAmount = Math.round(subtotal * feeRate / 100 * 100) / 100;
      const total = Math.round((subtotal + feeAmount) * 100) / 100;
      return {
        feeAmount: String(feeAmount),
        feeRate: String(feeRate),
        totalAmount: String(total),
        isStale: true,
      };
    }
  }

  return {
    feeAmount: params.processingFeeAmount,
    feeRate: params.processingFeeRate,
    totalAmount: params.totalAmount ?? "0",
    isStale: false,
  };
}

// ===========================================================================
// CLIENT PORTAL — /client/*
// ===========================================================================

// GET /client/me
router.get("/client/me", requireClient, async (req, res): Promise<void> => {
  try {
    const { client, siteIds, clientId } = await getClientSiteIds(
      req.user!.userId,
    );
    const sites =
      siteIds.length > 0
        ? await db
            .select({
              id: sitesTable.id,
              name: sitesTable.name,
              address: sitesTable.address,
            })
            .from(sitesTable)
            .where(inArray(sitesTable.id, siteIds))
        : [];
    res.json({
      client: {
        id: client.id,
        name: client.name,
        contactName: client.contactName,
        paymentTermsDays: client.paymentTermsDays,
      },
      sites,
      clientId,
    });
  } catch (err) {
    if (handleScopeError(err, res)) return;
    req.log.error({ err }, "[client/me] error");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /client/contract
// Returns a short-lived signed download URL for the client's contract document.
// The contractDocKey is stored on the client record (admin-managed); we resolve
// it here so client-portal users can view/download without admin storage access.
router.get("/client/contract", requireClient, async (req, res): Promise<void> => {
  try {
    const { client } = await getClientSiteIds(req.user!.userId);
    if (!client.contractDocKey) {
      res.status(404).json({ error: "Not Found", message: "No contract on file for this client." });
      return;
    }
    const url = await objectStorageService.getSignedDownloadURL(client.contractDocKey);
    res.json({ url });
  } catch (err) {
    if (handleScopeError(err, res)) return;
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Not Found", message: "Contract file not found." });
      return;
    }
    req.log.error({ err }, "[client/contract] error");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /client/sites
router.get("/client/sites", requireClient, async (req, res): Promise<void> => {
  try {
    const { siteIds } = await getClientSiteIds(req.user!.userId);
    if (siteIds.length === 0) {
      res.json([]);
      return;
    }
    // Active sites only: this list feeds the coverage-request site picker, so
    // retired (inactive) sites must not be offered. Historical surfaces
    // (invoices, DARs, shifts) join site names directly and are unaffected.
    const sites = await db
      .select({
        id: sitesTable.id,
        name: sitesTable.name,
        address: sitesTable.address,
      })
      .from(sitesTable)
      .where(and(inArray(sitesTable.id, siteIds), eq(sitesTable.status, "active")));
    res.json(sites);
  } catch (err) {
    if (handleScopeError(err, res)) return;
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /client/shifts — upcoming shifts at client sites, sanitized
router.get(
  "/client/shifts",
  requireClient,
  async (req, res): Promise<void> => {
    try {
      const { siteIds } = await getClientSiteIds(req.user!.userId);
      if (siteIds.length === 0) {
        res.json([]);
        return;
      }

      const now = new Date();
      const from = req.query.from ? new Date(req.query.from as string) : now;
      const to = req.query.to
        ? new Date(req.query.to as string)
        : new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

      const shifts = await db
        .select({
          id: shiftsTable.id,
          title: shiftsTable.title,
          siteId: shiftsTable.siteId,
          siteName: sitesTable.name,
          startTime: shiftsTable.startTime,
          endTime: shiftsTable.endTime,
          requiredLicenseLevel: shiftsTable.requiredLicenseLevel,
          headcount: shiftsTable.headcount,
          status: shiftsTable.status,
          // Intentionally omitting shiftsTable.notes — internal admin
          // instructions are not client-facing.
        })
        .from(shiftsTable)
        .leftJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
        .where(
          and(
            inArray(shiftsTable.siteId, siteIds),
            // Filter on endTime >= from so currently-active shifts (startTime < now
            // but endTime > now) are included alongside upcoming ones.
            gte(shiftsTable.endTime, from),
            lte(shiftsTable.startTime, to),
          ),
        )
        .orderBy(shiftsTable.startTime);

      if (shifts.length === 0) {
        res.json([]);
        return;
      }

      const shiftIds = shifts.map((s) => s.id);
      const assignments = await db
        .select({
          shiftId: shiftAssignmentsTable.shiftId,
          status: shiftAssignmentsTable.status,
          employeeId: shiftAssignmentsTable.employeeId,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
        })
        .from(shiftAssignmentsTable)
        .leftJoin(
          usersTable,
          eq(shiftAssignmentsTable.employeeId, usersTable.id),
        )
        .where(
          and(
            inArray(shiftAssignmentsTable.shiftId, shiftIds),
            eq(shiftAssignmentsTable.status, "accepted"),
          ),
        );

      const empIds = [
        ...new Set(
          assignments.map((a) => a.employeeId).filter(Boolean),
        ),
      ] as string[];
      const licenseMap = new Map<string, number>();

      if (empIds.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const licenses = await db
          .select({
            employeeId: licensesTable.employeeId,
            level: licensesTable.level,
          })
          .from(licensesTable)
          .where(
            and(
              inArray(licensesTable.employeeId, empIds),
              gte(licensesTable.expiryDate, today),
            ),
          );
        for (const lic of licenses) {
          const cur = licenseMap.get(lic.employeeId) ?? 0;
          if ((lic.level ?? 0) > cur) licenseMap.set(lic.employeeId, lic.level ?? 0);
        }
      }

      const assignmentMap = new Map<string, typeof assignments>();
      for (const a of assignments) {
        if (!assignmentMap.has(a.shiftId)) assignmentMap.set(a.shiftId, []);
        assignmentMap.get(a.shiftId)!.push(a);
      }

      res.json(
        shifts.map((s) => ({
          ...s,
          officers: (assignmentMap.get(s.id) ?? []).map((a) => ({
            // Sanitized: first initial + last name only, no contact info
            name: a.firstName
              ? `${a.firstName[0]}. ${a.lastName ?? ""}`.trim()
              : "Officer",
            licenseLevel: a.employeeId
              ? (licenseMap.get(a.employeeId) ?? null)
              : null,
          })),
        })),
      );
    } catch (err) {
      if (handleScopeError(err, res)) return;
      req.log.error({ err }, "[client/shifts] error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

// GET /client/incidents — incidents at client sites (sanitized: no adminNotes/full officer PII)
router.get(
  "/client/incidents",
  requireClient,
  async (req, res): Promise<void> => {
    try {
      const { siteIds } = await getClientSiteIds(req.user!.userId);
      if (siteIds.length === 0) {
        res.json([]);
        return;
      }

      // Incidents link to shifts; shifts link to sites. Use inner-join logic:
      // incidents with no shiftId or a shift at a non-client site are excluded.
      const rows = await db
        .select({
          id: incidentsTable.id,
          title: incidentsTable.title,
          description: incidentsTable.description,
          severity: incidentsTable.severity,
          status: incidentsTable.status,
          locationDescription: incidentsTable.locationDescription,
          occurredAt: incidentsTable.occurredAt,
          resolvedAt: incidentsTable.resolvedAt,
          createdAt: incidentsTable.createdAt,
          siteName: sitesTable.name,
          siteId: shiftsTable.siteId,
        })
        .from(incidentsTable)
        .innerJoin(shiftsTable, eq(incidentsTable.shiftId, shiftsTable.id))
        .innerJoin(sitesTable, eq(shiftsTable.siteId, sitesTable.id))
        .where(inArray(shiftsTable.siteId, siteIds))
        .orderBy(desc(incidentsTable.occurredAt));

      // adminNotes, officer email/phone, full officer name deliberately omitted
      res.json(rows);
    } catch (err) {
      if (handleScopeError(err, res)) return;
      req.log.error({ err }, "[client/incidents] error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

// GET /client/incidents/:id/pdf — redacted incident PDF
router.get(
  "/client/incidents/:id/pdf",
  requireClient,
  async (req, res): Promise<void> => {
    try {
      const { siteIds } = await getClientSiteIds(req.user!.userId);
      const id = String(req.params.id);

      const [ownership] = await db
        .select({ siteId: shiftsTable.siteId })
        .from(incidentsTable)
        .innerJoin(shiftsTable, eq(incidentsTable.shiftId, shiftsTable.id))
        .where(
          and(
            eq(incidentsTable.id, id),
            isNotNull(incidentsTable.shiftId),
          ),
        )
        .limit(1);

      if (!ownership) {
        res.status(404).json({ error: "Not Found" });
        return;
      }
      if (!ownership.siteId || !siteIds.includes(ownership.siteId)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const payload = await buildIncidentReportPdf(id, {
        redactForPublicShare: true,
      });
      if (!payload) {
        res.status(404).json({ error: "Not Found" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${payload.filename}"`,
      );
      res.setHeader("Cache-Control", "private, no-store");
      payload.stream.pipe(res);
    } catch (err) {
      if (handleScopeError(err, res)) return;
      req.log.error({ err }, "[client/incidents/pdf] error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

// GET /client/dar — daily activity reports at client sites (sanitized)
router.get("/client/dar", requireClient, async (req, res): Promise<void> => {
  try {
    const { siteIds } = await getClientSiteIds(req.user!.userId);
    if (siteIds.length === 0) {
      res.json({ reports: [] });
      return;
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await db
      .select({
        id: dailyActivityReportsTable.id,
        reportDate: dailyActivityReportsTable.reportDate,
        submittedAt: dailyActivityReportsTable.submittedAt,
        summary: dailyActivityReportsTable.summary,
        observations: dailyActivityReportsTable.observations,
        visitorsCount: dailyActivityReportsTable.visitorsCount,
        patrolsCount: dailyActivityReportsTable.patrolsCount,
        incidentsNoted: dailyActivityReportsTable.incidentsNoted,
        weather: dailyActivityReportsTable.weather,
        siteId: dailyActivityReportsTable.siteId,
        siteName: sitesTable.name,
      })
      .from(dailyActivityReportsTable)
      .leftJoin(
        sitesTable,
        eq(dailyActivityReportsTable.siteId, sitesTable.id),
      )
      .where(inArray(dailyActivityReportsTable.siteId, siteIds))
      .orderBy(desc(dailyActivityReportsTable.submittedAt))
      .limit(limit);

    // signature field deliberately excluded
    res.json({ reports: rows });
  } catch (err) {
    if (handleScopeError(err, res)) return;
    req.log.error({ err }, "[client/dar] error");
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /client/dar/:id/pdf — DAR PDF download (scoped to client sites)
router.get(
  "/client/dar/:id/pdf",
  requireClient,
  async (req, res): Promise<void> => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(400).json({ error: "Bad Request", message: "Invalid id" });
      return;
    }
    try {
      const { siteIds } = await getClientSiteIds(req.user!.userId);
      if (siteIds.length === 0) {
        res.status(404).json({ error: "Not Found" });
        return;
      }

      // Verify the DAR belongs to one of the client's sites before serving PDF.
      const [dar] = await db
        .select({ siteId: dailyActivityReportsTable.siteId })
        .from(dailyActivityReportsTable)
        .where(eq(dailyActivityReportsTable.id, idParse.data))
        .limit(1);

      if (!dar) {
        res.status(404).json({ error: "Not Found" });
        return;
      }
      if (!siteIds.includes(dar.siteId ?? "")) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { buildDarPdf } = await import("../lib/darPdf");
      const payload = await buildDarPdf(idParse.data, { redactForClient: true });
      if (!payload) {
        res.status(404).json({ error: "Not Found" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${payload.filename}"`,
      );
      res.setHeader("Cache-Control", "private, no-store");
      payload.stream.on("error", (err) => {
        req.log.warn({ err, darId: idParse.data }, "[client/dar/pdf] stream error");
        if (!res.headersSent) {
          res.status(500).json({ error: "PDF render failed" });
        } else {
          res.destroy(err);
        }
      });
      payload.stream.pipe(res);
    } catch (err) {
      if (handleScopeError(err, res)) return;
      req.log.warn({ err }, "[client/dar/pdf] build error");
      if (!res.headersSent) res.status(500).json({ error: "PDF render failed" });
      else res.destroy(err as Error);
    }
  },
);

// GET /client/invoices — own invoices (sent/paid/overdue, not draft)
router.get(
  "/client/invoices",
  requireClient,
  async (req, res): Promise<void> => {
    try {
      const { clientId } = await getClientSiteIds(req.user!.userId);

      const rows = await db
        .select({
          id: invoicesTable.id,
          invoiceNumber: invoicesTable.invoiceNumber,
          siteId: invoicesTable.siteId,
          siteName: sitesTable.name,
          periodStart: invoicesTable.periodStart,
          periodEnd: invoicesTable.periodEnd,
          clientName: invoicesTable.clientName,
          lineItems: invoicesTable.lineItems,
          subtotal: invoicesTable.subtotal,
          taxAmount: invoicesTable.taxAmount,
          totalAmount: invoicesTable.totalAmount,
          processingFeeAmount: invoicesTable.processingFeeAmount,
          processingFeeRate: invoicesTable.processingFeeRate,
          siteProcessingFeeEnabled: sitesTable.processingFeeEnabled,
          siteProcessingFeeRate: sitesTable.processingFeeRate,
          status: invoicesTable.status,
          dueDate: invoicesTable.dueDate,
          paidAt: invoicesTable.paidAt,
          stripeCheckoutSessionId: invoicesTable.stripeCheckoutSessionId,
          createdAt: invoicesTable.createdAt,
        })
        .from(invoicesTable)
        .leftJoin(sitesTable, eq(invoicesTable.siteId, sitesTable.id))
        .where(
          and(
            eq(invoicesTable.clientId, clientId),
            inArray(invoicesTable.status, ["sent", "paid", "overdue"]),
          ),
        )
        .orderBy(desc(invoicesTable.createdAt));

      // Apply on-the-fly fee correction for sent/overdue invoices that were
      // generated before the processing fee toggle was enabled. Paid invoices
      // are returned unchanged — they reflect what was settled.
      const corrected = rows.map((r) => {
        const eff = computeEffectiveFee({
          subtotal: r.subtotal,
          processingFeeAmount: r.processingFeeAmount,
          processingFeeRate: r.processingFeeRate,
          totalAmount: r.totalAmount,
          siteProcessingFeeEnabled: r.siteProcessingFeeEnabled ?? null,
          siteProcessingFeeRate: r.siteProcessingFeeRate ?? null,
          status: r.status,
        });
        // Strip internal site fee fields from the client-facing response.
        const { siteProcessingFeeEnabled: _feeEnabled, siteProcessingFeeRate: _feeRate, ...rest } = r;
        return {
          ...rest,
          totalAmount: eff.totalAmount,
          processingFeeAmount: eff.feeAmount,
          processingFeeRate: eff.feeRate,
        };
      });

      res.json(corrected);
    } catch (err) {
      if (handleScopeError(err, res)) return;
      req.log.error({ err }, "[client/invoices] error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

// GET /client/invoices/:id/pdf
router.get(
  "/client/invoices/:id/pdf",
  requireClient,
  async (req, res): Promise<void> => {
    try {
      const { clientId } = await getClientSiteIds(req.user!.userId);
      const id = String(req.params.id);

      const [row] = await db
        .select({
          id: invoicesTable.id,
          invoiceNumber: invoicesTable.invoiceNumber,
          clientId: invoicesTable.clientId,
          status: invoicesTable.status,
          siteId: invoicesTable.siteId,
          clientName: invoicesTable.clientName,
          clientEmail: invoicesTable.clientEmail,
          clientAddress: invoicesTable.clientAddress,
          siteName: sitesTable.name,
          siteProcessingFeeEnabled: sitesTable.processingFeeEnabled,
          siteProcessingFeeRate: sitesTable.processingFeeRate,
          periodStart: invoicesTable.periodStart,
          periodEnd: invoicesTable.periodEnd,
          dueDate: invoicesTable.dueDate,
          createdAt: invoicesTable.createdAt,
          lineItems: invoicesTable.lineItems,
          subtotal: invoicesTable.subtotal,
          taxAmount: invoicesTable.taxAmount,
          totalAmount: invoicesTable.totalAmount,
          processingFeeRate: invoicesTable.processingFeeRate,
          processingFeeAmount: invoicesTable.processingFeeAmount,
          notes: invoicesTable.notes,
        })
        .from(invoicesTable)
        .leftJoin(sitesTable, eq(invoicesTable.siteId, sitesTable.id))
        .where(eq(invoicesTable.id, id))
        .limit(1);

      if (!row) {
        res.status(404).json({ error: "Not Found" });
        return;
      }
      if (row.clientId !== clientId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (row.status === "draft") {
        res
          .status(403)
          .json({ error: "Forbidden", message: "Invoice not yet sent." });
        return;
      }

      const toDateStr = (v: string | Date | null): string => {
        if (!v) return "";
        if (typeof v === "string") return v;
        return (v as Date).toISOString().slice(0, 10);
      };

      type LI = {
        description: string;
        level?: number | null;
        hours?: number | null;
        rate?: number | null;
        amount: number;
      };

      // Compute effective fee: if this is a sent/overdue invoice whose
      // processingFeeAmount is NULL (generated before the fee toggle was
      // enabled) and the site now has fees on, correct the total on-the-fly
      // so the PDF reflects the actual current balance due.
      const eff = computeEffectiveFee({
        subtotal: row.subtotal,
        processingFeeAmount: row.processingFeeAmount,
        processingFeeRate: row.processingFeeRate,
        totalAmount: row.totalAmount,
        siteProcessingFeeEnabled: row.siteProcessingFeeEnabled ?? null,
        siteProcessingFeeRate: row.siteProcessingFeeRate ?? null,
        status: row.status,
      });

      // When the total was corrected, add a brief note on the PDF so the client
      // knows the fee was applied retroactively and the total has been updated.
      const staleFeeNote = eff.isStale
        ? `A processing fee has been applied to this invoice. The total above reflects the current amount due.`
        : null;

      const { filename, stream } = buildInvoicePdf({
        invoiceNumber: row.invoiceNumber,
        clientName: row.clientName,
        clientEmail: row.clientEmail,
        clientAddress: row.clientAddress,
        siteName: row.siteName ?? null,
        periodStart: toDateStr(row.periodStart),
        periodEnd: toDateStr(row.periodEnd),
        dueDate: toDateStr(row.dueDate),
        createdAt: row.createdAt ?? new Date(),
        lineItems: (row.lineItems as LI[] | null) ?? null,
        subtotal: row.subtotal,
        taxAmount: row.taxAmount,
        totalAmount: eff.totalAmount,
        processingFeeRate: eff.feeRate,
        processingFeeAmount: eff.feeAmount,
        notes: row.notes,
        staleFeeNote,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.setHeader("Cache-Control", "private, no-store");
      stream.pipe(res);
      stream.on("error", (err) => {
        req.log.error({ err }, "[client/invoices/pdf] stream error");
      });
    } catch (err) {
      if (handleScopeError(err, res)) return;
      req.log.error({ err }, "[client/invoices/pdf] error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

// POST /client/invoices/:id/checkout — create Stripe Checkout session
router.post(
  "/client/invoices/:id/checkout",
  requireClient,
  async (req, res): Promise<void> => {
    try {
      const { clientId } = await getClientSiteIds(req.user!.userId);
      const id = String(req.params.id);

      const [invoice] = await db
        .select({
          id: invoicesTable.id,
          clientId: invoicesTable.clientId,
          invoiceNumber: invoicesTable.invoiceNumber,
          clientName: invoicesTable.clientName,
          subtotal: invoicesTable.subtotal,
          totalAmount: invoicesTable.totalAmount,
          processingFeeAmount: invoicesTable.processingFeeAmount,
          processingFeeRate: invoicesTable.processingFeeRate,
          status: invoicesTable.status,
          siteProcessingFeeEnabled: sitesTable.processingFeeEnabled,
          siteProcessingFeeRate: sitesTable.processingFeeRate,
        })
        .from(invoicesTable)
        .leftJoin(sitesTable, eq(invoicesTable.siteId, sitesTable.id))
        .where(eq(invoicesTable.id, id))
        .limit(1);

      if (!invoice) {
        res.status(404).json({ error: "Not Found" });
        return;
      }
      if (invoice.clientId !== clientId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (invoice.status === "paid") {
        res.status(409).json({ error: "Conflict", message: "Invoice is already paid." });
        return;
      }
      if (invoice.status === "draft") {
        res.status(409).json({ error: "Conflict", message: "Invoice has not been sent yet." });
        return;
      }

      // Use the effective (fee-corrected) total so a stale invoice is always
      // charged at the current balance, not the pre-fee amount.
      const effCheckout = computeEffectiveFee({
        subtotal: invoice.subtotal,
        processingFeeAmount: invoice.processingFeeAmount,
        processingFeeRate: invoice.processingFeeRate,
        totalAmount: invoice.totalAmount,
        siteProcessingFeeEnabled: invoice.siteProcessingFeeEnabled ?? null,
        siteProcessingFeeRate: invoice.siteProcessingFeeRate ?? null,
        status: invoice.status,
      });

      const amountCents = Math.round(
        parseFloat(String(effCheckout.totalAmount ?? "0")) * 100,
      );
      if (amountCents <= 0) {
        res
          .status(400)
          .json({ error: "Bad Request", message: "Invoice amount must be greater than zero." });
        return;
      }

      const stripeKey = process.env.STRIPE_SECRET_KEY;
      const baseUrl = getTrustedBaseUrl();

      if (!stripeKey) {
        res.status(503).json({
          error: "Service Unavailable",
          message: "Online payment is not configured. Please contact your account manager.",
          stripeConfigured: false,
        });
        return;
      }

      if (!baseUrl) {
        res.status(503).json({
          error: "Service Unavailable",
          message: "Base URL is not configured. Contact your administrator.",
          stripeConfigured: false,
        });
        return;
      }

      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(stripeKey, { apiVersion: "2026-05-27.dahlia" });

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card", "us_bank_account"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `Invoice ${invoice.invoiceNumber}`,
                description: `Security services — ${invoice.clientName ?? "WCSG"}`,
              },
              unit_amount: amountCents,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${baseUrl}/admin-portal/client/invoices?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/admin-portal/client/invoices?payment=cancelled`,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
        },
      });

      await db
        .update(invoicesTable)
        .set({ stripeCheckoutSessionId: session.id })
        .where(eq(invoicesTable.id, invoice.id));

      req.log.info(
        { invoiceId: id, sessionId: session.id },
        "[client/checkout] Stripe session created",
      );
      res.json({
        checkoutUrl: session.url,
        sessionId: session.id,
        stripeConfigured: true,
      });
    } catch (err) {
      if (handleScopeError(err, res)) return;
      req.log.error({ err }, "[client/invoices/checkout] error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

// POST /client/stripe-webhook — Stripe event handler (raw body, no auth)
// NOTE: This route must receive the raw request body. In app.ts, add:
//   app.use("/api/client/stripe-webhook", express.raw({ type: "application/json" }))
// before express.json(). This is handled in app.ts registration.
router.post("/client/stripe-webhook", async (req, res): Promise<void> => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    res.status(200).json({ received: true, note: "Stripe not configured" });
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.status(400).json({ error: "Missing stripe-signature" });
    return;
  }

  let event: import("stripe").Stripe.Event;
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeKey, { apiVersion: "2026-05-27.dahlia" });
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      Array.isArray(sig) ? sig[0]! : sig,
      webhookSecret,
    );
  } catch (err) {
    req.log.warn({ err }, "[stripe-webhook] signature verification failed");
    res.status(400).json({ error: "Webhook signature invalid" });
    return;
  }

  // markInvoicePaid is idempotent: WHERE status IN (sent, overdue) prevents
  // double-updates and is safe to call from multiple event types.
  const markInvoicePaid = async (invoiceId: string, paymentIntentId: string | null) => {
    await db
      .update(invoicesTable)
      .set({
        status: "paid",
        paidAt: new Date(),
        stripePaymentIntentId: paymentIntentId,
        autoSynced: false,
      })
      .where(
        and(
          eq(invoicesTable.id, invoiceId),
          inArray(invoicesTable.status, ["sent", "overdue"]),
        ),
      );
    req.log.info({ invoiceId, paymentIntentId }, "[stripe-webhook] invoice marked paid");
  };

  try {
    if (event.type === "checkout.session.completed") {
      // Card / wallet payments: payment_status === "paid" means funds are captured.
      // ACH/bank-debit sessions land here with payment_status === "processing" —
      // we must NOT mark paid yet; wait for async_payment_succeeded below.
      const session = event.data.object as import("stripe").Stripe.Checkout.Session;
      const invoiceId = session.metadata?.invoiceId;
      const paymentIntentId =
        typeof session.payment_intent === "string" ? session.payment_intent : null;

      if (invoiceId && session.payment_status === "paid") {
        await markInvoicePaid(invoiceId, paymentIntentId);
      } else if (invoiceId && session.payment_status !== "paid") {
        // ACH / bank-debit sessions complete here with payment_status="unpaid";
        // funds settle asynchronously — authoritative mark-paid fires on
        // checkout.session.async_payment_succeeded below.
        req.log.info(
          { invoiceId, paymentStatus: session.payment_status },
          "[stripe-webhook] checkout.session.completed — async payment pending; awaiting async_payment_succeeded",
        );
      }
    } else if (event.type === "checkout.session.async_payment_succeeded") {
      // ACH/bank-debit payments: authoritative success for async payment methods.
      const session = event.data.object as import("stripe").Stripe.Checkout.Session;
      const invoiceId = session.metadata?.invoiceId;
      const paymentIntentId =
        typeof session.payment_intent === "string" ? session.payment_intent : null;

      if (invoiceId) {
        await markInvoicePaid(invoiceId, paymentIntentId);
      }
    } else if (event.type === "checkout.session.async_payment_failed") {
      // ACH payment failed (e.g., insufficient funds, bank rejection).
      const session = event.data.object as import("stripe").Stripe.Checkout.Session;
      const invoiceId = session.metadata?.invoiceId;
      req.log.warn({ invoiceId }, "[stripe-webhook] async payment failed — invoice remains unpaid");
    }
  } catch (err) {
    req.log.error({ err, eventType: event.type }, "[stripe-webhook] error processing event");
  }

  res.json({ received: true });
});

// POST /client/shift-requests — submit coverage request

/** Parse "HH:MM" into { h, m } and validate bounds. */
function parseHHMM(s: string): { h: number; m: number } | null {
  const parts = s.split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

const ShiftRequestBody = z.object({
  siteId: z.string().uuid(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD"),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD"),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "startTime must be HH:MM"),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, "endTime must be HH:MM"),
  l2Count: z.number().int().min(0).max(100).default(0),
  l3Count: z.number().int().min(0).max(100).default(0),
  l4Count: z.number().int().min(0).max(100).default(0),
  notes: z.string().max(2000).optional(),
});

router.post(
  "/client/shift-requests",
  requireClient,
  async (req, res): Promise<void> => {
    try {
      const { clientId, siteIds } = await getClientSiteIds(req.user!.userId);

      const parsed = ShiftRequestBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
        return;
      }
      const body = parsed.data;

      if (!siteIds.includes(body.siteId)) {
        res.status(403).json({
          error: "Forbidden",
          message: "Site does not belong to your organisation.",
        });
        return;
      }
      // Retired sites can't take new coverage — mirrors the POST /shifts guard.
      const [requestedSite] = await db
        .select({ status: sitesTable.status })
        .from(sitesTable)
        .where(eq(sitesTable.id, body.siteId));
      if (requestedSite?.status !== "active") {
        res.status(400).json({
          error: "Bad Request",
          message: "This site is inactive — coverage requests can only be submitted for active sites.",
        });
        return;
      }
      if (body.l2Count + body.l3Count + body.l4Count === 0) {
        res.status(400).json({
          error: "Bad Request",
          message: "At least one officer (L2/L3/L4) must be requested.",
        });
        return;
      }

      // Semantic date/time validation (shape already checked by Zod).
      const startTs = new Date(`${body.startDate}T00:00:00Z`).getTime();
      const endTs = new Date(`${body.endDate}T00:00:00Z`).getTime();
      if (isNaN(startTs) || isNaN(endTs)) {
        res.status(400).json({ error: "Bad Request", message: "Invalid date value." });
        return;
      }
      if (endTs < startTs) {
        res.status(400).json({ error: "Bad Request", message: "endDate must be on or after startDate." });
        return;
      }
      const MAX_SPAN_DAYS = 90;
      if ((endTs - startTs) / 86_400_000 > MAX_SPAN_DAYS) {
        res.status(400).json({ error: "Bad Request", message: `Coverage window cannot exceed ${MAX_SPAN_DAYS} days.` });
        return;
      }
      if (!parseHHMM(body.startTime) || !parseHHMM(body.endTime)) {
        res.status(400).json({ error: "Bad Request", message: "startTime and endTime must be valid HH:MM (00-23:00-59)." });
        return;
      }

      const [row] = await db
        .insert(shiftRequestsTable)
        .values({
          clientId,
          siteId: body.siteId,
          startDate: body.startDate,
          endDate: body.endDate,
          startTime: body.startTime,
          endTime: body.endTime,
          l2Count: body.l2Count,
          l3Count: body.l3Count,
          l4Count: body.l4Count,
          notes: body.notes ?? null,
          submittedByUserId: req.user!.userId,
          status: "pending",
        })
        .returning();

      res.status(201).json(row);
    } catch (err) {
      if (handleScopeError(err, res)) return;
      req.log.error({ err }, "[client/shift-requests POST] error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

// GET /client/shift-requests — list own coverage requests
router.get(
  "/client/shift-requests",
  requireClient,
  async (req, res): Promise<void> => {
    try {
      const { clientId } = await getClientSiteIds(req.user!.userId);

      const rows = await db
        .select({
          id: shiftRequestsTable.id,
          siteId: shiftRequestsTable.siteId,
          siteName: sitesTable.name,
          startDate: shiftRequestsTable.startDate,
          endDate: shiftRequestsTable.endDate,
          startTime: shiftRequestsTable.startTime,
          endTime: shiftRequestsTable.endTime,
          l2Count: shiftRequestsTable.l2Count,
          l3Count: shiftRequestsTable.l3Count,
          l4Count: shiftRequestsTable.l4Count,
          notes: shiftRequestsTable.notes,
          status: shiftRequestsTable.status,
          adminNote: shiftRequestsTable.adminNote,
          createdAt: shiftRequestsTable.createdAt,
          reviewedAt: shiftRequestsTable.reviewedAt,
        })
        .from(shiftRequestsTable)
        .leftJoin(sitesTable, eq(shiftRequestsTable.siteId, sitesTable.id))
        .where(eq(shiftRequestsTable.clientId, clientId))
        .orderBy(desc(shiftRequestsTable.createdAt));

      res.json(rows);
    } catch (err) {
      if (handleScopeError(err, res)) return;
      req.log.error({ err }, "[client/shift-requests GET] error");
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

// ===========================================================================
// ADMIN — client user management
// ===========================================================================

// GET /admin/client-users
router.get(
  "/admin/client-users",
  requireAdmin,
  async (_req, res): Promise<void> => {
    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        status: usersTable.status,
        clientId: usersTable.clientId,
        clientName: clientsTable.name,
        createdAt: usersTable.createdAt,
        lastLoginAt: usersTable.lastLoginAt,
        mustChangePassword: usersTable.mustChangePassword,
        invitedAt: usersTable.invitedAt,
      })
      .from(usersTable)
      .leftJoin(clientsTable, eq(usersTable.clientId, clientsTable.id))
      .where(eq(usersTable.role, "client"))
      .orderBy(desc(usersTable.createdAt));
    res.json(rows);
  },
);

// POST /admin/client-users/invite
const InviteClientUserBody = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  clientId: z.string().uuid(),
});

router.post(
  "/admin/client-users/invite",
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = InviteClientUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Bad Request", issues: parsed.error.issues });
      return;
    }
    const { email, firstName, lastName, clientId } = parsed.data;

    const [client] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId))
      .limit(1);
    if (!client) {
      res.status(404).json({ error: "Not Found", message: "Client organisation not found." });
      return;
    }

    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase()))
      .limit(1);

    const baseUrl = getTrustedBaseUrl();
    const loginUrl = baseUrl ? `${baseUrl}/admin-portal/client` : null;

    if (existing) {
      if (
        existing.role !== "client" ||
        (existing.status !== "pending" && existing.status !== "inactive")
      ) {
        res.status(409).json({
          error: "Conflict",
          message: "A user with this email already exists and cannot be re-provisioned as a client.",
        });
        return;
      }
      const tempPassword = generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      // Bump tokensValidAfter so any JWT the user held before their account
      // was deactivated cannot silently resume being valid on re-invite.
      // The user must log in with the newly issued credentials.
      const reactivatedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const [updated] = await db
        .update(usersTable)
        .set({
          clientId,
          passwordHash,
          tempPasswordPlain: tempPassword,
          tempPasswordSetAt: new Date(),
          mustChangePassword: true,
          status: "active",
          // Rotate the session watermark when reactivating so any previously
          // issued tokens for this user are immediately invalidated. The user
          // must sign in fresh with their new temp password.
          tokensValidAfter: new Date(),
        })
        .where(eq(usersTable.id, existing.id))
        .returning();

      const emailSent = await sendClientInviteEmail({
        user: updated,
        clientName: client.name,
        tempPassword,
        loginUrl,
      });

      res.status(200).json({
        id: updated.id,
        email: updated.email,
        status: "reinvited",
        emailSent,
        loginUrl,
        // Return plaintext only when email failed — admin must share manually.
        tempPassword: emailSent ? undefined : tempPassword,
      });
      return;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const [user] = await db
      .insert(usersTable)
      .values({
        email: email.toLowerCase(),
        firstName,
        lastName,
        passwordHash,
        role: "client",
        status: "active",
        clientId,
        mustChangePassword: true,
        tempPasswordPlain: tempPassword,
        tempPasswordSetAt: new Date(),
      })
      .returning();

    const emailSent = await sendClientInviteEmail({
      user,
      clientName: client.name,
      tempPassword,
      loginUrl,
    });

    res.status(201).json({
      id: user.id,
      email: user.email,
      status: "created",
      emailSent,
      loginUrl,
      // Only in response body on creation so admin can share manually if SMTP is off
      tempPassword: emailSent ? undefined : tempPassword,
    });
  },
);

// DELETE /admin/client-users/:id — deactivate
router.delete(
  "/admin/client-users/:id",
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = String(req.params.id);
    const [user] = await db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    if (!user) {
      res.status(404).json({ error: "Not Found" });
      return;
    }
    if (user.role !== "client") {
      res.status(400).json({
        error: "Bad Request",
        message: "Can only deactivate client-role users via this endpoint.",
      });
      return;
    }
    await db
      .update(usersTable)
      .set({ status: "inactive" })
      .where(eq(usersTable.id, id));
    res.json({ success: true });
  },
);

// ===========================================================================
// ADMIN — coverage request review
// ===========================================================================

// GET /admin/shift-requests
router.get(
  "/admin/shift-requests",
  requireAdmin,
  async (req, res): Promise<void> => {
    const { status, clientId } = req.query as Record<string, string | undefined>;
    const conditions: ReturnType<typeof eq>[] = [];
    if (status) conditions.push(eq(shiftRequestsTable.status, status));
    if (clientId) conditions.push(eq(shiftRequestsTable.clientId, clientId));

    const rows = await db
      .select({
        id: shiftRequestsTable.id,
        clientId: shiftRequestsTable.clientId,
        clientName: clientsTable.name,
        siteId: shiftRequestsTable.siteId,
        siteName: sitesTable.name,
        startDate: shiftRequestsTable.startDate,
        endDate: shiftRequestsTable.endDate,
        startTime: shiftRequestsTable.startTime,
        endTime: shiftRequestsTable.endTime,
        l2Count: shiftRequestsTable.l2Count,
        l3Count: shiftRequestsTable.l3Count,
        l4Count: shiftRequestsTable.l4Count,
        notes: shiftRequestsTable.notes,
        status: shiftRequestsTable.status,
        adminNote: shiftRequestsTable.adminNote,
        createdAt: shiftRequestsTable.createdAt,
        reviewedAt: shiftRequestsTable.reviewedAt,
        createdShiftIds: shiftRequestsTable.createdShiftIds,
      })
      .from(shiftRequestsTable)
      .leftJoin(clientsTable, eq(shiftRequestsTable.clientId, clientsTable.id))
      .leftJoin(sitesTable, eq(shiftRequestsTable.siteId, sitesTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(shiftRequestsTable.createdAt));

    res.json(rows);
  },
);

// POST /admin/shift-requests/:id/approve
const ApproveRequestBody = z.object({
  adminNote: z.string().max(2000).optional(),
});

router.post(
  "/admin/shift-requests/:id/approve",
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = String(req.params.id);
    const parsed = ApproveRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Bad Request", message: parsed.error.message });
      return;
    }

    // First fetch context (site + client rates) we need for shift creation.
    const rows = await db
      .select({
        sr: shiftRequestsTable,
        site: sitesTable,
        client: clientsTable,
      })
      .from(shiftRequestsTable)
      .leftJoin(sitesTable, eq(shiftRequestsTable.siteId, sitesTable.id))
      .leftJoin(clientsTable, eq(shiftRequestsTable.clientId, clientsTable.id))
      .where(eq(shiftRequestsTable.id, id))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "Not Found" });
      return;
    }

    const { sr, site, client } = rows[0]!;

    // Pre-check to give a clear 409 before entering the transaction.
    if (sr.status !== "pending") {
      res.status(409).json({
        error: "Conflict",
        message: `Request is already ${sr.status}.`,
      });
      return;
    }

    // Approval inserts shifts directly (bypasses POST /shifts), so the
    // inactive-site guard must be re-applied here: a site retired after the
    // request was submitted must not receive new shifts.
    if (site && site.status !== "active") {
      res.status(400).json({
        error: "Bad Request",
        message: "This site is inactive — reactivate it before approving coverage for it.",
      });
      return;
    }

    // Build shift creation data outside the transaction (pure computation).
    const startMs = new Date(`${sr.startDate}T00:00:00Z`).getTime();
    const endMs = new Date(`${sr.endDate}T00:00:00Z`).getTime();
    const DAY_MS = 86_400_000;

    const levelCounts = [
      { level: 2, count: sr.l2Count },
      { level: 3, count: sr.l3Count },
      { level: 4, count: sr.l4Count },
    ].filter((x) => x.count > 0);

    // Use parseHHMM for validated bounds (same helper used in submission).
    const startParts = parseHHMM(sr.startTime);
    const endParts = parseHHMM(sr.endTime);
    if (!startParts || !endParts) {
      res.status(422).json({ error: "Unprocessable", message: "Stored shift-request has invalid time fields." });
      return;
    }
    const { h: sh, m: sm } = startParts;
    const { h: eh, m: em } = endParts;
    const wrapsOvernight = eh * 60 + em <= sh * 60 + sm;

    // Canonical rate resolution matching routes/shifts.ts:
    // payRate/billRate canonical; hourlyRate/billableRate legacy aliases kept in sync.
    const pay = Number(site?.defaultPayRate ?? 0) || 0;
    const bill = Number(site?.defaultBillRate ?? 0) || 0;

    // Pre-build the shift value objects (avoids per-day db calls, pure data).
    const shiftValueSets: (typeof shiftsTable.$inferInsert)[] = [];
    for (let d = startMs; d <= endMs; d += DAY_MS) {
      const dayDate = new Date(d);
      const y = dayDate.getUTCFullYear();
      const mo = dayDate.getUTCMonth();
      const da = dayDate.getUTCDate();
      const startInstUTC = Date.UTC(y, mo, da, sh, sm, 0);
      const endDayMs = wrapsOvernight ? d + DAY_MS : d;
      const endDayDate = new Date(endDayMs);
      const endInstUTC = Date.UTC(
        endDayDate.getUTCFullYear(),
        endDayDate.getUTCMonth(),
        endDayDate.getUTCDate(),
        eh,
        em,
        0,
      );

      for (const { level, count } of levelCounts) {
        const levelLabel = level === 4 ? "L4/PPO" : `L${level}`;
        shiftValueSets.push({
          title: `Coverage — ${site?.name ?? "Site"} (${levelLabel})`,
          siteId: sr.siteId,
          clientName: client?.name ?? null,
          location: site?.address ?? site?.name ?? null,
          startTime: new Date(startInstUTC),
          endTime: new Date(endInstUTC),
          // Canonical + legacy rate fields kept in sync (matches routes/shifts.ts).
          payRate: String(pay),
          billRate: String(bill),
          hourlyRate: String(pay),
          billableRate: String(bill),
          isRepeat: false,
          status: "upcoming",
          requiredLicenseLevel: level,
          headcount: count,
          notes: sr.notes ?? null,
        });
      }
    }

    // Atomic transaction:
    //   1. UPDATE status pending→approved WHERE id AND status='pending' (acts as distributed lock).
    //      Returns 0 rows if already processed by a concurrent request → 409.
    //   2. Bulk-insert all shifts inside the same transaction.
    //   3. Patch createdShiftIds on the same row inside the transaction.
    let updated: typeof shiftRequestsTable.$inferSelect | undefined;
    try {
      await db.transaction(async (tx) => {
        // Atomic status claim — only one concurrent caller can win this UPDATE.
        const [claimed] = await tx
          .update(shiftRequestsTable)
          .set({
            status: "approved",
            adminNote: parsed.data.adminNote ?? null,
            reviewedByUserId: req.user!.userId,
            reviewedAt: new Date(),
          })
          .where(
            and(
              eq(shiftRequestsTable.id, id),
              eq(shiftRequestsTable.status, "pending"),
            ),
          )
          .returning({ id: shiftRequestsTable.id });

        if (!claimed) {
          // Another request already processed it — signal rollback via throw.
          throw Object.assign(new Error("already_processed"), { alreadyProcessed: true });
        }

        // Insert all shifts and collect IDs.
        const createdShiftIds: string[] = [];
        for (const values of shiftValueSets) {
          const [shift] = await tx
            .insert(shiftsTable)
            .values(values)
            .returning({ id: shiftsTable.id });
          if (shift) createdShiftIds.push(shift.id);
        }

        // Patch createdShiftIds atomically in the same transaction.
        const [final] = await tx
          .update(shiftRequestsTable)
          .set({ createdShiftIds })
          .where(eq(shiftRequestsTable.id, id))
          .returning();
        updated = final;
      });
    } catch (err: any) {
      if (err?.alreadyProcessed) {
        res.status(409).json({ error: "Conflict", message: "Request was already processed by another request." });
        return;
      }
      throw err;
    }

    res.json({ ...updated, createdShiftsCount: updated?.createdShiftIds?.length ?? 0 });
  },
);

// POST /admin/shift-requests/:id/decline
const DeclineRequestBody = z.object({
  adminNote: z.string().max(2000).optional(),
});

router.post(
  "/admin/shift-requests/:id/decline",
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = String(req.params.id);
    const parsed = DeclineRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Bad Request", message: parsed.error.message });
      return;
    }

    const [request] = await db
      .select({ status: shiftRequestsTable.status })
      .from(shiftRequestsTable)
      .where(eq(shiftRequestsTable.id, id))
      .limit(1);

    if (!request) {
      res.status(404).json({ error: "Not Found" });
      return;
    }
    if (request.status !== "pending") {
      res.status(409).json({
        error: "Conflict",
        message: `Request is already ${request.status}.`,
      });
      return;
    }

    const [updated] = await db
      .update(shiftRequestsTable)
      .set({
        status: "declined",
        adminNote: parsed.data.adminNote ?? null,
        reviewedByUserId: req.user!.userId,
        reviewedAt: new Date(),
      })
      .where(eq(shiftRequestsTable.id, id))
      .returning();

    res.json(updated);
  },
);

// ===========================================================================
// Helpers
// ===========================================================================

function generateTempPassword(): string {
  const CHARS =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#";
  const bytes = randomBytes(10);
  return Array.from(bytes)
    .map((b) => CHARS[b % CHARS.length])
    .join("");
}

async function sendClientInviteEmail(opts: {
  user: { email: string; firstName: string };
  clientName: string;
  tempPassword: string;
  loginUrl: string | null;
}): Promise<boolean> {
  const { user, clientName, tempPassword, loginUrl } = opts;
  if (!loginUrl) return false;

  const subject = `Your client portal access — ${clientName}`;
  const text = [
    `Hello ${user.firstName},`,
    "",
    `You have been granted access to the ${clientName} client portal on the SecureOps platform.`,
    "",
    `Sign in at: ${loginUrl}`,
    `Email: ${user.email}`,
    `Temporary password: ${tempPassword}`,
    "",
    "You will be asked to change your password on first login.",
    "",
    "Williams Council Security Group",
  ].join("\n");

  const html = `
    <div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#0c0a08">
      <div style="background:#0c0a08;padding:20px 24px;border-radius:4px 4px 0 0">
        <h2 style="color:#c9a04a;margin:0;font-size:18px">Williams Council Security Group</h2>
        <p style="color:#f0e4c0;margin:4px 0 0;font-size:12px;letter-spacing:0.05em">CLIENT PORTAL ACCESS</p>
      </div>
      <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 4px 4px">
        <p>Hello ${user.firstName},</p>
        <p>You have been granted access to the <strong>${clientName}</strong> client portal on the SecureOps platform.</p>
        <div style="background:#f6f1e1;padding:14px 16px;border-left:3px solid #c9a04a;margin:18px 0;border-radius:4px">
          <div style="margin-bottom:6px"><strong>Sign-in URL:</strong> <a href="${loginUrl}" style="color:#0c0a08">${loginUrl}</a></div>
          <div style="margin-bottom:6px"><strong>Email:</strong> ${user.email}</div>
          <div><strong>Temporary password:</strong> <code style="background:#fff;padding:2px 6px;border-radius:3px;border:1px solid #ccc">${tempPassword}</code></div>
        </div>
        <p style="color:#555;font-size:13px">You will be asked to set a new password when you first sign in. If you did not expect this invitation, please disregard this email.</p>
        <hr style="border:none;border-top:2px solid #c9a04a;margin:20px 0"/>
        <p style="color:#0c0a08;font-weight:bold;margin:0;font-size:13px">Williams Council Security Group</p>
      </div>
    </div>
  `;

  return sendEmail({ to: user.email, subject, text, html });
}

export default router;
