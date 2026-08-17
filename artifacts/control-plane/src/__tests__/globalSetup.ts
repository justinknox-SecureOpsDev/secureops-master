/**
 * Vitest global setup — runs once before any test file, in a separate worker.
 *
 * We call ensureSchema() here so individual test files' beforeAll hooks find
 * the tables already present. Without this, parallel beforeAll calls from
 * multiple test files race on CREATE TABLE IF NOT EXISTS, which can collide
 * on the implicit Postgres composite type and throw:
 *   "duplicate key value violates unique constraint pg_type_typname_nsp_index"
 */
import { ensureSchema, pool } from "../db.js";

export async function setup() {
  await ensureSchema();
}

export async function teardown() {
  await pool.end();
}
