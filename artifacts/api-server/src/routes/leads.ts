import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, salesLeadsTable, type SalesLead } from "@workspace/db";
import { salesLeadIpLimiter, salesLeadEmailLimiter } from "../middlewares/rateLimit";
import {
  sendEmail,
  renderSalesLeadAdminEmail,
  renderSalesLeadConfirmationEmail,
} from "../lib/email";
import { brand } from "../lib/brandConfig";

const router: IRouter = Router();

function appBaseUrl(): string | null {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]!.trim()}`;
  return null;
}

// Public lead-capture payload. Narrow allow-list (threat model: clients may
// only write these fields) — `status`, `source` defaults, `adminNotes` and
// timestamps are server-controlled and never accepted from the client.
const SubmitLeadBody = z.object({
  companyName: z.string().trim().min(1, "Company name is required").max(200),
  contactName: z.string().trim().min(1, "Your name is required").max(200),
  email: z.string().trim().toLowerCase().email("A valid email is required").max(320),
  phone: z.string().trim().max(40).optional(),
  // Marketing copy can evolve, so accept any short tier label rather than a
  // hard enum; the grid + email just echo it back.
  tier: z.string().trim().max(40).optional(),
  officerCount: z.coerce.number().int().min(0).max(1_000_000).optional(),
  message: z.string().trim().max(4000).optional(),
  source: z.string().trim().max(60).optional(),
});

function rowToDto(r: SalesLead) {
  return {
    id: r.id,
    companyName: r.companyName,
    contactName: r.contactName,
    email: r.email,
    phone: r.phone,
    tier: r.tier,
    officerCount: r.officerCount,
    message: r.message,
    source: r.source,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

// POST /leads — fully public sales / sign-up intake from the marketing site.
// Persists the lead AND fires admin + confirmation emails (fire-and-forget),
// so a lead is never lost even when mail is unconfigured or suppressed in dev.
router.post("/leads", salesLeadIpLimiter, salesLeadEmailLimiter, async (req, res): Promise<void> => {
  const parsed = SubmitLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Bad Request", message: parsed.error.message });
    return;
  }
  const d = parsed.data;

  const [row] = await db
    .insert(salesLeadsTable)
    .values({
      companyName: d.companyName,
      contactName: d.contactName,
      email: d.email,
      phone: d.phone ?? null,
      tier: d.tier ?? null,
      officerCount: d.officerCount ?? null,
      message: d.message ?? null,
      source: d.source && d.source.length > 0 ? d.source : "marketing_site",
    })
    .returning();

  // Notify the sales inbox + confirm to the prospect without blocking the
  // submit response on mail delivery.
  void (async () => {
    try {
      const base = appBaseUrl();
      const adminTmpl = renderSalesLeadAdminEmail({
        companyName: row!.companyName,
        contactName: row!.contactName,
        email: row!.email,
        phone: row!.phone ?? undefined,
        tier: row!.tier ?? undefined,
        officerCount: row!.officerCount ?? undefined,
        message: row!.message ?? undefined,
        source: row!.source,
        reviewUrl: base ? `${base}/admin-portal/tables/sales_leads` : undefined,
      });
      await sendEmail({ to: brand.salesEmail, subject: adminTmpl.subject, text: adminTmpl.text, html: adminTmpl.html });
    } catch (err) {
      req.log.warn({ err, leadId: row!.id }, "sales lead admin email failed");
    }
  })();

  void (async () => {
    try {
      const confTmpl = renderSalesLeadConfirmationEmail({
        contactName: row!.contactName,
        tier: row!.tier ?? undefined,
      });
      await sendEmail({ to: row!.email, subject: confTmpl.subject, text: confTmpl.text, html: confTmpl.html });
    } catch (err) {
      req.log.warn({ err, leadId: row!.id }, "sales lead confirmation email failed");
    }
  })();

  res.status(201).json(rowToDto(row!));
});

export default router;
