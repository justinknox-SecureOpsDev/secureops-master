---
name: pnpm overrides must live in pnpm-workspace.yaml
description: Adding dependency overrides to root package.json#pnpm.overrides silently drops the whole workspace override set under pnpm 10.
---

Dependency version overrides in this monorepo MUST be added to the `overrides:` block in `pnpm-workspace.yaml`, NOT to `package.json#pnpm.overrides`.

**Why:** pnpm 10.x does NOT merge `package.json#pnpm.overrides` with `pnpm-workspace.yaml#overrides`. If both exist, the package.json block REPLACES the workspace block wholesale in the generated lockfile. The workspace `overrides:` block holds ~118 security pins — CVE floors (e.g. `@xmldom/xmldom<0.8.13 -> >=0.8.13`, `node-forge`, `tar`, `ws`, `qs`), the vendored `shell-quote: file:./vendor/shell-quote` override, esbuild unification (`esbuild: 0.28.1`), and the platform-binary `'-'` exclusions. Dropping them silently regresses security across the whole workspace and massively bloats the lockfile (fresh re-resolution also drifts unrelated deps like nodemailer 9->8).

**How to apply:** To add/override a transitive dep (e.g. `eas-cli>@expo/plist: 0.4.8`), append it to the existing `overrides:` list in `pnpm-workspace.yaml`, then `pnpm install`. Verify: the lockfile's `overrides:` section still lists the full set (count ~118 + your additions), not just your line; and `git diff pnpm-lock.yaml` is minimal (just your override + its direct ripple). If you see nodemailer/esbuild/xmldom versions shifting, you've dropped the workspace overrides — restore the lockfile (`git show HEAD:pnpm-lock.yaml > pnpm-lock.yaml`) and re-install so pnpm applies only the minimal delta.
