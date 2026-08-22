import express, { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import sharp from "sharp";
import { heicBufferToJpeg } from "../lib/heicConvert";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireAdmin, requireStaff, requireSubcontractor } from "../middlewares/auth";
import { uploadUrlLimiter, applicationUploadLimiter } from "../middlewares/rateLimit";
import { db, employeesTable, incidentsTable, licenseRenewalRequestsTable, protectionPersonsTable, shiftAssignmentsTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isWorkerRole } from "../lib/eligibility";

/**
 * Maximum declared file size accepted for presigned upload URL requests.
 * The actual bytes flow directly to GCS, so this caps what callers can
 * *claim* to upload and also serves as a signal to reject obviously
 * abusive requests early (25 MB).
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Cap for anonymous HR application uploads (Apply / Onboard / Amend).
 *
 * Was 10 MB, which real applicants hit: a high-megapixel Android photo or a
 * flatbed scan of an SSN card routinely exceeds it, and the applicant — who
 * has no way to resize a file — simply cannot finish the form. Since every
 * accepted image is downscaled and re-encoded server-side before storage, a
 * larger *input* bound costs nothing on disk; the abuse surface is held down
 * by the per-IP rate limiter and the decode ceilings below instead.
 */
const APPLICATION_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const APPLICATION_MAX_UPLOAD_MB = Math.round(APPLICATION_MAX_UPLOAD_BYTES / (1024 * 1024));

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

/**
 * Extension → MIME map for the accepted upload inputs (the store-as-is
 * allow-list plus the convertible HEIC/HEIF image types).
 *
 * Browsers frequently report an empty or generic `application/octet-stream`
 * type for Word documents (`.doc`/`.docx`), iPhone `.heic` photos, and any file
 * whose extension the OS hasn't registered. Without a fallback those legitimate
 * uploads get a 415. The client also infers the type from the extension, but we
 * mirror it here so the server stays robust against older/stale clients.
 */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  txt: "text/plain",
};

/**
 * Resolve the effective content type. If the declared type is missing or the
 * generic `application/octet-stream`, fall back to the file extension. Returns
 * the normalized declared type otherwise.
 */
export function resolveContentType(declaredType: string, fileName: string): string {
  const normalized = declaredType.split(";")[0].trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_CONTENT_TYPES[ext] ?? normalized;
}

/**
 * iPhone/HEIF still-image formats. Most admin browsers (Chrome/Firefox) can't
 * render these, so we accept them as INPUT but always transcode to JPEG before
 * storing — see normalizeApplicationUpload.
 */
const CONVERTIBLE_IMAGE_TYPES = new Set(["image/heic", "image/heif"]);

/**
 * Raster photo types normalized via sharp (auto-orient + downscale + JPEG).
 * HEIC/HEIF are handled separately (ImageMagick) because this build's sharp is
 * AVIF-only and can't decode HEVC — see CONVERTIBLE_IMAGE_TYPES and
 * normalizeApplicationUpload. PDFs/Word docs are in neither set and are stored
 * byte-for-byte.
 */
const RASTER_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Whether the anonymous application endpoint will accept this resolved type. */
export function isAcceptedApplicationType(type: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(type) || CONVERTIBLE_IMAGE_TYPES.has(type);
}

/**
 * Prepare an application upload for storage:
 *  - iPhone HEIC/HEIF → decoded to JPEG via ImageMagick (this build's sharp is
 *    AVIF-only and cannot read HEVC, so it can't decode real iPhone photos).
 *  - Other raster photos → auto-rotated from EXIF, downscaled, and re-encoded to
 *    JPEG via sharp, so the stored ID/SSN document is viewable in every admin
 *    browser and an oversized phone photo doesn't bloat storage.
 *  - PDF/DOC/DOCX/TXT → stored byte-for-byte.
 * Throws if an image can't be decoded (the caller maps that to a 422).
 */
export async function normalizeApplicationUpload(
  buffer: Buffer,
  resolvedType: string,
  name: string,
): Promise<{ buffer: Buffer; contentType: string; name: string }> {
  const jpgName = name.replace(/\.[^.]+$/, "") + ".jpg";

  // iPhone HEIC/HEIF: sharp here is AVIF-only, so hand the bytes to ImageMagick,
  // which carries the HEVC decoder and returns a normalized JPEG.
  if (CONVERTIBLE_IMAGE_TYPES.has(resolvedType)) {
    const jpeg = await heicBufferToJpeg(buffer);
    return { buffer: jpeg, contentType: "image/jpeg", name: jpgName };
  }

  // Non-image files (PDF/DOC/DOCX/TXT) are stored byte-for-byte.
  if (!RASTER_IMAGE_TYPES.has(resolvedType)) {
    return { buffer, contentType: resolvedType, name };
  }

  // Regular raster photos go through sharp's fast native pipeline.
  const out = await sharp(buffer, {
    failOn: "none",
    // Cap decompressed size: this endpoint is unauthenticated, so a highly
    // compressible "pixel bomb" (huge dimensions, tiny byte size) could
    // otherwise exhaust memory before the resize runs. 100 MP still admits
    // every real phone camera (12–48 MP) with generous headroom.
    limitInputPixels: 100_000_000,
    // Stream the decode instead of materialising the full raster where the
    // format allows it. A 100 MP image is ~400 MB decoded, and an OOM here
    // takes down the whole process — which the applicant sees as a bare 500.
    sequentialRead: true,
  })
    .rotate()
    .resize(3000, 3000, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { buffer: out, contentType: "image/jpeg", name: jpgName };
}

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * Authorize signing a protection-detail (PPO) principal/threat photo.
 *
 * These photos are uploaded by admins and stored in
 * `protection_persons.photoKeys`, so they live outside the officer's own
 * upload prefix and are never in the caller's `owned` set. Access mirrors the
 * GET /shifts/:id/protection-detail read rule (least-privilege on the most
 * sensitive PII in the system):
 *   - admin may sign any protection photo;
 *   - an `employee` may sign only photos belonging to a shift they have an
 *     ACCEPTED assignment to.
 * Every other role — dispatcher, site_manager, external `client` — is refused.
 *
 * Matching on the photo key is EXACT (jsonb array membership via
 * `jsonb_exists`), never a prefix — a partial path must not unlock a sibling.
 */
async function canSignProtectionPhoto(
  path: string,
  userId: string,
  role: string,
): Promise<boolean> {
  // Admin is the only standing reader; any other WORKER role (employee /
  // site_manager / dispatcher — all staff work shifts) needs an accepted
  // assignment to a parent shift. External `client` accounts: deny.
  const isGlobalReader = role === "admin";
  if (!isGlobalReader && !isWorkerRole(role)) return false;

  const rows = await db
    .select({ shiftId: protectionPersonsTable.shiftId })
    .from(protectionPersonsTable)
    .where(sql`jsonb_exists(${protectionPersonsTable.photoKeys}, ${path})`);
  if (rows.length === 0) return false;
  if (isGlobalReader) return true;

  const shiftIds = [...new Set(rows.map((r) => r.shiftId))];

  const [assignment] = await db
    .select({ id: shiftAssignmentsTable.id })
    .from(shiftAssignmentsTable)
    .where(
      and(
        inArray(shiftAssignmentsTable.shiftId, shiftIds),
        eq(shiftAssignmentsTable.employeeId, userId),
        eq(shiftAssignmentsTable.status, "accepted"),
      ),
    )
    .limit(1);
  return Boolean(assignment);
}

/**
 * Per-route raw-body parser for the anonymous application upload endpoint.
 * Enforces the 10 MB limit at the HTTP layer before any handler logic runs.
 * `express.json()` in app.ts only fires on application/json, so it does not
 * consume the body for image/* / application/pdf uploads first.
 */
const applicationRawParser = express.raw({
  limit: `${APPLICATION_MAX_UPLOAD_BYTES}b`,
  // Always buffer the body regardless of Content-Type. Browsers occasionally
  // omit or send an empty/generic type for documents; `"*/*"` would skip
  // parsing when no Content-Type header is present, leaving req.body unparsed.
  type: () => true,
});

/**
 * Run the raw parser and turn an over-limit body into a JSON answer the
 * applicant can act on.
 *
 * Without this the parser's PayloadTooLargeError falls through to Express's
 * default handler, which replies with an HTML page containing a stack trace.
 * The upload client parses JSON, finds no `message`, and renders a bare
 * "Upload failed (413)" — so the one error a user can actually fix (their
 * photo is too big) arrives as an opaque number, and a stack trace leaks to an
 * unauthenticated caller. Every failure on this endpoint must carry a plain
 * `message`.
 */
function applicationBodyParser(req: Request, res: Response, next: express.NextFunction): void {
  applicationRawParser(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }
    const status = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode;
    const type = (err as { type?: string }).type;

    if (status === 413 || type === "entity.too.large") {
      req.log.info(
        { size: req.headers["content-length"] },
        "Application upload rejected: over size limit",
      );
      res.status(413).json({
        error: "Payload Too Large",
        message:
          `That file is too large (limit ${APPLICATION_MAX_UPLOAD_MB} MB). ` +
          "Please upload a smaller photo, or take the picture at a lower resolution.",
      });
      return;
    }

    // Every other parser failure (unsupported content-encoding, a body that
    // died mid-flight, a bad declared length) must ALSO answer in JSON. There
    // is no global JSON error handler on this app, so `next(err)` here would
    // hand the applicant Express's default HTML error page — no `message`,
    // which is exactly the unactionable "Upload failed (500)" this endpoint
    // keeps getting reported for, plus a stack trace leaked to an
    // unauthenticated caller in non-production builds.
    req.log.warn({ err, type, status }, "Application upload body could not be read");
    if (res.headersSent) return;
    const code = typeof status === "number" && status >= 400 && status < 500 ? status : 400;
    res.status(code).json({
      error: "Bad Request",
      message:
        "We couldn't read that upload. Please try again, and if it keeps " +
        "failing try a different file or a photo taken with your phone's camera.",
    });
  });
}

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
  // Empty/octet-stream declarations fall back to the filename extension.
  const normalizedType = resolveContentType(contentType, name);
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
  requireStaff,
  (req: Request, res: Response) =>
    handleUploadUrlRequest(req, res, {
      maxBytes: MAX_UPLOAD_BYTES,
      ownerKey: req.user!.userId,
    }),
);

/**
 * POST /subcontractor-portal/uploads/request-url
 *
 * Presigned-upload endpoint for the subcontractor self-service portal
 * (W-9 and Certificate of Insurance documents). `requireStaff` deliberately
 * excludes the `subcontractor` role (it is an external vendor contact, not
 * staff — see requireStaff docs), so it needs its own route rather than
 * reusing POST /storage/uploads/request-url above.
 */
router.post(
  "/subcontractor-portal/uploads/request-url",
  uploadUrlLimiter,
  requireSubcontractor,
  (req: Request, res: Response) =>
    handleUploadUrlRequest(req, res, {
      maxBytes: MAX_UPLOAD_BYTES,
      ownerKey: req.user!.userId,
    }),
);

/**
 * GET /subcontractor-portal/storage/sign?path=/objects/...
 *
 * Self-serve signed download URL for the authenticated subcontractor.
 * Every presigned upload URL this portal mints is bound to the caller's own
 * user ID at mint time (`ownerKey` above), and the object-storage service
 * always writes under `/objects/uploads/u/<userId>/...` for a bound upload —
 * so a path under the caller's own prefix can only ever be a file THEY
 * uploaded. A simple prefix check is therefore sufficient ownership proof
 * here; there is no legacy pre-binding data to defend against the way the
 * older employee-document endpoint (`/me/storage/sign`) does.
 */
router.get("/subcontractor-portal/storage/sign", requireSubcontractor, async (req: Request, res: Response) => {
  const path = (req.query.path as string | undefined)?.trim();
  if (!path || !path.startsWith("/objects/")) {
    res.status(400).json({ error: "Bad Request", message: "path query param required" });
    return;
  }
  const ownedPrefix = `/objects/uploads/u/${req.user!.userId}/`;
  if (!path.startsWith(ownedPrefix)) {
    res.status(403).json({ error: "Forbidden", message: "You do not own this object" });
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
    req.log.error({ err }, "Error signing subcontractor-portal download URL");
    res.status(500).json({ error: "Internal Server Error", message: "Failed to sign URL" });
  }
});

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
  applicationBodyParser,
  async (req: Request, res: Response) => {
    // X-File-Name is advisory only (display on client). Sanitised, never used
    // in storage paths. Also used to recover the MIME type when the browser
    // sends an empty/octet-stream Content-Type (common for .doc/.docx and for
    // iPhone .heic photos).
    const rawName = String(req.headers["x-file-name"] ?? "upload");
    const safeName = rawName.replace(/[^\w\s.\-()]/g, "").slice(0, 255) || "upload";

    const rawType = String(req.headers["content-type"] ?? "");
    const resolvedType = resolveContentType(rawType, safeName);

    if (!isAcceptedApplicationType(resolvedType)) {
      res.status(415).json({
        error: "Unsupported Media Type",
        message:
          "That file type isn't supported. Please upload a PDF or a photo (JPG, PNG, HEIC, or WEBP).",
      });
      return;
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Bad Request", message: "Empty or missing file body" });
      return;
    }

    // Auto-orient, downscale, and transcode raster photos to JPEG so iPhone
    // HEIC/HEIF uploads work and every stored ID/SSN image is viewable in any
    // admin browser. PDFs and Word docs pass through untouched.
    let normalized: { buffer: Buffer; contentType: string; name: string };
    try {
      normalized = await normalizeApplicationUpload(body, resolvedType, safeName);
    } catch (err) {
      // Log what the file actually was. An applicant can only tell us "it
      // didn't work", so the failing type/size has to be in the logs or the
      // next report is undiagnosable.
      req.log.warn(
        { err, resolvedType, rawType, bytes: body.length, name: safeName },
        "Application image normalization failed",
      );
      res.status(422).json({
        error: "Unprocessable Entity",
        message: "We couldn't read that image. Please try another photo or upload a PDF.",
      });
      return;
    }

    // Retry a failed storage write before giving up. The object-storage call
    // goes out over the network, so a single transient hiccup would otherwise
    // end an applicant's session with an unexplained 500 and no way forward —
    // and re-picking the file is the only recovery they have. Writes here are
    // safe to repeat: each attempt mints its own object name, so a retry can
    // never overwrite or duplicate a previously stored document.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const objectPath = await objectStorageService.saveObjectBuffer(
          normalized.buffer,
          normalized.contentType,
        );
        res.json({
          objectPath,
          name: normalized.name,
          size: normalized.buffer.length,
          contentType: normalized.contentType,
        });
        return;
      } catch (error) {
        lastError = error;
        req.log.warn(
          { err: error, attempt, bytes: normalized.buffer.length },
          "Application upload storage write failed",
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 250));
      }
    }

    req.log.error(
      { err: lastError, bytes: normalized.buffer.length, contentType: normalized.contentType },
      "Error saving application upload",
    );
    res.status(500).json({
      error: "Failed to save file",
      message:
        "We couldn't save that file just now. Please try again in a moment — " +
        "if it keeps failing, continue with the rest of the form and let us know.",
    });
  },
);

/**
 * GET /me/storage/sign?path=/objects/...
 *
 * Self-serve signed download URL for the authenticated employee. Only signs
 * paths that match one of the caller's own employee document keys.
 */
router.get("/me/storage/sign", requireStaff, async (req: Request, res: Response) => {
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

    // A missing employee row is NOT an early 403 here. An admin typically has
    // no employee record, yet may be authorized to sign protection-detail
    // photos in the check further down. So we only build the "owned employee
    // document" set when an employee row exists and defer the final
    // allow/deny to the combined owned/protection authorization. Non-staff
    // callers with no employee row simply end up with an empty `owned` set
    // and fall through to a 403 unless a protection rule grants access.

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
    // All of the "owned object" sources below — employee document keys, the
    // caller's own incident attachments, and their own license-renewal docs —
    // are employee-scoped, so we only consult them when an employee row exists.
    // An admin with no employee row therefore gets an empty `owned` set and can
    // only reach a signed URL through the protection-photo rule below, keeping
    // the newly-reachable callers after the removed early-return to exactly the
    // authorized protection readers (admin or an accepted-assignment officer).
    if (emp) {
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
    }

    // Protection-detail photos are admin-uploaded, so they live outside the
    // caller's own upload prefix and won't be in `owned`. An admin — or an
    // officer with an ACCEPTED assignment to the parent shift — may still sign
    // them, mirroring the GET /shifts/:id/protection-detail read rule.
    let allowed = owned.has(path);
    if (!allowed) {
      allowed = await canSignProtectionPhoto(path, req.user!.userId, req.user!.role);
    }
    if (!allowed) {
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
