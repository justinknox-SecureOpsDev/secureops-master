/**
 * Multi-org directory resolution tests.
 *
 * ONE mobile-app-store build serves MANY customers, each a separate backend
 * deployment. The public, unauthenticated GET /api/org-directory/resolve maps a
 * short org "code" to that customer's backend ORIGIN. These tests pin the
 * contract that protects against cross-customer mis-routing:
 *   - a configured code resolves to its (origin-only) backend URL;
 *   - junk / missing codes are rejected (400) before any directory lookup;
 *   - an unknown code 404s in production (so the app says "code not found")
 *     but is synthesized back to THIS host in dev (local convenience);
 *   - malformed / non-https / path-bearing directory entries are SKIPPED so a
 *     bad ORG_DIRECTORY value can never point the app at an unsafe origin.
 *
 * The route memoizes the parsed directory, so each case resets the cache via
 * the test-only hook after mutating process.env.ORG_DIRECTORY.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";
import {
  __resetOrgDirectoryCacheForTests,
  resolveSelfOrgInvite,
  getSelfOrigin,
} from "../routes/orgDirectory";

const ORIGINAL_DIRECTORY = process.env.ORG_DIRECTORY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ORG_CODE = process.env.ORG_CODE;
const ORIGINAL_APP_BASE_URL = process.env.APP_BASE_URL;
const ORIGINAL_REPLIT_DOMAINS = process.env.REPLIT_DOMAINS;

function setDirectory(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.ORG_DIRECTORY;
  } else {
    process.env.ORG_DIRECTORY = value;
  }
  __resetOrgDirectoryCacheForTests();
}

function setNodeEnv(value: string): void {
  process.env.NODE_ENV = value;
}

beforeEach(() => {
  setDirectory(undefined);
  setNodeEnv(ORIGINAL_NODE_ENV ?? "test");
});

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

afterEach(() => {
  if (ORIGINAL_DIRECTORY === undefined) {
    delete process.env.ORG_DIRECTORY;
  } else {
    process.env.ORG_DIRECTORY = ORIGINAL_DIRECTORY;
  }
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  restoreEnv("ORG_CODE", ORIGINAL_ORG_CODE);
  restoreEnv("APP_BASE_URL", ORIGINAL_APP_BASE_URL);
  restoreEnv("REPLIT_DOMAINS", ORIGINAL_REPLIT_DOMAINS);
  __resetOrgDirectoryCacheForTests();
});

// The resolve endpoint is rate-limited per-IP. The app sets `trust proxy 1`,
// so we hand each functional request a distinct X-Forwarded-For to isolate its
// rate-limit bucket — keeping the correctness tests independent of one another
// and of the dedicated rate-limit test below (which drives one fixed IP past
// the cap on purpose).
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function resolve(code: unknown, ip: string = nextIp()) {
  const qs = code === undefined ? "" : `?code=${encodeURIComponent(String(code))}`;
  return request(app)
    .get(`/api/org-directory/resolve${qs}`)
    .set("X-Forwarded-For", ip);
}

describe("GET /api/org-directory/resolve", () => {
  it("resolves a configured code to its backend origin", async () => {
    setDirectory(
      JSON.stringify([
        { code: "acme", name: "Acme Security", apiBaseUrl: "https://acme.example.app" },
      ]),
    );
    const res = await resolve("acme");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: "acme",
      name: "Acme Security",
      apiBaseUrl: "https://acme.example.app",
    });
    // Never cacheable — a stale directory must not pin a device to an old backend.
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("lower-cases and trims the requested code before lookup", async () => {
    setDirectory(
      JSON.stringify([{ code: "acme", name: "Acme", apiBaseUrl: "https://acme.example.app" }]),
    );
    const res = await resolve("  ACME  ");
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("acme");
  });

  it("normalizes a configured apiBaseUrl down to an origin only", async () => {
    // Entry carries a trailing slash; the server must hand back the bare origin.
    setDirectory(
      JSON.stringify([{ code: "acme", name: "Acme", apiBaseUrl: "https://acme.example.app/" }]),
    );
    const res = await resolve("acme");
    expect(res.status).toBe(200);
    expect(res.body.apiBaseUrl).toBe("https://acme.example.app");
  });

  it("falls back to the origin as the display name when name is blank", async () => {
    setDirectory(
      JSON.stringify([{ code: "acme", name: "   ", apiBaseUrl: "https://acme.example.app" }]),
    );
    const res = await resolve("acme");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("https://acme.example.app");
  });

  it("rejects a missing code with 400", async () => {
    setNodeEnv("production");
    const res = await resolve(undefined);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
  });

  it("rejects a malformed code with 400 (before any directory lookup)", async () => {
    setNodeEnv("production");
    // Spaces / symbols / over-length all fail the code regex.
    for (const bad of ["bad code", "no_underscores", "a", "x".repeat(40), "-leadingdash"]) {
      const res = await resolve(bad);
      expect(res.status, `code '${bad}' should 400`).toBe(400);
    }
  });

  it("404s an unknown code in production", async () => {
    setNodeEnv("production");
    setDirectory(
      JSON.stringify([{ code: "acme", name: "Acme", apiBaseUrl: "https://acme.example.app" }]),
    );
    const res = await resolve("ghost");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Not Found");
  });

  it("synthesizes an entry for an unknown code outside production (dev convenience)", async () => {
    setNodeEnv("development");
    setDirectory(undefined);
    const res = await resolve("local");
    expect(res.status).toBe(200);
    expect(res.body.code).toBe("local");
    expect(res.body.name).toBe("local (dev)");
    // Points back at THIS server (the request host), origin-only.
    expect(res.body.apiBaseUrl).toMatch(/^https?:\/\/[^/]+$/);
  });

  describe("rejects unsafe / malformed ORG_DIRECTORY entries", () => {
    it("skips a non-https entry in production", async () => {
      setNodeEnv("production");
      setDirectory(
        JSON.stringify([
          { code: "insecure", name: "Insecure", apiBaseUrl: "http://insecure.example.app" },
          { code: "good", name: "Good", apiBaseUrl: "https://good.example.app" },
        ]),
      );
      // The plain-http entry never made it into the directory.
      expect((await resolve("insecure")).status).toBe(404);
      // A well-formed https entry alongside it still resolves.
      const ok = await resolve("good");
      expect(ok.status).toBe(200);
      expect(ok.body.apiBaseUrl).toBe("https://good.example.app");
    });

    it("skips an entry whose apiBaseUrl carries a path", async () => {
      setNodeEnv("production");
      setDirectory(
        JSON.stringify([
          { code: "pathy", name: "Pathy", apiBaseUrl: "https://pathy.example.app/api" },
        ]),
      );
      expect((await resolve("pathy")).status).toBe(404);
    });

    it("skips an entry with an invalid code", async () => {
      setNodeEnv("production");
      setDirectory(
        JSON.stringify([
          { code: "Bad Code!", name: "Bad", apiBaseUrl: "https://bad.example.app" },
        ]),
      );
      // The invalid code can't even be requested (400 from the request schema),
      // and a valid-looking variant was never registered.
      expect((await resolve("badcode")).status).toBe(404);
    });

    it("skips entries missing required string fields", async () => {
      setNodeEnv("production");
      setDirectory(
        JSON.stringify([
          { name: "No Code", apiBaseUrl: "https://nocode.example.app" },
          { code: "nourl", name: "No Url" },
          null,
          "not-an-object",
        ]),
      );
      expect((await resolve("nourl")).status).toBe(404);
    });

    it("treats a non-array / malformed ORG_DIRECTORY as an empty directory", async () => {
      setNodeEnv("production");
      setDirectory("{ not valid json");
      expect((await resolve("anything")).status).toBe(404);

      setDirectory(JSON.stringify({ code: "xy", apiBaseUrl: "https://xy.example.app" }));
      expect((await resolve("xy")).status).toBe(404);
    });
  });

  // The endpoint is public and unauthenticated, so its only defense against a
  // flood (wholesale directory enumeration, or just DB/CPU abuse) is the per-IP
  // `orgDirectoryLimiter`. These tests pin that guard: a regression that drops
  // or misconfigures the limiter would let the endpoint be hammered with no
  // test catching it. The per-IP cap is lowered to ORG_DIRECTORY_RATE_LIMIT_MAX
  // (see __tests__/setup.ts) so we can cross it without firing 60+ requests.
  describe("per-IP rate limiting", () => {
    // Mirrors setup.ts's ORG_DIRECTORY_RATE_LIMIT_MAX override.
    const CAP = 10;

    it("returns 429 once a single IP floods past the per-IP cap", async () => {
      // A directory entry exists so allowed requests resolve 200 (not 404),
      // making the allowed-vs-blocked split unambiguous.
      setDirectory(
        JSON.stringify([{ code: "acme", name: "Acme", apiBaseUrl: "https://acme.example.app" }]),
      );

      // Drive everything from ONE fixed IP so the requests share a bucket.
      const ip = "198.51.100.7";
      const total = CAP + 3;
      const statuses: number[] = [];
      let limitedBody: { error?: string; message?: string } | undefined;

      for (let i = 0; i < total; i += 1) {
        const res = await resolve("acme", ip);
        statuses.push(res.status);
        if (res.status === 429 && !limitedBody) limitedBody = res.body;
      }

      // Requests up to the cap are allowed through (guards against a regression
      // to limit 0 that would blanket-block legitimate connect-screen traffic).
      expect(statuses.filter((s) => s === 200)).toHaveLength(CAP);
      // Everything past the cap is rejected with 429, and the final request is
      // definitively blocked.
      expect(statuses.filter((s) => s === 429)).toHaveLength(total - CAP);
      expect(statuses[statuses.length - 1]).toBe(429);

      // The block short-circuits to the documented 429 response.
      expect(limitedBody).toMatchObject({ error: "Too Many Requests" });
    });

    it("rate-limits per IP, so a second IP under the cap still resolves", async () => {
      setDirectory(
        JSON.stringify([{ code: "acme", name: "Acme", apiBaseUrl: "https://acme.example.app" }]),
      );

      // Exhaust one IP's budget entirely.
      const flooded = "198.51.100.8";
      for (let i = 0; i < CAP + 1; i += 1) {
        await resolve("acme", flooded);
      }
      expect((await resolve("acme", flooded)).status).toBe(429);

      // A different IP starts with a fresh bucket and resolves normally — the
      // limiter is scoped per-IP, not a global kill-switch.
      const fresh = "198.51.100.9";
      const ok = await resolve("acme", fresh);
      expect(ok.status).toBe(200);
      expect(ok.body.code).toBe("acme");
    });
  });
});

// resolveSelfOrgInvite powers the admin "App Invite" surface: it tells the
// portal which org code THIS deployment hands out, so admins can share a link /
// QR without anyone hardcoding the code into the build.
describe("resolveSelfOrgInvite", () => {
  function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it("prefers an explicit ORG_CODE override (normalized)", () => {
    setEnv("ORG_CODE", "  ACME  ");
    setDirectory(undefined);
    expect(resolveSelfOrgInvite()).toEqual({ code: "acme", name: "acme" });
  });

  it("reuses the directory display name when ORG_CODE matches an entry", () => {
    setEnv("ORG_CODE", "acme");
    setDirectory(
      JSON.stringify([{ code: "acme", name: "Acme Security", apiBaseUrl: "https://acme.example.app" }]),
    );
    expect(resolveSelfOrgInvite()).toEqual({ code: "acme", name: "Acme Security" });
  });

  it("ignores a malformed ORG_CODE and falls through to origin matching", () => {
    setEnv("ORG_CODE", "Bad Code!");
    setEnv("APP_BASE_URL", "https://acme.example.app");
    setEnv("REPLIT_DOMAINS", undefined);
    setDirectory(
      JSON.stringify([{ code: "acme", name: "Acme Security", apiBaseUrl: "https://acme.example.app" }]),
    );
    expect(resolveSelfOrgInvite()).toEqual({ code: "acme", name: "Acme Security" });
  });

  it("matches this deployment's APP_BASE_URL origin against the directory", () => {
    setEnv("ORG_CODE", undefined);
    setEnv("APP_BASE_URL", "https://acme.example.app/");
    setEnv("REPLIT_DOMAINS", undefined);
    setDirectory(
      JSON.stringify([
        { code: "other", name: "Other", apiBaseUrl: "https://other.example.app" },
        { code: "acme", name: "Acme Security", apiBaseUrl: "https://acme.example.app" },
      ]),
    );
    expect(resolveSelfOrgInvite()).toEqual({ code: "acme", name: "Acme Security" });
  });

  it("returns null when nothing resolves the code", () => {
    setEnv("ORG_CODE", undefined);
    setEnv("APP_BASE_URL", "https://unlisted.example.app");
    setEnv("REPLIT_DOMAINS", undefined);
    setDirectory(
      JSON.stringify([{ code: "acme", name: "Acme", apiBaseUrl: "https://acme.example.app" }]),
    );
    expect(resolveSelfOrgInvite()).toBeNull();
  });
});

describe("getSelfOrigin", () => {
  function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it("prefers APP_BASE_URL, normalized to an origin", () => {
    setEnv("APP_BASE_URL", "https://acme.example.app/");
    setEnv("REPLIT_DOMAINS", "ignored.example.app");
    expect(getSelfOrigin()).toBe("https://acme.example.app");
  });

  it("falls back to the first REPLIT_DOMAINS value over https", () => {
    setEnv("APP_BASE_URL", undefined);
    setEnv("REPLIT_DOMAINS", "first.example.app,second.example.app");
    expect(getSelfOrigin()).toBe("https://first.example.app");
  });

  it("returns null when neither is set", () => {
    setEnv("APP_BASE_URL", undefined);
    setEnv("REPLIT_DOMAINS", undefined);
    expect(getSelfOrigin()).toBeNull();
  });
});
