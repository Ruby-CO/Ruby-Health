import test from "node:test";
import assert from "node:assert/strict";

import { ingestRemittance, RemittanceIngestError, CLAIM_STATUS_FROM_ADJUDICATION } from "../src/pipeline/ingestRemittance.js";
import { loadAdjustmentCodes } from "../../reference/loadAdjustmentCodes.mjs";

const adjustmentCodes = await loadAdjustmentCodes();

// Just enough repository to watch what ingestion does to a claim. Narrower
// than the fake Notion client in NotionRepository.test.js on purpose -- what
// is under test here is the orchestration, not the persistence.
function stubRepository({ claim = { claimId: "CL001", status: "submitted", payerClaimControlNumber: null } } = {}) {
  const calls = { feedback: [], statusUpdates: [], controlNumbers: [] };
  return {
    calls,
    async getClaim(claimId) {
      return claimId === claim.claimId ? { ...claim } : null;
    },
    async createPayerFeedback(input) {
      calls.feedback.push(input);
      return { feedbackId: `PF00${calls.feedback.length}`, ...input };
    },
    async setPayerClaimControlNumber(claimId, controlNumber) {
      calls.controlNumbers.push({ claimId, controlNumber });
      return { ...claim, payerClaimControlNumber: controlNumber };
    },
    async updateClaimStatus(claimId, status) {
      calls.statusUpdates.push({ claimId, status });
      return { ...claim, status };
    },
  };
}

// Builds a synthetic 835 in the shape confirmed against a real Stedi Test
// Payer response (see parseRemittance.js's header comment). All data here is
// synthetic -- reference/README.md: a real 835 must never land in this repo.
function buildEra({
  statusCode = "4",
  billed = "150",
  paid = "0",
  patientResponsibility = "0",
  payerClaimControlNumber = "2026250012345",
  remittanceDate = "20260905",
  groupCode = "CO",
  reasonCode = "50",
  claimCount = 1,
  // CLP01 per claim loop -- the control number Ruby sent. Defaults to the
  // `ruby-<n>` placeholder claims carried before Ruby sent its own id.
  patientControlNumbers = null,
} = {}) {
  const claimBlocks = Array.from({ length: claimCount }, (_, i) => {
    const controlNumber = claimCount > 1 && payerClaimControlNumber ? `${payerClaimControlNumber}-${i + 1}` : payerClaimControlNumber;
    return [
      `LX*${i + 1}~`,
      `CLP*${(patientControlNumbers && patientControlNumbers[i]) || `ruby-${i + 1}`}*${statusCode}*${billed}*${paid}*${patientResponsibility}*ZZ*${controlNumber}*11*1~`,
      `DTM*232*${remittanceDate}~`,
      "SVC*HC`99213*" + billed + "*" + paid + "**1*HC`99213*1~",
      `DTM*472*${remittanceDate}~`,
      ...(groupCode && reasonCode ? [`CAS*${groupCode}*${reasonCode}*${billed}~`] : []),
    ].join("\n");
  }).join("\n");

  return [
    "ISA*00*          *00*          *ZZ*STEDITEST      *ZZ*134129016687   *260908*1907*^*00501*000000010*0*T*`~",
    "GS*HP*STEDITEST*134129016687*20260908*190744*10*X*005010X221A1~",
    "ST*835*0001~",
    `BPR*I*${paid}*C*ACH************${remittanceDate}~`,
    "TRN*1*trace*1234567890~",
    `DTM*405*${remittanceDate}~`,
    "N1*PR*Sample Payer Insurance*XV*SAMPLE~",
    claimBlocks,
    "SE*20*0001~",
    "GE*1*10~",
    "IEA*1*000000010~",
  ].join("\n");
}

// The exact document build most tests below start from: one denied claim,
// CO-50 (medical necessity) on its only line.
const DENIED_REMITTANCE = buildEra();

test("ingesting a denial files the feedback and moves the claim to denied", async () => {
  const repository = stubRepository();

  const result = await ingestRemittance({
    repository,
    adjustmentCodes,
    claimId: "CL001",
    remittance: DENIED_REMITTANCE,
    dateOfService: "2026-08-20",
    today: "2026-09-08",
  });

  assert.equal(result.claimStatus, "denied");
  assert.equal(result.analysis.recommendedRoute, "appeal");
  assert.equal(result.analysis.money.atRisk, 150);

  const [filed] = repository.calls.feedback;
  assert.equal(filed.claimId, "CL001");
  assert.equal(filed.feedbackType, "remittance");
  assert.equal(filed.claimStatus, "denied");
  assert.equal(filed.recommendedRoute, "appeal");
  assert.equal(filed.amountAtRisk, 150);
  // The date comes off the document, not off the clock.
  assert.equal(filed.receivedAt, "2026-09-05");
  // Both the payer's reading and ours are kept.
  assert.ok(filed.content.adjudication);
  assert.ok(filed.content.analysis);

  assert.deepEqual(repository.calls.statusUpdates, [{ claimId: "CL001", status: "denied" }]);
});

test("the payer's control number is written back to the claim", async () => {
  // Without this the claim can never be corrected -- the payer reads a
  // resubmission carrying no control number as a duplicate.
  const repository = stubRepository();
  await ingestRemittance({ repository, adjustmentCodes, claimId: "CL001", remittance: DENIED_REMITTANCE });

  assert.deepEqual(repository.calls.controlNumbers, [{ claimId: "CL001", controlNumber: "2026250012345" }]);
});

test("a remittance with no control number does not write an empty one", async () => {
  const repository = stubRepository();
  await ingestRemittance({
    repository,
    adjustmentCodes,
    claimId: "CL001",
    remittance: buildEra({ payerClaimControlNumber: "" }),
  });

  assert.equal(repository.calls.controlNumbers.length, 0);
  assert.equal(repository.calls.statusUpdates.length, 1);
});

test("a claim paid to the deductible is accepted, not denied", async () => {
  const repository = stubRepository();
  const result = await ingestRemittance({
    repository,
    adjustmentCodes,
    claimId: "CL001",
    // Status code 99 is deliberately unmapped, so the claim status comes
    // entirely from the amounts -- provider paid $0, all of it patient
    // responsibility.
    remittance: buildEra({
      statusCode: "99",
      billed: "120",
      paid: "0",
      patientResponsibility: "120",
      payerClaimControlNumber: "2026250099999",
      groupCode: "PR",
      reasonCode: "1",
    }),
  });

  // The provider was paid nothing, but this is a bill to send, not a fight.
  assert.equal(result.claimStatus, "accepted");
  assert.equal(result.analysis.recommendedRoute, "bill_patient");
  assert.equal(result.analysis.money.atRisk, 0);
});

test("every adjudication status maps to one Ruby claim status", async () => {
  // A status with no mapping would silently fall through to "pending" and
  // quietly strand the claim, so the table has to stay exhaustive.
  for (const status of [
    "paid",
    "partially_paid",
    "patient_responsibility",
    "denied",
    "not_our_claim",
    "reversed",
    "forwarded",
    "predetermination",
    "unknown",
  ]) {
    assert.ok(
      ["draft", "submitted", "accepted", "denied", "pending"].includes(CLAIM_STATUS_FROM_ADJUDICATION[status]),
      `${status} has no valid claim status mapping`
    );
  }
});

test("a multi-claim document files the claim it was called for, not the first", async () => {
  // This used to take parsedClaims[0] regardless, which filed another claim's
  // verdict, ICN and amounts onto this one.
  const repository = stubRepository();
  const result = await ingestRemittance({
    repository,
    adjustmentCodes,
    claimId: "CL001",
    remittance: buildEra({ claimCount: 3, patientControlNumbers: ["CL007", "CL001", "CL009"] }),
  });

  assert.equal(result.otherClaimsInDocument, 2);
  assert.equal(repository.calls.feedback.length, 1);
  assert.equal(repository.calls.feedback[0].payerClaimControlNumber, "2026250012345-2");
});

test("a multi-claim document naming none of them is refused rather than guessed", async () => {
  const repository = stubRepository();
  await assert.rejects(
    () =>
      ingestRemittance({
        repository,
        adjustmentCodes,
        claimId: "CL001",
        remittance: buildEra({ claimCount: 3 }),
      }),
    RemittanceIngestError
  );
  assert.equal(repository.calls.feedback.length, 0);
});

test("a single-claim document is filed even when its control number does not match", async () => {
  // Claims submitted before Ruby sent its own id went out as
  // `ruby-<timestamp>`. Their remittances have to stay filable, and with one
  // claim in the document there is nothing to confuse it with.
  const repository = stubRepository();
  const result = await ingestRemittance({
    repository,
    adjustmentCodes,
    claimId: "CL001",
    remittance: buildEra({ claimCount: 1 }),
  });

  assert.equal(result.otherClaimsInDocument, 0);
  assert.equal(repository.calls.feedback.length, 1);
});

test("the raw document is kept alongside our reading of it", async () => {
  const stored = [];
  const blobStore = {
    async putBlob(key, content) {
      stored.push({ key, content });
      return `blob://${key}`;
    },
  };
  const repository = stubRepository();

  await ingestRemittance({ repository, blobStore, adjustmentCodes, claimId: "CL001", remittance: DENIED_REMITTANCE });

  assert.equal(stored.length, 1);
  assert.match(stored[0].key, /^remittance\/CL001-.*\.edi$/);
  assert.equal(repository.calls.feedback[0].storageRef, `blob://${stored[0].key}`);
  // The stored bytes are the payer's actual EDI document, not our parse of
  // it -- verbatim, not re-encoded as JSON.
  assert.equal(stored[0].content.toString(), DENIED_REMITTANCE);
  assert.match(stored[0].content.toString(), /2026250012345/);
});

test("a blob-storage failure does not lose the reading we already have", async () => {
  const blobStore = {
    async putBlob() {
      throw new Error("disk full");
    },
  };
  const repository = stubRepository();

  const result = await ingestRemittance({ repository, blobStore, adjustmentCodes, claimId: "CL001", remittance: DENIED_REMITTANCE });

  assert.equal(result.claimStatus, "denied");
  assert.equal(repository.calls.feedback[0].storageRef, null);
});

test("ingesting against a claim that doesn't exist is a 404, not a 500", async () => {
  const repository = stubRepository();
  await assert.rejects(
    () => ingestRemittance({ repository, adjustmentCodes, claimId: "CL999", remittance: DENIED_REMITTANCE }),
    (err) => err instanceof RemittanceIngestError && err.status === 404
  );
});

test("a missing remittance payload is rejected before anything is written", async () => {
  const repository = stubRepository();
  await assert.rejects(
    () => ingestRemittance({ repository, adjustmentCodes, claimId: "CL001", remittance: null }),
    RemittanceIngestError
  );
  assert.equal(repository.calls.feedback.length, 0);
  assert.equal(repository.calls.statusUpdates.length, 0);
});
