import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildVersion } from "../../buildVersion.mjs";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

describe("customer build source identity", () => {
  const root = mkdtempSync(path.join(tmpdir(), "secureops-build-version-"));
  const masterDir = path.join(root, "master");
  const customerDir = path.join(root, "customer");
  let masterRevision = "";
  let unmergedCustomerRevision = "";

  beforeAll(() => {
    git(root, ["init", "-q", "-b", "main", masterDir]);
    git(masterDir, ["config", "user.email", "master@example.test"]);
    git(masterDir, ["config", "user.name", "Master"]);
    writeFileSync(path.join(masterDir, "app.txt"), "base\n");
    git(masterDir, ["add", "app.txt"]);
    git(masterDir, ["commit", "-qm", "base"]);

    git(root, ["clone", "-q", masterDir, customerDir]);
    git(customerDir, ["remote", "rename", "origin", "upstream"]);
    git(customerDir, ["config", "user.email", "customer@example.test"]);
    git(customerDir, ["config", "user.name", "Customer"]);
    writeFileSync(path.join(customerDir, "customer.txt"), "customer config\n");
    git(customerDir, ["add", "customer.txt"]);
    git(customerDir, ["commit", "-qm", "customer changes"]);

    writeFileSync(path.join(masterDir, "app.txt"), "base\nmaster update\n");
    git(masterDir, ["add", "app.txt"]);
    git(masterDir, ["commit", "-qm", "master update"]);
    masterRevision = git(masterDir, ["rev-parse", "--short", "HEAD"]);

    git(customerDir, ["fetch", "-q", "upstream"]);
    unmergedCustomerRevision = git(customerDir, ["rev-parse", "--short", "HEAD"]);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not report a fetched master revision before it is merged", () => {
    expect(resolveBuildVersion(customerDir, "")).toBe(unmergedCustomerRevision);
    expect(resolveBuildVersion(customerDir, "")).not.toBe(masterRevision);
  });

  it("reports the shared master revision after a merge", () => {
    git(customerDir, ["merge", "-q", "--no-edit", "upstream/main"]);
    expect(resolveBuildVersion(customerDir, "")).toBe(masterRevision);
  });

  it("keeps reporting the merged master revision after customer-only commits", () => {
    writeFileSync(path.join(customerDir, "after-merge.txt"), "tenant override\n");
    git(customerDir, ["add", "after-merge.txt"]);
    git(customerDir, ["commit", "-qm", "post-merge customer change"]);
    expect(resolveBuildVersion(customerDir, "")).toBe(masterRevision);
  });
});