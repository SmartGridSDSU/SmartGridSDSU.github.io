/*
 * Smart Grid Lab – JDP applicant portal settings (Join page + private application page).
 * Edit these values, then commit and push the website.
 *
 *   endpoint          Google Apps Script web-app URL (ends in /exec). Leave "" to keep the
 *                     online application closed on the live site (the pages then say it is
 *                     not open yet). On localhost / 127.0.0.1 the pages always use the
 *                     same-origin /api/... paths of local_server.py instead.
 *   cycle             Admission cycle sent with every application.
 *   deadline          Last day for link requests and applications (inclusive), YYYY-MM-DD;
 *                     "" = no deadline. Keep it equal to the DEADLINE Script Property.
 *   deadlineTimeZone  Time zone of the deadline: everything closes at 23:59:59 on the
 *                     deadline day in this zone, for every applicant.
 *   maxFileMB         Size limit for each PDF.
 *   maxTotalMB        Size limit for all PDFs together.
 *   applyPath         Path of the private application page. The links in invitation emails
 *                     point here (keep it in sync with the APPLY_URL Script Property).
 */
window.JDP_APPLY_CONFIG = {
  endpoint: "https://script.google.com/macros/s/AKfycbyeoR21uWl1XcTnAmEXHzrMdyhIcB4riOxyTYztNHGuW3fg8X7uL3wy9_sVP5rUAped7Q/exec",
  cycle: "Fall 2027",
  deadline: "2026-12-01",  // official JDP application deadline for Fall 2027 (inclusive)
  deadlineTimeZone: "America/Los_Angeles",
  maxFileMB: 5,
  maxTotalMB: 15,
  applyPath: "/join/apply/"
};
