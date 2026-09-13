import test from "node:test";
import assert from "node:assert/strict";

import { persistenceFailure } from "../src/persistence.js";

test("nothing to report when every attempted write succeeded", () => {
  assert.equal(persistenceFailure({ stage: "facts", saved: true }), undefined);
});

test("a write that was never attempted is not a failure", () => {
  // null means no repository configured, or no encounter yet. Warning here
  // would put a red line on every claim in a demo with persistence switched
  // off -- which is how a warning stops being read.
  assert.equal(persistenceFailure(null, null), undefined);
  assert.equal(persistenceFailure(null, { stage: "facts", saved: true }), undefined);
});

test("a failed write is reported by name", () => {
  const result = persistenceFailure({ stage: "facts", saved: false });
  assert.equal(result.saved, false);
  assert.deepEqual(result.stages, ["facts"]);
  assert.match(result.message, /facts/);
  assert.match(result.message, /Nothing was written/);
});

test("two failed writes in one step are named together", () => {
  const result = persistenceFailure(
    { stage: "transcript", saved: false },
    { stage: "facts", saved: false }
  );
  assert.deepEqual(result.stages, ["transcript", "facts"]);
  assert.match(result.message, /transcript and facts/);
});

test("one failure among successes still reports, and only names the failure", () => {
  const result = persistenceFailure(
    { stage: "transcript", saved: true },
    { stage: "facts", saved: false }
  );
  assert.deepEqual(result.stages, ["facts"]);
  assert.equal(result.message.includes("transcript"), false);
});

test("no arguments is not a failure", () => {
  assert.equal(persistenceFailure(), undefined);
});
