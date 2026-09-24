import test from "node:test";
import assert from "node:assert/strict";

import { transmitClaim, describeTransmission } from "../src/transmitClaim.js";
import { StediSubmissionError } from "../src/pipeline/submitToStedi.js";

const stediClaim = {
  claimInformation: { patientControlNumber: "CL004", claimFrequencyCode: "1", claimChargeAmount: "200.00" },
};
const now = () => new Date("2026-09-23T17:00:00.000Z");

function recorder() {
  const records = [];
  return { records, persist: async (content) => records.push(content) };
}

test("a sent claim is recorded with the payload, the response and the key Stedi saw", async () => {
  const { records, persist } = recorder();
  let keySent;
  const submit = async (_payload, key) => ((keySent = key), { status: "SUCCESS" });

  const response = await transmitClaim({ stediClaim, kind: "original", submit, persist, now });

  assert.deepEqual(response, { status: "SUCCESS" });
  assert.equal(records.length, 1);
  const [r] = records;
  assert.equal(r.outcome, "sent");
  assert.equal(r.claimId, "CL004");
  assert.equal(r.kind, "original");
  assert.equal(r.frequencyCode, "1");
  assert.equal(r.billedAmount, 200);
  assert.equal(r.sentAt, "2026-09-23T17:00:00.000Z");
  assert.equal(r.idempotencyKey, keySent, "the record must name the key the send actually used");
  assert.deepEqual(r.payload, stediClaim);
  assert.deepEqual(r.response, { status: "SUCCESS" });
  assert.equal(r.error, null);
});

test("a claim Stedi refuses is still recorded, and the refusal still reaches the caller", async () => {
  // Before this, a refused send left nothing but a console line.
  const { records, persist } = recorder();
  const refusal = new StediSubmissionError("Stedi rejected the claim submission (HTTP 400).", { errors: ["bad NPI"] });
  const submit = async () => {
    throw refusal;
  };

  await assert.rejects(() => transmitClaim({ stediClaim, kind: "corrected", submit, persist, now }), refusal);

  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "rejected");
  assert.deepEqual(records[0].error, { message: refusal.message, details: { errors: ["bad NPI"] } });
  assert.deepEqual(records[0].payload, stediClaim);
  assert.equal(records[0].response, null);
});

test("a send that never got an answer is recorded as an error, not a rejection", async () => {
  const { records, persist } = recorder();
  const submit = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(() => transmitClaim({ stediClaim, kind: "appeal", submit, persist, now }), TypeError);

  assert.equal(records[0].outcome, "error");
  assert.deepEqual(records[0].error, { message: "fetch failed", details: null });
});

test("a payload with no claim information is still recorded rather than crashing the send", async () => {
  const { records, persist } = recorder();
  await transmitClaim({ stediClaim: {}, kind: "original", submit: async () => ({}), persist, now });

  assert.equal(records[0].claimId, "");
  assert.equal(records[0].billedAmount, 0);
});

test("the audit line says what happened, where the copy is, and for how much", () => {
  const record = { outcome: "sent", billedAmount: 200, kind: "corrected", frequencyCode: "7" };
  assert.equal(describeTransmission(record, "A031"), "837P sent · as A031 · $200.00 · corrected (frequency 7)");
  assert.equal(
    describeTransmission({ ...record, outcome: "rejected" }, "A032"),
    "837P refused by Stedi · as A032 · $200.00 · corrected (frequency 7)"
  );
});

test("the audit line admits a send whose copy was not saved rather than pointing nowhere", () => {
  const record = { outcome: "error", billedAmount: 0, kind: "original", frequencyCode: "" };
  assert.equal(describeTransmission(record, undefined), "837P send failed · record not saved · $0.00 · original (frequency ?)");
});
