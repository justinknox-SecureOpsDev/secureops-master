/**
 * Atomic version counter per client and agreement template.
 */
import {
  pgTable,
  text,
  uuid,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

export const clientAgreementVersionSeqsTable = pgTable(
  "client_agreement_version_seqs",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => clientsTable.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    currentVersion: integer("current_version").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.clientId, t.templateKey] }),
  }),
);