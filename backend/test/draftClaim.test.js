import test from "node:test";
import assert from "node:assert/strict";

import { pickOriginalDraft } from "../src/draftClaim.js";

test("returns the encounter's original draft", () => {
  const draft = pickOriginalDraft([
    { claimId: "CL001", claimType: "original", status: "draft" },
  ]);
  assert.equal(draft.claimId, "CL001");
});

test("ignores a corrected draft a failed resubmission left behind", () => {
  // The exact S1 shape: an original that was billed and denied, then a
  // correction that never cleared Stedi and is stuck as a draft. The New Claim
  // path must not adopt the corrected row.
  const draft = pickOriginalDraft([
    { claimId: "CL001", claimType: "original", status: "denied" },
    { claimId: "CL002", claimType: "corrected", parentClaimId: "CL001", status: "draft" },
  ]);
  assert.equal(draft, null);
});

test("ignores an appeal draft the same way", () => {
  const draft = pickOriginalDraft([
    { claimId: "CL001", claimType: "original", status: "denied" },
    { claimId: "CL002", claimType: "corrected", parentClaimId: "CL001", status: "draft" },
    { claimId: "CL003", claimType: "original", status: "draft" },
  ]);
  // The original draft is still found, past the stuck corrected one.
  assert.equal(draft.claimId, "CL003");
});

test("prefers the most recent original draft", () => {
  const draft = pickOriginalDraft([
    { claimId: "CL001", claimType: "original", status: "draft" },
    { claimId: "CL002", claimType: "original", status: "draft" },
  ]);
  assert.equal(draft.claimId, "CL002");
});

test("no draft, empty, and non-array all yield null", () => {
  assert.equal(pickOriginalDraft([{ claimId: "CL001", claimType: "original", status: "submitted" }]), null);
  assert.equal(pickOriginalDraft([]), null);
  assert.equal(pickOriginalDraft(undefined), null);
});
