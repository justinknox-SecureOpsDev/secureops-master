import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // The control plane (artifacts/control-plane) creates its own registry
  // tables idempotently on boot and, in dev, may share this database.
  // Exclude them so `db push` never proposes dropping them.
  tablesFilter: ["!control_plane_*"],
});
