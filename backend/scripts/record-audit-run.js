// Files a data-model audit run in the Notion "Data Model Audits" database.
//
// The run log was missed once because nothing connected running the agent to
// recording it -- the agent writes two files and stops, and per its own rules
// it does not touch Notion. This closes that gap: the agent leaves an
// <!-- audit-meta --> block in the audit, and this reads it.
//
// Run: node scripts/record-audit-run.js [--dry-run]
//   NOTION_API_KEY                 an integration token shared with the database
//   NOTION_DATA_MODEL_AUDITS_DATA_SOURCE_ID  the data source id (has a default below).
//     Named in full rather than NOTION_AUDIT_LOG_..., which is already taken by the
//     app's own Audit Log database -- the short name silently pointed this at that.
//
// --dry-run derives and prints the row without a token, so the output can be
// checked offline.

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@notionhq/client";

import { auditRunRecord, AuditRecordError } from "../src/auditRunRecord.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUDIT = path.join(REPO_ROOT, "docs", "data", "schema-audit.md");

// Not a secret; access is controlled by the token. Overridable to point a
// test run at a different database.
const DEFAULT_DATA_SOURCE = "8970790a-d157-47af-bc8a-3aa6542960c0";

const dryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

if (!existsSync(AUDIT)) {
  fail(`${path.relative(REPO_ROOT, AUDIT)} does not exist. Run the data-model agent first.`);
}

let row;
try {
  row = auditRunRecord(readFileSync(AUDIT, "utf8"));
} catch (err) {
  if (err instanceof AuditRecordError) fail(err.message);
  throw err;
}

console.log(`Name:          ${row.name}`);
console.log(`Commit:        ${row.commit}`);
console.log(`Introspection: ${row.introspection}`);
console.log(`Findings:      ${row.findings}  (${row.high} high, ${row.medium} medium, ${row.low} low)`);
console.log(`Headline:      ${row.headline}`);
for (const warning of row.warnings) console.warn(`\nWARNING: ${warning}`);

if (dryRun) {
  console.log("\n[dry run] Nothing was written to Notion.");
  process.exit(0);
}

const apiKey = process.env.NOTION_API_KEY;
const dataSourceId = process.env.NOTION_DATA_MODEL_AUDITS_DATA_SOURCE_ID || DEFAULT_DATA_SOURCE;
// Skips rather than fails when the token is absent, matching the deploy step
// in ci.yml: a workflow should not go red because a secret has not been added
// yet, and the agent run that precedes this one costs real money -- losing it
// to a red step would be the expensive kind of failure.
if (!apiKey) {
  console.log("NOTION_API_KEY is not set -- not filing this run.");
  console.log("Add it under Settings > Secrets and variables > Actions, and share the Notion");
  console.log("integration with the destination (open it -> ... -> Connections).");
  process.exit(0);
}

const notion = new Client({ auth: apiKey });

try {
  // One row per audited commit. Re-running the publisher after a failed step
  // should not leave two rows for the same run -- and a second audit of the
  // same commit is a re-run, not a new data point.
  const existing = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { property: "Commit", rich_text: { equals: row.commit } },
    page_size: 1,
  });
  if (existing.results.length > 0) {
    console.log(`\nA run for commit ${row.commit} is already filed. Nothing written.`);
    process.exit(0);
  }

  const page = await notion.pages.create({
    parent: { data_source_id: dataSourceId },
    properties: {
      Name: { title: [{ text: { content: row.name } }] },
      "Run at": { date: { start: row.runAt } },
      Commit: { rich_text: [{ text: { content: row.commit } }] },
      Introspection: { select: { name: row.introspection } },
      Findings: { number: row.findings },
      High: { number: row.high },
      Medium: { number: row.medium },
      Low: { number: row.low },
      Headline: { rich_text: [{ text: { content: row.headline } }] },
    },
  });
  console.log(`\nFiled: ${page.url || page.id}`);
} catch (err) {
  const message = String(err?.body || err?.message || String(err));

  // These two read almost the same and mean opposite things. Matching them
  // together once sent someone hunting for a sharing problem that did not
  // exist, while the real cause -- pointing at the wrong database entirely --
  // was named in the error and ignored.
  if (/Could not find property/.test(message)) {
    fail(
      `Data source ${dataSourceId} is reachable, but it is not the Data Model Audits database:\n` +
        `  ${message}\n\n` +
        `Nothing was written, which is the right outcome -- filing an audit run into some other\n` +
        `database would be worse than failing. Check NOTION_DATA_MODEL_AUDITS_DATA_SOURCE_ID if it is set;\n` +
        `it should be the Data Model Audits database, not the app's Audit Log.`
    );
  }
  if (/Could not find (data ?source|database|page|block)/i.test(message)) {
    fail(
      `Notion could not find data source ${dataSourceId}.\n` +
        `Either the id is wrong, or the integration behind NOTION_API_KEY has not been shared with the\n` +
        `Data Model Audits database. Open it -> ... -> Connections -> add the integration.`
    );
  }
  fail(`Notion rejected the row: ${message}`);
}
