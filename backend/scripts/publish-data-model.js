// Publishes the generated data-model docs to the Notion "Data Model" page.
//
// The repo is the source of truth; this page is the readable mirror. It is
// REPLACED WHOLESALE on every run -- anything typed directly into the page is
// lost, which is why the page says so at the top. Notes belong in a child page.
//
// Run: node scripts/publish-data-model.js [--dry-run]
//   NOTION_API_KEY             an integration token shared with the page
//   NOTION_DATA_MODEL_PAGE_ID  the page's id (the trailing hex in its URL)
//
// --dry-run prints the markdown and touches nothing, so the composition can be
// checked without a token.

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@notionhq/client";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = path.join(REPO_ROOT, "docs", "data");

const dryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

function read(name) {
  const file = path.join(DOCS, name);
  if (!existsSync(file)) {
    fail(
      `${path.relative(REPO_ROOT, file)} does not exist.\n` +
        `Run the data-model agent first -- it writes the files this publishes.`
    );
  }
  return readFileSync(file, "utf8").trim();
}

function gitOrNull(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const mermaid = read("schema.mermaid");
const audit = read("schema-audit.md");
const doctrine = read("SCHEMA.md");

const sha = gitOrNull(["rev-parse", "--short", "HEAD"]) || "unknown commit";
const branch = gitOrNull(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown branch";
const today = new Date().toISOString().slice(0, 10);

// The doctrine file opens with its own H1 and a "What this file is" section
// aimed at someone reading it in the repo. On the page that duplicates the
// header below, so only the body from the first "---" onward is carried over.
const doctrineBody = doctrine.includes("\n---\n")
  ? doctrine.slice(doctrine.indexOf("\n---\n") + 5).trim()
  : doctrine;

const markdown = `# Data Model

> **Generated page — do not edit here.** Every run replaces this page in full.
> Put notes in a child page, not in this one. The source of truth is
> \`docs/data/\` in kayceecones/Ruby-Health.

**Generated from \`${sha}\` on ${branch} · ${today}**

To refresh: Actions → *Refresh data model* → **Run workflow** in GitHub, or ask
Claude Code \`update the data model page\`. Nothing refreshes this on its own —
if the commit above is behind master, this page is behind too.

---

## Diagram

\`\`\`mermaid
${mermaid}
\`\`\`

---

${audit}

---

${doctrineBody}
`;

if (dryRun) {
  console.log(markdown);
  console.error(`\n[dry run] ${markdown.length} characters composed. Nothing was written to Notion.`);
  process.exit(0);
}

const apiKey = process.env.NOTION_API_KEY;
const pageId = process.env.NOTION_DATA_MODEL_PAGE_ID;
if (!apiKey) fail("NOTION_API_KEY is not set.");
if (!pageId) {
  fail(
    "NOTION_DATA_MODEL_PAGE_ID is not set.\n" +
      "It is the trailing hex id in the Data Model page's URL. In GitHub it is a\n" +
      "repository variable (Settings -> Secrets and variables -> Actions -> Variables)."
  );
}

const notion = new Client({ auth: apiKey });

try {
  await notion.pages.updateMarkdown({
    page_id: pageId,
    type: "replace_content",
    // Required: without it the API refuses to remove the blocks already there,
    // and a "replace" that cannot delete would append instead.
    replace_content: { new_str: markdown, allow_deleting_content: true },
  });
  console.log(`Published ${markdown.length} characters to the Notion Data Model page.`);
  console.log(`Generated from ${sha} on ${branch}.`);
} catch (err) {
  const message = err?.body || err?.message || String(err);
  if (String(message).includes("Could not find page")) {
    fail(
      `Notion could not find page ${pageId}.\n` +
        `Either the id is wrong, or the integration behind NOTION_API_KEY has not been\n` +
        `shared with that page. Open the page -> ... -> Connections -> add the integration.`
    );
  }
  fail(`Notion rejected the update: ${message}`);
}
