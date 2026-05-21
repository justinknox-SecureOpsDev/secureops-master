import { Router } from "express";
import { brand } from "../lib/brandConfig";

const router = Router();

/**
 * Public brand configuration endpoint.
 *
 * Returns the subset of brand config safe to expose to unauthenticated
 * clients (no emails, no demo credentials). Used by the admin portal and
 * mobile app to populate company name, app name, and brand colours without
 * hardcoding them in the front-end bundles.
 *
 * Cached for 5 minutes at the edge/CDN level — brand config changes require
 * a server restart anyway.
 */
router.get("/api/brand", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({
    companyName: brand.companyName,
    shortName:   brand.shortName,
    tagline:     brand.tagline,
    appName:     brand.appName,
    colorNavy:   brand.colorNavy,
    colorGold:   brand.colorGold,
    colorCream:  brand.colorCream,
  });
});

export default router;
