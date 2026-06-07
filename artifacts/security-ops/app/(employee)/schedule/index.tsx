// Re-export the admin shifts list so leads get the exact same scheduling UI
// inside the employee shell. The screen detects its hosting group at runtime
// (useSegments) and keeps navigation inside (employee)/schedule for leads.
export { default } from "../../(admin)/shifts/index";
