---
name: Metro watcher ENOENT on pnpm _tmp_ dirs
description: Expo/security-ops workflow crashes at startup with ENOENT watching a node_modules/.pnpm/*_tmp_<pid> dir; cause + fix.
---

# Metro FallbackWatcher crashes on orphan pnpm `_tmp_<pid>` dirs

**Symptom:** `artifacts/security-ops: expo` workflow FAILS at startup with
`Error: ENOENT: no such file or directory, watch '.../node_modules/.pnpm/<pkg>_tmp_<pid>/...'`
thrown from metro-file-map's `FallbackWatcher._watchdir`. Exit status 7.

**Cause:** The Replit container has no watchman/native fsevents, so Metro uses the
recursive `FallbackWatcher`, which walks ALL of `node_modules` (including `.pnpm`)
and `fs.watch`es every directory. pnpm stages package extraction into sibling
`<name>_tmp_<pid>` dirs and renames them into place on success. An interrupted or
**concurrent** `pnpm install` (e.g. the `deps-install` workflow racing the expo
workflow startup, or an integration install) leaves orphan `*_tmp_*` dirs behind,
and/or one is removed mid-walk — either way Metro's watch setup hits ENOENT and the
whole process dies. It is a race/cruft problem, NOT a code defect.

**Fix (no code change):**
1. `find node_modules/.pnpm -maxdepth 4 -name '*_tmp_*'` — each has a real sibling
   (`<dir>` with the `_tmp_<pid>` suffix stripped), so they are safe orphans.
2. `rm -rf` the orphans.
3. `restart_workflow("artifacts/security-ops: expo")`.

**How to apply:** Reach for this whenever the expo/Metro workflow ENOENT-crashes on
a `.pnpm/..._tmp_...` path. The specific dir named in the stack may already be gone
(self-resolved race) — clean ALL remaining `*_tmp_*` orphans, not just the named one.

**Possible permanent mitigation (not yet applied):** add a Metro `resolver.blockList`
/ `watchFolders` exclusion for `_tmp_` paths so the watcher never descends into them.
Avoided so far to keep scope minimal; revisit if this recurs.
