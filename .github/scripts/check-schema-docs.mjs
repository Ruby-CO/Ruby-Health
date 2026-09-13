// Does the data-model documentation still describe the code?
//
// This does not run the `data-model` agent and does not call a model. It
// answers one cheap, deterministic question: did this change move the data
// model without refreshing the generated docs? If so, the ERD and the audit
// in docs/data/ are describing a schema that no longer exists, and the next
// person to read them is reading fiction.
//
// It only ever reports. It never edits a file, and the workflow only runs it
// on commits that touch the watched paths -- see .github/workflows/schema-docs.yml.
//
// Run it locally the same way CI does:
//   node .github/scripts/check-schema-docs.mjs            # vs origin/master
//   node .github/scripts/check-schema-docs.mjs <base> <head>

import { execFileSync } from "node:child_process";

// backend/src/repository/ IS the schema -- the parse*/create* pairs are the
// only definition of which Notion property maps to which domain field. A
// change here always moves the stored shape.
const isStoredSchema = (file) => file.startsWith("backend/src/repository/");

// The pipeline defines the fields that get *written into* a schema that
// doesn't type them (artifact content is one JSON blob). A change here may or
// may not move a field name, and we can't tell which from a path -- so this
// side never fails a build, it only leaves a note.
const isPipeline = (file) => file.startsWith("backend/src/pipeline/");

// What the agent regenerates.
const GENERATED = ["docs/data/schema.mermaid", "docs/data/schema-audit.md"];
// What a human maintains alongside it (SCHEMA.md, step 4 of "Changing the schema").
const DOCTRINE = "docs/data/SCHEMA.md";

const ZERO_SHA = "0000000000000000000000000000000000000000";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function exists(ref) {
  if (!ref || ref === ZERO_SHA) return false;
  try {
    git(["cat-file", "-e", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// A pull request asks "what does this branch add on top of master", which is
// the merge-base diff (three dots). A push asks "what arrived in this push",
// which is the plain range (two dots).
function resolveRange() {
  const event = process.env.GITHUB_EVENT_NAME;
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA || "HEAD";

  if (event === "pull_request") {
    const from = exists(base) ? base : "origin/master";
    return { range: `${from}...${head}`, describe: `this branch vs ${exists(base) ? "its merge base" : "origin/master"}` };
  }
  if (event === "push") {
    // A first push to a branch, or a force push, reports an all-zero "before".
    const from = exists(base) ? base : "HEAD~1";
    return { range: `${from}..${head}`, describe: "this push" };
  }
  // Local run.
  const [argBase, argHead] = process.argv.slice(2);
  if (argBase) return { range: `${argBase}...${argHead || "HEAD"}`, describe: "the range you gave" };
  return { range: "origin/master...HEAD", describe: "your branch vs origin/master" };
}

const { range, describe } = resolveRange();

let changed;
try {
  changed = git(["diff", "--name-only", range]).split("\n").filter(Boolean);
} catch (err) {
  // Never fail a build because the range could not be worked out -- that is a
  // CI plumbing problem, not a schema problem, and a red X here would be a lie.
  console.log(`Could not diff ${range}; skipping the check.`);
  console.log(String(err.message || err).split("\n")[0]);
  process.exit(0);
}

const storedMoved = changed.filter(isStoredSchema);
const pipelineMoved = changed.filter(isPipeline);
const generatedRefreshed = changed.some((f) => GENERATED.includes(f));
const doctrineRefreshed = changed.includes(DOCTRINE);

const lines = [];
const annotations = [];
let stale = false;

if (storedMoved.length > 0 && !generatedRefreshed) {
  stale = true;
  lines.push(
    `**The stored schema moved and the generated docs did not.**`,
    ``,
    `Changed in ${describe}:`,
    ...storedMoved.map((f) => `- \`${f}\``),
    ``,
    `\`docs/data/schema.mermaid\` and \`docs/data/schema-audit.md\` still describe the previous shape.`,
    `Re-run the data-model agent to refresh them:`,
    ``,
    "```",
    "run the data-model agent",
    "```",
    ``
  );
  annotations.push(`::error::The stored schema changed (${storedMoved.join(", ")}) but docs/data/ was not refreshed. Run the data-model agent.`);
}

if (storedMoved.length > 0 && !doctrineRefreshed) {
  lines.push(
    `**\`docs/data/SCHEMA.md\` was not updated.**`,
    ``,
    `The doctrine file is meant to change in the same PR as the schema it describes`,
    `(SCHEMA.md, "Changing the schema", step 4). If this change added a field, a`,
    `relationship or a select vocabulary, say so there. If it did not, ignore this.`,
    ``
  );
  annotations.push(`::warning::docs/data/SCHEMA.md was not updated alongside the schema change.`);
}

if (storedMoved.length === 0 && pipelineMoved.length > 0 && !generatedRefreshed) {
  lines.push(
    `**Pipeline output may have moved.**`,
    ``,
    `Changed in ${describe}:`,
    ...pipelineMoved.map((f) => `- \`${f}\``),
    ``,
    `A path cannot tell whether this renamed a field or reworded a prompt. If it`,
    `changed what the pipeline emits, the audit's schema-vs-pipeline section is now`,
    `stale. This is a note, not a failure.`,
    ``
  );
  annotations.push(`::notice::Pipeline files changed; the audit's schema-vs-pipeline section may be stale.`);
}

if (lines.length === 0) {
  lines.push(`The data-model docs are consistent with ${describe}. Nothing to do.`);
}

for (const annotation of annotations) console.log(annotation);
console.log(lines.join("\n"));

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Data-model docs\n\n${lines.join("\n")}\n`);
}

// Fail on a pull request, where refreshing the docs is still cheap and the
// change has not landed yet. On master the commit is already in, and a red
// check there would say "master is not deployable", which is not what this
// found -- so it reports and passes.
if (stale && process.env.GITHUB_EVENT_NAME === "pull_request") process.exit(1);
process.exit(0);
