/**
 * Immutable agreement drafts prepared by the central Control Plane.
 *
 * Signature fields remain null while status=draft. The Control Plane sends
 * rendered legal content and a merge snapshot; the tenant never fabricates
 * signer or signature evidence during draft creation.
 */
import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

export const clientAgreementsTable = pgTable(
  "client_agreements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    templateVersion: text("template_version"),
    // Hash of the validated Control Plane draft body. Prevents network retries
    // or captured HMAC request replays from creating duplicate legal drafts.
    requestFingerprint: text("request_fingerprint").notNull(),
    version: integer("version").notNull().default(1),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    mergeSnapshot: jsonb("merge_snapshot"),
    renderedContent: text("rendered_content"),
    contentHash: text("content_hash"),
    documentStorageKey: text("document_storage_key"),
    completedDocumentStorageKey: text("completed_document_storage_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sentBy: text("sent_by"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signedByUserId: uuid("signed_by_user_id"),
    signedByEmail: text("signed_by_email"),
    signedByName: text("signed_by_name"),
    typedSignerName: text("typed_signer_name"),
    signerIp: text("signer_ip"),
    signerUserAgent: text("signer_user_agent"),
    consentText: text("consent_text"),
    signatureVersionSeen: integer("signature_version_seen"),
    signatureHashSeen: text("signature_hash_seen"),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    declinedByUserId: uuid("declined_by_user_id"),
    declineReason: text("decline_reason"),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByAgreementId: uuid("superseded_by_agreement_id"),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    clientIdx: index("client_agreements_client_idx").on(t.clientId, t.createdAt),
    versionUniq: uniqueIndex("client_agreements_version_uniq").on(
      t.clientId,
      t.templateKey,
      t.version,
    ),
    requestFingerprintUniq: uniqueIndex(
      "client_agreements_request_fingerprint_uniq",
    ).on(t.clientId, t.requestFingerprint),
  }),
);