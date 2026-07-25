import { Router } from "express";
import { brand } from "../lib/brandConfig";
import { getFeatureFlags } from "../lib/features";
import { getConfirmEditWindowHours } from "./timeEntries";

const router = Router();

/**
 * Public brand configuration endpoint.
 *
 * Returns the subset of brand config safe to expose to unauthenticated
 * clients (no emails, no demo credentials). Used by the admin portal and
 * mobile app to populate company name, app name, and brand colours without
 * hardcoding them in the front-end bundles.
 *
 * Not cached: brand config is now editable live from the admin portal
 * (Platform → Branding), so edits must surface on the next page load.
 */
router.get("/brand", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    companyName: brand.companyName,
    shortName:   brand.shortName,
    tagline:     brand.tagline,
    companyLicense: brand.companyLicense,
    appName:     brand.appName,
    colorNavy:   brand.colorNavy,
    colorGold:   brand.colorGold,
    colorCream:  brand.colorCream,
    logoDataUrl: brand.logoDataUrl,
    // Max hours an officer may move their own clock-in/out during post-shift
    // confirmation. Surfaced so the mobile review modal can state the real
    // limit up front and pre-validate before submitting.
    timeConfirmEditWindowHours: getConfirmEditWindowHours(),
    // Feature flags drive nav visibility on the admin portal and tab
    // visibility on the mobile app. Owner controls via DISABLED_FEATURES env.
    features:    getFeatureFlags(),
  });
});

export default router;
