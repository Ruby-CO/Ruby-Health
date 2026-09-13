import test from "node:test";
import assert from "node:assert/strict";

import { populateClaim } from "../src/pipeline/populateClaim.js";
import { buildStediClaim, StediMappingError, STEDI_TEST_PAYER_ID } from "../src/pipeline/buildStediClaim.js";

const facts = { chiefComplaint: "Sore throat", medicalNecessityLanguage: [] };

const testProviderProfile = {
  name: "Test Practice",
  npi: "1234567893",
  address: { address1: "1 Test St", city: "Testville", state: "CA", postalCode: "900010000" },
};

const codes = [
  { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis, unspecified", supportingDiagnoses: [] },
  { code: "Z23", codeType: "ICD-10", description: "Encounter for immunization", supportingDiagnoses: [] },
  { code: "87880", codeType: "CPT", description: "Strep A rapid test", supportingDiagnoses: ["J02.9"] },
  { code: "90471", codeType: "CPT", description: "Immunization administration", supportingDiagnoses: ["Z23"] },
];

test("defaults to Stedi's Test Payer when no payer is configured", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  assert.equal(stediClaim.tradingPartnerServiceId, STEDI_TEST_PAYER_ID);
  assert.equal(stediClaim.usageIndicator, "T");
});

test("ICD-10 decimal points are stripped for Stedi", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  const principal = stediClaim.claimInformation.healthCareCodeInformation[0];
  assert.equal(principal.diagnosisCode, "J029");
  assert.equal(principal.diagnosisTypeCode, "ABK");
});

test("only the first diagnosis is marked principal (ABK); rest are ABF", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  const types = stediClaim.claimInformation.healthCareCodeInformation.map((d) => d.diagnosisTypeCode);
  assert.deepEqual(types, ["ABK", "ABF"]);
});

test("letter pointers resolve to 1-based integer pointers Stedi expects", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  const strep = stediClaim.claimInformation.serviceLines.find(
    (l) => l.professionalService.procedureCode === "87880"
  );
  const shot = stediClaim.claimInformation.serviceLines.find(
    (l) => l.professionalService.procedureCode === "90471"
  );
  assert.deepEqual(strep.professionalService.compositeDiagnosisCodePointers.diagnosisCodePointers, ["1"]);
  assert.deepEqual(shot.professionalService.compositeDiagnosisCodePointers.diagnosisCodePointers, ["2"]);
});

test("every service line carries a serviceDate -- Stedi rejects lines missing one", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  for (const line of stediClaim.claimInformation.serviceLines) {
    assert.match(line.serviceDate, /^\d{8}$/);
    assert.equal(line.professionalService.serviceDate, undefined); // Stedi rejects it here as an unknown field
  }
});

test("serviceDate is capped at yesterday (UTC), never claim.dateOfService's default of today", () => {
  // Stedi validates service date against an internal transaction date computed
  // in a timezone we don't control -- "today" in UTC can read as "tomorrow" to
  // Stedi near midnight UTC. populateClaim defaults dateOfService to today, so
  // this is the realistic case, not an edge case.
  const claim = populateClaim(facts, codes);
  assert.equal(claim.dateOfService, new Date().toISOString().slice(0, 10)); // sanity: still today
  const stediClaim = buildStediClaim(claim);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  for (const line of stediClaim.claimInformation.serviceLines) {
    assert.equal(line.serviceDate, yesterday);
  }
});

test("a genuinely past dateOfService is passed through, not overridden", () => {
  const claim = populateClaim(facts, codes);
  claim.dateOfService = "2020-01-15"; // clearly not today, no capping needed
  const stediClaim = buildStediClaim(claim);
  assert.equal(stediClaim.claimInformation.serviceLines[0].serviceDate, "20200115");
});

test("a service line description over 80 characters is truncated for Stedi", () => {
  const longDescription = "A".repeat(117); // the exact length that triggered Stedi's real rejection
  const claim = populateClaim(facts, [
    { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
    { code: "87880", codeType: "CPT", description: longDescription, supportingDiagnoses: ["J02.9"] },
  ]);
  const stediClaim = buildStediClaim(claim);
  const description = stediClaim.claimInformation.serviceLines[0].professionalService.description;
  assert.equal(description.length, 80);
  assert.equal(description, longDescription.slice(0, 80));
});

test("claimInformation carries a signatureIndicator -- Stedi requires one", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  assert.equal(stediClaim.claimInformation.signatureIndicator, "Y");
});

test("an unlinked service line falls back to the principal diagnosis so it still submits", () => {
  const claim = populateClaim(
    facts,
    [
      { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
      { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: [] },
    ],
    testProviderProfile
  );
  // populateClaim already flagged this. Count only the linkage warning -- the
  // placeholder-patient and assumed-date warnings are not what this asserts.
  assert.equal(claim.warnings.filter((w) => w.code === "UNLINKED_SERVICE_LINE").length, 1);

  const stediClaim = buildStediClaim(claim);
  const line = stediClaim.claimInformation.serviceLines[0];
  assert.deepEqual(line.professionalService.compositeDiagnosisCodePointers.diagnosisCodePointers, ["1"]);
});

test("claim charge amount is the per-line rate times service line count", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim, { chargeAmountPerLine: 50 });
  assert.equal(stediClaim.claimInformation.claimChargeAmount, "100.00"); // 2 CPT lines * $50
});

test("defaults to claim frequency code 1 (original) with no original reference number", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  assert.equal(stediClaim.claimInformation.claimFrequencyCode, "1");
  assert.equal("originalReferenceNumber" in stediClaim.claimInformation, false);
});

test("a corrected resubmission carries frequency code 7 and the payer's control number", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim, {
    claimFrequencyCode: "7",
    originalReferenceNumber: "2026250012345",
  });
  assert.equal(stediClaim.claimInformation.claimFrequencyCode, "7");
  assert.equal(stediClaim.claimInformation.originalReferenceNumber, "2026250012345");
});

test("rejects a claim with no diagnoses", () => {
  assert.throws(() => buildStediClaim({ diagnoses: [], serviceLines: [{ code: "1" }] }), StediMappingError);
});

test("rejects a claim with no service lines", () => {
  assert.throws(
    () => buildStediClaim({ diagnoses: [{ pointer: "A", code: "J02.9" }], serviceLines: [] }),
    StediMappingError
  );
});

test("a claim's own id goes out as the payer's claim control number", () => {
  // Without this the claim went out as `ruby-<timestamp>`, and the number the
  // payer echoes back on the remittance matched nothing Ruby had stored.
  const claim = populateClaim(facts, codes, testProviderProfile);
  claim.claimId = "CL014";
  const stediClaim = buildStediClaim(claim);
  assert.equal(stediClaim.claimInformation.patientControlNumber, "CL014");
});

test("the billing provider the payer sees is the organization, not the clinician", () => {
  const claim = populateClaim(facts, codes, {
    ...testProviderProfile,
    name: "Dana Whitfield, MD",
    organization: "Ruby Family Medicine",
  });
  const stediClaim = buildStediClaim(claim);
  assert.equal(stediClaim.providers[0].organizationName, "Ruby Family Medicine");
});

test("a profile saved before organization existed still bills under its name", () => {
  // `name` and `organization` used to be one field. Those stored profiles carry
  // the practice in `name`, and must keep billing under it rather than falling
  // through to the placeholder.
  const claim = populateClaim(facts, codes, testProviderProfile);
  const stediClaim = buildStediClaim(claim);
  assert.equal(stediClaim.providers[0].organizationName, "Test Practice");
});
