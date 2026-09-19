import test from "node:test";
import assert from "node:assert/strict";

import { recordAudit } from "../src/auditLog.js";

const entry = { providerId: "default", entityType: "claim", entityId: "CL001", action: "created", detail: "x" };

test("recordAudit passes the entry through and reports success", async () => {
  const calls = [];
  const repository = { createLogEntry: async (e) => (calls.push(e), { logId: "LOG001", ...e }) };
  assert.equal(await recordAudit(repository, entry), true);
  assert.deepEqual(calls, [entry]);
});

test("recordAudit never throws when the log write fails", async () => {
  // The guardrail this module exists for: a log failure must not become a
  // second silent-failure point, and must not block the write it describes.
  const repository = {
    createLogEntry: async () => {
      throw new Error("Notion is down");
    },
  };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(await recordAudit(repository, entry), false);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1, "the failure is reported, loudly, exactly once");
  assert.match(errors[0][0], /AUDIT LOG WRITE FAILED/);
  assert.match(errors[0][1], /CL001/, "the lost entry is printed so the trail can be rebuilt by hand");
});

test("recordAudit with no repository is a no-op, not an error", async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(await recordAudit(null, entry), false);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 0);
});
