// Dynamic Expo config — extends app.json.
//
// EXPO_WEB_BASE_URL (set ONLY by scripts/build-single-vm.mjs) roots the WEB
// export under a sub-path (e.g. "/app") so the single-VM production server can
// serve the mobile web build next to the marketing site and admin portal.
// `experiments.baseUrl` prefixes every emitted asset URL and the Expo Router
// basename. When the env var is absent (dev, EAS native builds, OTA updates)
// this returns app.json unchanged.
module.exports = ({ config }) => {
  const baseUrl = process.env.EXPO_WEB_BASE_URL;
  if (baseUrl) {
    config.experiments = { ...config.experiments, baseUrl };
  }
  return config;
};
