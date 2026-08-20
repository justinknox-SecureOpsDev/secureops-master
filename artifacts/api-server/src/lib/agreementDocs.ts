/**
 * Shared platform-agreement document upload logic.
 *
 * Both the in-app super-admin route (routes/platform.ts) and the remote
 * control-plane route (routes/controlPlane.ts) register an uploaded PDF as the
 * "actual" document for an agreement slot (MSA / User Agreement) through this
 * one module, so validation is identical on both paths: the server re-downloads
 * the object to verify it exists, is a real PDF (magic bytes), is within the
 * size cap, and computes the SHA-256 of the stored bytes — the client-declared
 * metadata on the presigned PUT is never trusted.
 */

import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { eq, sql } from "drizzle-orm";
import { db, platformAgreementDocsTable, platformAgreementSignaturesTable } from "@workspace/db";
import { AGREEMENT_SLOTS, type AgreementSlot } from "@workspace/legal-docs";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";

export { AGREEMENT_SLOTS, type AgreementSlot };

export const MAX_AGREEMENT_PDF_BYTES = 15 * 1024 * 1024; // 15 MB

export function parseAgreementSlot(raw: string | string[] | undefined): AgreementSlot | null {
  if (typeof raw !== "string") return null;
  return AGREEMENT_SLOTS.includes(raw as AgreementSlot) ? (raw as AgreementSlot) : null;
}

export const agreementUploadBody = z.object({
  fileKey: z.string().min(1),
  fileName: z.string().min(1).max(300),
});

export type AgreementSlotDto = {
  slot: AgreementSlot;
  custom: {
    fileName: string;
    fileSize: number | null;
    documentSha256: string | null;
    uploadedAt: string | null;
    uploadedBy: string | null;
  } | null;
};

export function agreementRowToDto(
  slot: AgreementSlot,
  row: typeof platformAgreementDocsTable.$inferSelect | undefined,
): AgreementSlotDto {
  return {
    slot,
    custom: row
      ? {
          fileName: row.fileName,
          fileSize: row.fileSize,
          documentSha256: row.documentSha256,
          uploadedAt: row.uploadedAt ? row.uploadedAt.toISOString() : null,
          uploadedBy: row.uploadedBy,
        }
      : null,
  };
}

/** Read every slot's current custom-document status (template if null). */
export async function readAgreementDocDtos(): Promise<AgreementSlotDto[]> {
  const rows = await db.select().from(platformAgreementDocsTable);
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  return AGREEMENT_SLOTS.map((slot) => agreementRowToDto(slot, bySlot.get(slot)));
}

export type RegisterAgreementResult =
  | { ok: true; dto: AgreementSlotDto }
  | { ok: false; status: number; message: string };

/**
 * Validate an uploaded object and register it as the document for a slot.
 * Re-downloads the object, checks PDF magic bytes + size, computes SHA-256, and
 * upserts the row. Returns a typed result rather than sending the response so
 * the caller controls the HTTP surface (in-app vs. HMAC control-plane).
 */
export async function registerAgreementDoc(
  storage: ObjectStorageService,
  input: { slot: AgreementSlot; fileKey: string; fileName: string; editor: string },
): Promise<RegisterAgreementResult> {
  const normalized = storage.normalizeObjectEntityPath(input.fileKey);

  // A stored object that a signature points at is evidence: signatures pin the
  // file key and its hash, so re-registering (and therefore overwriting) that
  // same path would make an archived signed copy fail verification. Every
  // upload must land on its own fresh path.
  const [pinned] = await db
    .select({ id: platformAgreementSignaturesTable.id })
    .from(platformAgreementSignaturesTable)
    .where(eq(platformAgreementSignaturesTable.documentFileKey, normalized))
    .limit(1);
  if (pinned) {
    return {
      ok: false,
      status: 409,
      message:
        "That upload location already holds a document a signature was taken against. Upload the file again to get a new location.",
    };
  }

  let size: number;
  let buffer: Buffer;
  try {
    const dl = await storage.downloadObjectBuffer(normalized, { maxBytes: MAX_AGREEMENT_PDF_BYTES });
    size = dl.size;
    buffer = dl.buffer;
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return { ok: false, status: 400, message: "Uploaded file not found in storage" };
    }
    if ((err as { __tooLarge?: boolean }).__tooLarge) {
      return { ok: false, status: 400, message: "PDF exceeds the 15 MB limit" };
    }
    throw err;
  }
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, status: 400, message: "File is not a PDF" };
  }

  const documentSha256 = createHash("sha256").update(buffer).digest("hex");

  await db
    .insert(platformAgreementDocsTable)
    .values({
      slot: input.slot,
      fileKey: normalized,
      fileName: input.fileName,
      fileSize: size,
      documentSha256,
      uploadedBy: input.editor,
    })
    .onConflictDoUpdate({
      target: platformAgreementDocsTable.slot,
      set: {
        fileKey: normalized,
        fileName: input.fileName,
        fileSize: size,
        documentSha256,
        uploadedBy: input.editor,
        uploadedAt: sql`now()`,
      },
    });

  const [row] = await db
    .select()
    .from(platformAgreementDocsTable)
    .where(eq(platformAgreementDocsTable.slot, input.slot))
    .limit(1);
  return { ok: true, dto: agreementRowToDto(input.slot, row) };
}

/**
 * The document a slot is currently governed by. An uploaded PDF REPLACES the
 * bundled template everywhere — review, signing and the archived signed copy —
 * so this is the single resolver every one of those surfaces must consult.
 *
 * The stored bytes are re-read and re-hashed on every call, not trusted from
 * the metadata row: a signature has to be bound to a document that actually
 * exists and still hashes to what was registered. A slot whose uploaded
 * document can't be read, or no longer matches its recorded hash, is reported
 * as `unavailable` — never as the template. Quietly showing (and signing) the
 * bundled wording when the platform owner has replaced it is exactly the
 * mismatch this resolver exists to prevent.
 */
export type ActiveAgreementDocument =
  | { source: "template" }
  | {
      source: "uploaded";
      fileKey: string;
      fileName: string;
      fileSize: number | null;
      documentSha256: string;
      uploadedAt: Date | null;
      /** The verified bytes, so callers don't download the same object twice. */
      buffer: Buffer;
    }
  | { source: "unavailable"; message: string };

export async function readActiveAgreementDocument(
  storage: ObjectStorageService,
  slot: AgreementSlot,
): Promise<ActiveAgreementDocument> {
  const [row] = await db
    .select()
    .from(platformAgreementDocsTable)
    .where(eq(platformAgreementDocsTable.slot, slot))
    .limit(1);
  if (!row) return { source: "template" };

  let buffer: Buffer;
  try {
    const dl = await storage.downloadObjectBuffer(row.fileKey, {
      maxBytes: MAX_AGREEMENT_PDF_BYTES,
    });
    buffer = dl.buffer;
  } catch {
    return {
      source: "unavailable",
      message:
        "The uploaded document for this agreement could not be read from storage. Re-upload it before signing.",
    };
  }

  const actualSha256 = createHash("sha256").update(buffer).digest("hex");
  if (!row.documentSha256) {
    // Rows written before the hash column existed: adopt the stored bytes'
    // hash now, so this document can be pinned to a signature.
    await db
      .update(platformAgreementDocsTable)
      .set({ documentSha256: actualSha256 })
      .where(eq(platformAgreementDocsTable.slot, slot));
  } else if (row.documentSha256 !== actualSha256) {
    return {
      source: "unavailable",
      message:
        "The stored document for this agreement no longer matches the copy that was uploaded, so it can't be reviewed or signed. Upload it again.",
    };
  }

  return {
    source: "uploaded",
    fileKey: row.fileKey,
    fileName: row.fileName,
    fileSize: row.fileSize,
    documentSha256: actualSha256,
    uploadedAt: row.uploadedAt ?? null,
    buffer,
  };
}
