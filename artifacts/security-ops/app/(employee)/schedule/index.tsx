// Re-export the admin shifts list so site managers get the exact same scheduling UI
// inside the employee shell. The screen detects its hosting group at runtime
// (useSegments) and keeps navigation inside (employee)/schedule for site managers.
export { default } from "../../(admin)/shifts/index";
