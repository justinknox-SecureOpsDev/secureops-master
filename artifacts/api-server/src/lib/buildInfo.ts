/**
 * Build identity — a non-sensitive version string the control plane reads to
 * monitor health and detect which customers are behind the target version.
 *
 * The values are injected at build time by esbuild `define` (see build.mjs):
 *   __BUILD_VERSION__  — short git SHA, or "unknown" when git is unavailable.
 *   __BUILD_TIME__     — ISO-8601 build timestamp.
 *
 * `define` textually replaces the identifiers with string literals during the
 * bundle, so there is nothing to import at runtime. The `declare` below keeps
 * `tsc` happy and the `typeof` guard provides a safe fallback (env, then
 * "unknown") for any context where the define did not run.
 *
 * NOTHING here is a secret. The version + timestamp are deliberately public so
 * the control plane and uptime monitors can read them without authentication.
 */

declare const __BUILD_VERSION__: string;
declare const __BUILD_TIME__: string;

export const BUILD_VERSION: string =
  (typeof __BUILD_VERSION__ !== "undefined" && __BUILD_VERSION__) ||
  process.env.BUILD_VERSION ||
  "unknown";

export const BUILD_TIME: string =
  (typeof __BUILD_TIME__ !== "undefined" && __BUILD_TIME__) ||
  process.env.BUILD_TIME ||
  "unknown";
