import express, { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { uploadUrlLimiter, applicationUploadLimiter } from "../middlewares/rateLimit";
import { db, employeesTable, incidentsTable, licenseRenewalRequestsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Maximum declared file size accepted for presigned upload URL requests.
 * The actual bytes flow directly to GCS, so this caps what callers can
 * *claim* to upload and also serves as a signal to reject obviously
 * abusive requests early (25 MB).
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Lower cap for anonymous HR application uploads (Apply / Onboard / Amend).
 * 10 MB is enough for scanned documents, license photos, and passports.
 */
const APPLICATION_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * MIME types the application legitimately handles: identity/work documents,
 * photos, certificates, and incident attachments. Reject everything else to
 * prevent the bucket from being used as generic file storage.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * Per-route raw-body parser for the anonymous application upload endpoint.
 * Enforces the 10 MB limit at the HTTP layer before any handler logic runs.
 * `express.json()` in app.ts only fires on application/json, so it does not
 * consume the body for image/* / application/pdf uploads first.
 */
const applicationRawParser = express.raw({
  limit: `${APPLICATION_MAX_UPLOAD_BYTES}b`,
  type: "*/*",
});

/**
 * Shared handler logic: validate size + content-type then mint a signed URL.
 * `ownerKey` is the authenticated user's ID (undefined for anonymous flows).
 */
async function handleUploadUrlRequest(
  req: Request,
  res: Response,
  opts: { maxBytes: number; ownerKey?: string },
): Promise<void> {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  const { name, size, contentType } = parsed.data;

  // Reject oversized declarations up-front. The actual bytes go straight to
  // GCS, so Express body limits don't apply — this is the only server-side
  // gate on declared upload size.
  if (size > opts.maxBytes) {
    res.status(413).json({
      error: "Payload Too Large",
      message: `File size must not exceed ${opts.maxBytes / (1024 * 1024)} MB`,
    });
    return;
  }

  // Restrict to MIME types the application legitimately handles. This prevents
  // the private bucket from being used as generic arbitrary-file storage.
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(normalizedType)) {
    res.status(415).json({
      error: "Unsupported Media Type",
      message: "File type not permitted",
    });
    return;
  }

  try {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL(opts.ownerKey);
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
}

/**
 * POST /storage/uploads/request-url
 *
 * Authenticated endpoint: mint a presigned GCS PUT URL.
 * The upload path is bound to the caller's user ID so server-side
 * ownership checks (incident attachments, employee doc keys) remain
 * path-deterministic without trusting client-supplied paths.
 */
router.post(
  "/storage/uploads/request-url",
  uploadUrlLimiter,
  requireAuth,
  (req: Request, res: Response) =>
    handleUploadUrlRequest(req, res, {
      maxBytes: MAX_UPLOAD_BYTES,
      ownerKey: req.user!.userId,
    }),
);

/**
 * POST /storage/uploads/application-file
 *
 * Public (unauthenticated) direct-upload endpoint for the HR pipeline
 * (Apply / Onboard / Amend). File bytes travel through Express before
 * reaching GCS, so size and content-type are genuinely enforced by the
 * server — not by client-declared metadata or an unsigned GCS PUT policy.
 *
 * Controls:
 *   - express.raw() body limit: 10 MB hard stop at the HTTP layer
 *   - Content-Type header: must match the allow-list before touching GCS
 *   - X-File-Name header: advisory display name, sanitised, never used in paths
 *   - Per-IP rate limiter: 10 requests / 15-minute window
 *
 * Response: { objectPath, name, size, contentType }
 */
router.post(
  "/storage/uploads/application-file",
  applicationUploadLimiter,
  applicationRawParser,
  async (req: Request, res: Response) => {
    const rawType = req.headers["content-type"] ?? "";
    const normalizedType = rawType.split(";")[0].trim().toLowerCase();

    if (!ALLOWED_CONTENT_TYPES.has(normalizedType)) {
      res.status(415).json({
        error: "Unsupported Media Type",
        message: "File type not permitted",
      });
      return;
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Bad Request", message: "Empty or missing file body" });
      return;
    }

    // X-File-Name is advisory only (display on client). Sanitised, never used
    // in storage paths.
    const rawName = String(req.headers["x-file-name"] ?? "upload");
    const safeName = rawName.replace(/[^\w\s.\-()]/g, "").slice(0, 255) || "upload";

    try {
      const objectPath = await objectStorageService.saveObjectBuffer(body, normalizedType);
      res.json({
        objectPath,
        name: safeName,
        size: body.length,
        contentType: normalizedType,
      });
    } catch (error) {
      req.log.error({ err: error }, "Error saving application upload");
      res.status(500).json({ error: "Failed to save file" });
    }
  },
);

/**
 * GET /me/storage/sign?path=/objects/...
 *
 * Self-serve signed download URL for the authenticated employee. Only signs
 * paths that match one of the caller's own employee document keys.
 */
router.get("/me/storage/sign", requireAuth, async (req: Request, res: Response) => {
  const path = (req.query.path as string | undefined)?.trim();
  if (!path || !path.startsWith("/objects/")) {
    res.status(400).json({ error: "Bad Request", message: "path query param required" });
    return;
  }
  try {
    const [emp] = await db
      .select({
        photoKey: employeesTable.photoKey,
        cvKey: employeesTable.cvKey,
        licenseDocKey: employeesTable.licenseDocKey,
        passportDocKey: employeesTable.passportDocKey,
        rightToWorkDocKey: employeesTable.rightToWorkDocKey,
        payStubDocKey: employeesTable.payStubDocKey,
        trainingCertificateKeys: employeesTable.trainingCertificateKeys,
      })
      .from(employeesTable)
      .where(eq(employeesTable.userId, req.user!.userId));

    if (!emp) {
      res.status(403).json({ error: "Forbidden", message: "No employee record" });
      return;
    }

    // Only honour employee document keys that live under the caller's own
    // upload prefix. The authenticated upload endpoint mints paths at
    // /objects/uploads/u/<userId>/<uuid> so any legitimately self-uploaded
    // file satisfies this check. This prevents an attacker who managed to
    // write a foreign path into one of these columns (e.g. via the application
    // or onboarding flows, or a prior write before the PATCH /me/employee
    // ownership check was added) from obtaining a signed URL for another
    // user's private document. Documents from anonymous application/onboarding
    // uploads (path /objects/uploads/<uuid>, no user prefix) are intentionally
    // excluded here and remain accessible only to admins via /admin/storage/sign.
    const ownedPrefix = `/objects/uploads/u/${req.user!.userId}/`;
    const owned = new Set<string>();
    for (const k of [emp.photoKey, emp.cvKey, emp.licenseDocKey, emp.passportDocKey, emp.rightToWorkDocKey, emp.payStubDocKey]) {
      if (k && k.startsWith(ownedPrefix)) owned.add(k);
    }
    if (Array.isArray(emp.trainingCertificateKeys)) {
      for (const k of emp.trainingCertificateKeys as unknown[]) {
        if (typeof k === "string" && k.startsWith(ownedPrefix)) owned.add(k);
      }
    }

    // Defense in depth: also allow signing attachments on incidents the user
    // owns, but only when the path is under their bound upload prefix. The
    // create endpoint already enforces this prefix, so DB-stored values are
    // trustworthy; this guard prevents regressions if that ever changes.
    const myIncidents = await db
      .select({ attachments: incidentsTable.attachments })
      .from(incidentsTable)
      .where(eq(incidentsTable.employeeId, req.user!.userId));
    for (const inc of myIncidents) {
      if (Array.isArray(inc.attachments)) {
        for (const k of inc.attachments) {
          if (typeof k === "string" && k.startsWith(ownedPrefix)) owned.add(k);
        }
      }
    }

    // Also allow signing the doc attached to the caller's own license-renewal
    // submissions, again only when the path is under their bound upload
    // prefix (the create endpoint enforces this).
    const myRenewals = await db
      .select({ docKey: licenseRenewalRequestsTable.docKey })
      .from(licenseRenewalRequestsTable)
      .where(eq(licenseRenewalRequestsTable.employeeId, req.user!.userId));
    for (const r of myRenewals) {
      if (typeof r.docKey === "string" && r.docKey.startsWith(ownedPrefix)) owned.add(r.docKey);
    }

    if (!owned.has(path)) {
      res.status(403).json({ error: "Forbidden", message: "You do not own this object" });
      return;
    }

    const url = await objectStorageService.getSignedDownloadURL(path);
    res.json({ url });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Not Found", message: "Object not found" });
      return;
    }
    req.log.error({ err }, "Error signing self-serve download URL");
    res.status(500).json({ error: "Internal Server Error", message: "Failed to sign URL" });
  }
});

/**
 * GET /admin/storage/sign?path=/objects/...
 *
 * Returns a short-lived presigned GET URL for a private object so the admin
 * UI can open/download it directly from GCS. Admin-only.
 */
router.get("/admin/storage/sign", requireAdmin, async (req: Request, res: Response) => {
  const path = (req.query.path as string | undefined)?.trim();
  if (!path || !path.startsWith("/objects/")) {
    res.status(400).json({ error: "Bad Request", message: "path query param required" });
    return;
  }
  try {
    const url = await objectStorageService.getSignedDownloadURL(path);
    res.json({ url });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Not Found", message: "Object not found" });
      return;
    }
    req.log.error({ err }, "Error signing download URL");
    res.status(500).json({ error: "Internal Server Error", message: "Failed to sign URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get("/storage/objects/*path", requireAdmin, async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
