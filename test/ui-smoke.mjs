// Headless-browser smoke test for the review UI.
//
// Checks the things a unit test cannot: that a grounding verdict actually
// reaches the screen, that an edited quote drops its stale verdict, and that a
// claim warning is surfaced above the form rather than buried in it.
//
// Model-backed endpoints are stubbed, so this exercises the UI, not the API.
//
// Run:  PORT=3115 node backend/src/server.js &   (no API key needed: the model endpoints are stubbed)
//       node test/ui-smoke.mjs
//
// Playwright is deliberately not a project dependency. Install it at the repo
// root without touching any package.json -- Node's ESM loader does not look in
// the global folder, so `npm i -g playwright` will not resolve from here:
//
//       npm i --no-save --no-package-lock playwright
//       npx playwright install chromium
//
// The root node_modules/ is gitignored. On a machine that already has a
// Chromium at a mismatched build, set PLAYWRIGHT_CHROMIUM_PATH to its binary
// rather than downloading a second copy.

import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3115";
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
const fails = [];
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails.push(m); };

// Stub the two model-backed endpoints so this exercises the UI, not the API.
await page.route("**/api/extract", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ facts: {
    chiefComplaint: "Sore throat",
    symptoms: ["sore throat", "fever"],
    diagnosesDiscussed: ["acute pharyngitis"],
    proceduresPerformed: ["rapid strep test"],
    medicalNecessityLanguage: [
      "No cough.",
      "Sore throat began three days ago, per the patient.",
      "Patient was admitted overnight for observation.",
    ],
    medicalNecessityGrounding: [
      { quote: "No cough.", status: "verified", recall: 1 },
      { quote: "Sore throat began three days ago, per the patient.", status: "paraphrased", recall: 0.9 },
      { quote: "Patient was admitted overnight for observation.", status: "unsupported", recall: 0.2 },
    ],
  }}),
}));
await page.route("**/api/suggest-codes", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ suggestions: [
    { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", confidence: "high", rationale: "r", supportingDiagnoses: [] },
    { code: "87880", codeType: "CPT", description: "Strep test", confidence: "high", rationale: "r", supportingDiagnoses: ["J02.9"] },
    { code: "90471", codeType: "CPT", description: "Immunization admin", confidence: "medium", rationale: "r", supportingDiagnoses: [] },
  ]}),
}));
await page.route("**/api/populate-claim", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ claim: {
    patient: { name: "S", dob: "1990-01-01", sex: "U", memberId: "X" },
    provider: { name: "P", npi: "0", address: "A" },
    payer: { name: "Pay", payerId: "0" },
    dateOfService: "2026-08-28", chiefComplaint: "Sore throat", medicalNecessityNotes: "",
    diagnoses: [{ pointer: "A", code: "J02.9", description: "Acute pharyngitis" }],
    serviceLines: [
      { code: "87880", description: "Strep test", diagnosisPointers: "A", units: 1 },
      { code: "90471", description: "Immunization admin", diagnosisPointers: "", units: 1 },
    ],
    warnings: [{ code: "UNLINKED_SERVICE_LINE", line: "90471", message: "Service line 90471 has no supporting diagnosis." }],
  }}),
}));

await page.goto(BASE, { waitUntil: "domcontentloaded" });

// There is no Extract button, and no button for any other stage: entering a
// step runs the stage that fills it (see "Walking into a step runs it" in
// CLAUDE.md). So the sidebar nav is how this test drives the pipeline -- the
// same path a provider takes -- rather than a run-everything Prepare claim,
// which would skip the cascade this is meant to exercise.
const enterStep = (tab) => page.click(`.nav-item[data-tab="${tab}"]`);

console.log("\n[ grounding badges ]");
await page.fill("#transcript", "Patient reports a sore throat. No cough.");
await enterStep("facts");
await page.waitForSelector(".quote-flag", { timeout: 8000 });
const flags = await page.$$eval(".quote-flag", els => els.map(e => [e.className, e.textContent.trim()]));
ok(flags.length === 3, `three quotes flagged (got ${flags.length})`);
ok(flags[0][0].includes("verified") && flags[0][1].includes("In context"), "verbatim quote reads as in-context");
ok(flags[1][0].includes("paraphrased") && flags[1][1].includes("Paraphrased"), "reworded quote is labelled a paraphrase, not a quote");
ok(flags[2][0].includes("unsupported") && flags[2][1].includes("Not found"), "unsupported quote is called out");

console.log("\n[ stale badge cannot persist through an edit ]");
await page.fill(".quote-card textarea >> nth=0", "Totally different text now");
const after = await page.$eval(".quote-flag", e => [e.className, e.textContent.trim()]);
ok(after[0].includes("unchecked") && after[1].includes("not re-checked"), "edited quote drops its old verdict");

console.log("\n[ claim warnings ]");
// The facts just changed, so Codes is stale and re-derives on entry; then the
// codes are new, so Claim does the same. Each walk-in is the trigger.
await enterStep("codes");
await page.waitForSelector(".code-card", { timeout: 8000 });
await enterStep("claim");
await page.waitForSelector(".claim-warning", { timeout: 8000 });
const warn = await page.$eval(".claim-warning", e => e.textContent);
ok(warn.includes("UNLINKED_SERVICE_LINE"), "unlinked service line is surfaced above the claim form");
const pointers = await page.$$eval("#claimForm input", els => els.map(e => e.value));
ok(pointers.includes("A"), "pointer A rendered on the linked line");

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall UI checks passed");
process.exit(fails.length ? 1 : 0);
