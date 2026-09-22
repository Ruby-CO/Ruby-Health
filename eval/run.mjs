// Accuracy evaluation runner.
//
//   node eval/run.mjs                      # score against a local server
//   node eval/run.mjs --base <url>         # ...or a deployed one
//   node eval/run.mjs --only 002,014       # a subset, while iterating
//   node eval/run.mjs --mock               # harness check, no API calls
//
// Every real run costs money (roughly a dollar fifty for the full suite at
// current pricing) because it calls the model once per encounter. The scorecard
// is written to eval/results/ so runs can be compared over time.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreEncounter, aggregate } from "./score.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENCOUNTERS_DIR = path.join(__dirname, "encounters");
const RESULTS_DIR = path.join(__dirname, "results");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = arg("base", process.env.EVAL_BASE_URL || "http://127.0.0.1:3000");
const ONLY = arg("only");
const MOCK = flag("mock");

async function loadEncounters() {
  const files = (await fs.readdir(ENCOUNTERS_DIR)).filter((f) => f.endsWith(".json")).sort();
  const wanted = ONLY ? ONLY.split(",").map((s) => s.trim()) : null;
  const out = [];
  for (const f of files) {
    const fixture = JSON.parse(await fs.readFile(path.join(ENCOUNTERS_DIR, f), "utf8"));
    if (wanted && !wanted.some((w) => fixture.id.startsWith(w))) continue;
    out.push(fixture);
  }
  return out;
}

async function post(endpoint, body) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error || text;
    } catch {
      /* not JSON; use the raw body */
    }
    throw new Error(`${endpoint} -> ${res.status}: ${message}`);
  }
  return JSON.parse(text);
}

/**
 * Run one encounter through the real pipeline: transcript -> facts -> codes.
 * Deliberately does not call the cleanup step -- these transcripts are already
 * punctuated, and cleanup is leaving the claim path in P2.
 */
async function runPipeline(fixture) {
  // P2: one merged call returns both facts and suggestions.
  // skipPersistence: the eval measures the pipeline, it must not write into the
  // product store (audit C2).
  const { facts, suggestions } = await post("/api/extract", { transcript: fixture.transcript, skipPersistence: true });
  return { facts, suggestions };
}

/**
 * Mock mode returns the answer key itself, so a mock run scores 100%. That is
 * the point: it proves the harness, scorer and reporting work end to end
 * without spending money or needing an API key. It says nothing about accuracy.
 */
function mockPipeline(fixture) {
  const e = fixture.expected || {};
  const suggestions = [
    ...(e.diagnoses || []).map((code) => ({ code, codeType: "ICD-10", description: code, confidence: "high", rationale: "", supportingDiagnoses: [] })),
    ...(e.procedures || []).map((code) => ({
      code,
      codeType: "CPT",
      description: code,
      confidence: "high",
      rationale: "",
      supportingDiagnoses: (e.links || {})[code] || [],
    })),
    ...(e.emLevel ? [{ code: e.emLevel, codeType: "CPT", description: "office visit", confidence: "high", rationale: "", supportingDiagnoses: [] }] : []),
  ];
  return {
    facts: { medicalNecessityLanguage: (e.groundingPhrases || []).map((p) => `${p}`) },
    suggestions,
  };
}

const pct = (v) => (v === null ? "  n/a" : `${(v * 100).toFixed(1).padStart(5)}%`);

function report(results, agg) {
  console.log("\nPer encounter\n" + "-".repeat(78));
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.id.padEnd(38)} ERROR  ${r.error}`);
      continue;
    }
    const bits = [
      `dx ${r.diagnoses.hit}/${r.diagnoses.expected}`,
      `cpt ${r.procedures.hit}/${r.procedures.expected}`,
      `E/M ${r.em.verdict === "correct" ? "ok" : `${r.em.actual ?? "-"} vs ${r.em.expected ?? "-"}`}`,
      r.linkage.expected ? `link ${r.linkage.correct}/${r.linkage.expected}` : null,
      r.grounding.quotes ? `quotes ${r.grounding.verified}/${r.grounding.quotes}` : null,
      r.forbidden.length ? `FORBIDDEN ${r.forbidden.join(",")}` : null,
    ].filter(Boolean);
    console.log(`  ${r.id.padEnd(38)} ${bits.join("  ")}`);
  }

  console.log("\nScorecard\n" + "-".repeat(78));
  const rows = [
    ["Diagnosis recall", pct(agg.diagnosisRecall), "expected diagnoses that were coded"],
    ["Procedure recall", pct(agg.procedureRecall), "expected procedures that were coded"],
    ["E/M exact", pct(agg.emExact), "visit level matched the key"],
    ["E/M within one level", pct(agg.emWithinOne), "off by at most one step"],
    ["Linkage accuracy", pct(agg.linkageAccuracy), "service lines pointed at the right diagnosis"],
    ["Quote grounding", pct(agg.groundingRate), "necessity quotes found verbatim in the transcript"],
    ["Necessity phrase recall", pct(agg.necessityPhraseRecall), "key phrases the extraction should have captured"],
  ];
  for (const [label, value, note] of rows) {
    console.log(`  ${label.padEnd(26)} ${value}   ${note}`);
  }

  console.log("\n  Counts");
  console.log(`    Forbidden codes emitted     ${agg.forbiddenCodeCount} (across ${agg.encountersWithForbiddenCode} encounters)`);
  console.log(`    Codes beyond the key        ${agg.extraCodeCount}  (informational -- may be defensible)`);
  console.log(`    Upcoded visit levels        ${agg.emUpcodedCount}  (coded higher than the key)`);
  console.log(`    Claims that failed to build ${agg.claimErrors}`);
  console.log("");
}

async function main() {
  const encounters = await loadEncounters();
  if (encounters.length === 0) {
    console.error("No encounters matched.");
    process.exit(1);
  }

  console.log(
    MOCK
      ? `Running ${encounters.length} encounters in MOCK mode (no API calls, no cost).`
      : `Running ${encounters.length} encounters against ${BASE} -- this calls the model and costs money.`
  );

  const results = [];
  for (const fixture of encounters) {
    try {
      const actual = MOCK ? mockPipeline(fixture) : await runPipeline(fixture);
      results.push(scoreEncounter(fixture, actual));
    } catch (err) {
      // One bad encounter should not lose the whole run.
      results.push({
        id: fixture.id,
        error: err.message,
        diagnoses: { expected: 0, hit: 0, missed: [] },
        procedures: { expected: 0, hit: 0, missed: [] },
        em: { verdict: "error", distance: null, expected: null, actual: null },
        forbidden: [],
        extraCodes: [],
        grounding: { quotes: 0, verified: 0, unsupported: [], expectedPhrases: 0, phrasesFound: 0 },
        linkage: { expected: 0, correct: 0, wrong: [], claimError: null },
      });
    }
  }

  const scored = results.filter((r) => !r.error);
  const agg = aggregate(scored);
  report(results, agg);

  const failed = results.length - scored.length;
  if (failed > 0) console.log(`  ${failed} encounter(s) errored and are excluded from the scorecard.\n`);

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outfile = path.join(RESULTS_DIR, `${MOCK ? "mock-" : ""}${stamp}.json`);
  await fs.writeFile(outfile, JSON.stringify({ runAt: new Date().toISOString(), base: MOCK ? "mock" : BASE, summary: agg, results }, null, 2) + "\n");
  console.log(`Scorecard written to ${path.relative(process.cwd(), outfile)}\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
