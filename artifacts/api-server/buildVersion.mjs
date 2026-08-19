import { execFileSync } from "node:child_process";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
}

/**
 * Resolve the shared master source revision represented by this checkout.
 *
 * Customer forks fetch the master as `upstream/main`. That ref is only valid as
 * the deployed source identity after it is an ancestor of HEAD; a fetch without
 * a merge must not make old customer code look current.
 */
export function resolveBuildVersion(artifactDir, explicitVersion = process.env.BUILD_VERSION) {
  if (explicitVersion) return explicitVersion;
  try {
    git(artifactDir, [
      "merge-base",
      "--is-ancestor",
      "refs/remotes/upstream/main",
      "HEAD",
    ]);
    return git(artifactDir, [
      "rev-parse",
      "--short",
      "refs/remotes/upstream/main",
    ]);
  } catch {
    // Master checkouts have no upstream ref, and fetched-but-unmerged customer
    // checkouts intentionally fall through to their nonmatching local HEAD.
  }
  try {
    return git(artifactDir, ["rev-parse", "--short", "HEAD"]);
  } catch {
    return "unknown";
  }
}