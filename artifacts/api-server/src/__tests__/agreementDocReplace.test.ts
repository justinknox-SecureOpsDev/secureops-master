/**
 * Replacing a platform agreement document must actually replace it.
 *
 * Reported as "I uploaded an updated agreement and it didn't overwrite the
 * old one". `platform_agreement_docs` keys on `slot`, so a re-upload is an
 * upsert, not an insert — these tests pin that contract so a future change
 * (adding a SHA/no-op short-circuit, switching to plain insert, keying on
 * something else) can't quietly leave the previous document in place.
 *
 * They also pin the inverse: a *rejected* replacement must leave the
 * previously stored document intact rather than half-clearing the slot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, platformAgreementDocsTable } from "@workspace/db";
import { registerAgreementDoc } from "../lib/agreementDocs";
import { ObjectStorageService } from "../lib/objectStorage";

const TAG = `agr-doc-replace-${randomUUID().slice(0, 8)}`;
const SLOT = "msa" as const;
const storage = new ObjectStorageService();

/** A minimal but structurally valid PDF; `registerAgreementDoc` checks magic bytes. */
function pdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
}

async function store(buf: Buffer): Promise<string> {
  return storage.saveObjectBuffer(buf, "application/pdf", TAG);
}

async function rowsForSlot() {
  return db
    .select()
    .from(platformAgreementDocsTable)
    .where(inArray(platformAgreementDocsTable.slot, [SLOT]));
}

// `platform_agreement_docs` is a singleton-style table (one row per slot) with
// no per-suite tenancy key, so snapshot and restore whatever was there.
let saved: (typeof platformAgreementDocsTable.$inferSelect)[] = [];

beforeAll(async () => {
  saved = await rowsForSlot();
  await db.delete(platformAgreementDocsTable).where(inArray(platformAgreementDocsTable.slot, [SLOT]));
});

afterAll(async () => {
  await db.delete(platformAgreementDocsTable).where(inArray(platformAgreementDocsTable.slot, [SLOT]));
  if (saved.length > 0) await db.insert(platformAgreementDocsTable).values(saved);
});

describe("registerAgreementDoc — replacing an uploaded agreement", () => {
  it("overwrites the slot instead of adding a second document", async () => {
    const first = await registerAgreementDoc(storage, {
      slot: SLOT,
      fileKey: await store(pdf("original")),
      fileName: "MSA-2025.pdf",
      editor: `${TAG}-first@example.test`,
    });
    expect(first.ok).toBe(true);

    const replacement = pdf("updated");
    const second = await registerAgreementDoc(storage, {
      slot: SLOT,
      fileKey: await store(replacement),
      fileName: "MSA-2026-executed.pdf",
      editor: `${TAG}-second@example.test`,
    });
    expect(second.ok).toBe(true);

    const rows = await rowsForSlot();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileName).toBe("MSA-2026-executed.pdf");
    expect(rows[0]!.documentSha256).toBe(createHash("sha256").update(replacement).digest("hex"));
    expect(rows[0]!.uploadedBy).toBe(`${TAG}-second@example.test`);
    // The read model the portal renders must show the replacement, not the original.
    expect(second.ok && second.dto.custom?.fileName).toBe("MSA-2026-executed.pdf");
  });

  it("re-uploading identical bytes under a new name still updates the slot", async () => {
    // Guards against a well-meaning "same SHA, nothing to do" short-circuit:
    // the customer renames the file (e.g. countersigned copy) and expects the
    // card to show the new name.
    const bytes = pdf("identical");
    await registerAgreementDoc(storage, {
      slot: SLOT,
      fileKey: await store(bytes),
      fileName: "MSA-draft.pdf",
      editor: `${TAG}@example.test`,
    });
    const again = await registerAgreementDoc(storage, {
      slot: SLOT,
      fileKey: await store(bytes),
      fileName: "MSA-countersigned.pdf",
      editor: `${TAG}@example.test`,
    });

    expect(again.ok).toBe(true);
    const rows = await rowsForSlot();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileName).toBe("MSA-countersigned.pdf");
  });

  it("leaves the stored document intact when a replacement is rejected", async () => {
    const good = pdf("keep-me");
    await registerAgreementDoc(storage, {
      slot: SLOT,
      fileKey: await store(good),
      fileName: "MSA-good.pdf",
      editor: `${TAG}@example.test`,
    });

    const notAPdf = await registerAgreementDoc(storage, {
      slot: SLOT,
      fileKey: await storage.saveObjectBuffer(Buffer.from("PK\u0003\u0004 not a pdf"), "application/pdf", TAG),
      fileName: "MSA-bad.docx",
      editor: `${TAG}@example.test`,
    });
    expect(notAPdf.ok).toBe(false);
    expect(notAPdf.ok === false && notAPdf.status).toBe(400);

    const missing = await registerAgreementDoc(storage, {
      slot: SLOT,
      fileKey: `/objects/uploads/u/${TAG}/${randomUUID()}`,
      fileName: "MSA-missing.pdf",
      editor: `${TAG}@example.test`,
    });
    expect(missing.ok).toBe(false);

    const rows = await rowsForSlot();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileName).toBe("MSA-good.pdf");
    expect(rows[0]!.documentSha256).toBe(createHash("sha256").update(good).digest("hex"));
  });
});
