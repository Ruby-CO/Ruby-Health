import test from "node:test";
import assert from "node:assert/strict";

import { populateClaim, ClaimError } from "../src/pipeline/populateClaim.js";
import { verifyQuote, verifyNecessityQuotes, GROUNDING } from "../src/pipeline/verifyQuotes.js";

const facts = {
  chiefComplaint: "Sore throat",
  medicalNecessityLanguage: ["Symptoms have persisted for three days."],
};

// A valid profile so these tests exercise diagnosis-linkage warnings in
// isolation, not the separate NO_PROVIDER_PROFILE warning (see
// providerProfiles.test.js for that behavior).
//
// Same reasoning for linkageWarnings(): populateClaim also warns about an
// assumed date of service and a placeholder patient, which these tests do not
// exercise. Counting every warning made them fail the moment a new warning
// class was added -- assert on the codes under test instead.
const LINKAGE_CODES = new Set(["UNLINKED_SERVICE_LINE", "UNKNOWN_SUPPORTING_DIAGNOSIS"]);
const linkageWarnings = (claim) => claim.warnings.filter((w) => LINKAGE_CODES.has(w.code));

const testProviderProfile = {
  name: "Test Practice",
  npi: "1234567893",
  address: { address1: "1 Test St", city: "Testville", state: "CA", postalCode: "900010000" },
};

// A sore throat plus an unrelated immunization: the case where pointing every
// service line at the first diagnosis produces a denial.
const twoProblemCodes = [
  { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis, unspecified", supportingDiagnoses: [] },
  { code: "Z23", codeType: "ICD-10", description: "Encounter for immunization", supportingDiagnoses: [] },
  { code: "87880", codeType: "CPT", description: "Strep A rapid test", supportingDiagnoses: ["J02.9"] },
  { code: "90471", codeType: "CPT", description: "Immunization administration", supportingDiagnoses: ["Z23"] },
];

test("each service line points at the diagnosis that justifies it", () => {
  const claim = populateClaim(facts, twoProblemCodes, testProviderProfile);

  const strep = claim.serviceLines.find((l) => l.code === "87880");
  const shot = claim.serviceLines.find((l) => l.code === "90471");

  assert.equal(strep.diagnosisPointers, "A", "strep test should point at the pharyngitis");
  assert.equal(shot.diagnosisPointers, "B", "immunization admin should point at the immunization");
  assert.equal(linkageWarnings(claim).length, 0);
});

test("a service line supported by two diagnoses carries both pointers", () => {
  const claim = populateClaim(
    facts,
    [
      ...twoProblemCodes.slice(0, 2),
      { code: "99213", codeType: "CPT", description: "Office visit", supportingDiagnoses: ["J02.9", "Z23"] },
    ],
    testProviderProfile
  );
  assert.equal(claim.serviceLines[0].diagnosisPointers, "AB");
});

test("codes match regardless of formatting", () => {
  const claim = populateClaim(
    facts,
    [
      { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
      { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: [" j029 "] },
    ],
    testProviderProfile
  );
  assert.equal(claim.serviceLines[0].diagnosisPointers, "A");
});

test("a duplicated supporting diagnosis resolves to one pointer", () => {
  const claim = populateClaim(
    facts,
    [
      { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
      { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: ["J02.9", "J02.9"] },
    ],
    testProviderProfile
  );
  assert.equal(claim.serviceLines[0].diagnosisPointers, "A");
});

test("an unlinked service line is flagged rather than silently pointed at A", () => {
  const claim = populateClaim(
    facts,
    [
      { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
      { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: [] },
    ],
    testProviderProfile
  );

  assert.equal(claim.serviceLines[0].diagnosisPointers, "");
  assert.equal(linkageWarnings(claim).length, 1);
  assert.equal(linkageWarnings(claim)[0].code, "UNLINKED_SERVICE_LINE");
  assert.equal(linkageWarnings(claim)[0].line, "87880");
});

test("a supporting diagnosis that is not on the claim is flagged", () => {
  const claim = populateClaim(facts, [
    { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
    { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: ["E11.9"] },
  ]);

  assert.equal(claim.warnings.some((w) => w.code === "UNKNOWN_SUPPORTING_DIAGNOSIS"), true);
  assert.equal(claim.warnings.some((w) => w.code === "UNLINKED_SERVICE_LINE"), true);
});

test("a service line keeps every pointer the visit actually supports, past four", () => {
  const diagnoses = ["A00", "B00", "C00", "D00", "E00"].map((code) => ({
    code,
    codeType: "ICD-10",
    description: code,
    supportingDiagnoses: [],
  }));
  const claim = populateClaim(facts, [
    ...diagnoses,
    { code: "99213", codeType: "CPT", description: "Office visit", supportingDiagnoses: ["A00", "B00", "C00", "D00", "E00"] },
  ], testProviderProfile);

  assert.equal(claim.serviceLines[0].diagnosisPointers, "ABCDE");
  assert.equal(linkageWarnings(claim).length, 0);
});

test("more than twelve diagnoses is rejected instead of running past Z", () => {
  const thirteen = Array.from({ length: 13 }, (_, i) => ({
    code: `A${String(i).padStart(2, "0")}`,
    codeType: "ICD-10",
    description: "Diagnosis",
    supportingDiagnoses: [],
  }));

  assert.throws(() => populateClaim(facts, thirteen), ClaimError);
});

test("exactly twelve diagnoses is allowed and ends at pointer L", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    code: `A${String(i).padStart(2, "0")}`,
    codeType: "ICD-10",
    description: "Diagnosis",
    supportingDiagnoses: [],
  }));
  const claim = populateClaim(facts, twelve);
  assert.equal(claim.diagnoses.at(-1).pointer, "L");
});

// ---- quote grounding ----

const transcript =
  "Patient reports a sore throat that started three days ago. No cough. " +
  "Temperature is one hundred and one. I am going to run a rapid strep test today.";

test("a verbatim quote verifies", () => {
  const r = verifyQuote("I am going to run a rapid strep test today.", transcript);
  assert.equal(r.status, GROUNDING.VERIFIED);
});

test("punctuation and casing differences still verify", () => {
  const r = verifyQuote("no cough", transcript);
  assert.equal(r.status, GROUNDING.VERIFIED);
});

test("a reworded quote is marked paraphrased, not passed off as a quote", () => {
  const r = verifyQuote("Sore throat started three days ago, reports patient, with no cough.", transcript);
  assert.equal(r.status, GROUNDING.PARAPHRASED);
});

test("a statement the transcript does not support is unsupported", () => {
  const r = verifyQuote("Patient has a documented history of rheumatic fever requiring prophylaxis.", transcript);
  assert.equal(r.status, GROUNDING.UNSUPPORTED);
});

test("a short quote must match exactly rather than pass on word overlap", () => {
  const r = verifyQuote("cough test", transcript);
  assert.equal(r.status, GROUNDING.UNSUPPORTED);
});

test("grounding results line up with the quotes they describe", () => {
  const results = verifyNecessityQuotes(
    { medicalNecessityLanguage: ["No cough.", "Patient was admitted overnight for observation."] },
    transcript
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].quote, "No cough.");
  assert.equal(results[0].status, GROUNDING.VERIFIED);
  assert.equal(results[1].status, GROUNDING.UNSUPPORTED);
});

test("missing necessity language is handled without throwing", () => {
  assert.deepEqual(verifyNecessityQuotes({}, transcript), []);
});

// --- context: the claim reads the rows Ruby already holds --------------------

const oneCode = [{ code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] }];

test("the date of service comes from the encounter, not from today", () => {
  const claim = populateClaim(facts, oneCode, testProviderProfile, { dateOfService: "2026-08-04" });
  assert.equal(claim.dateOfService, "2026-08-04");
  assert.equal(claim.warnings.some((w) => w.code === "DATE_OF_SERVICE_ASSUMED"), false);
});

test("with no encounter date the claim falls back to today and says so", () => {
  const claim = populateClaim(facts, oneCode, testProviderProfile);
  assert.equal(claim.dateOfService, new Date().toISOString().slice(0, 10));
  assert.equal(claim.warnings.some((w) => w.code === "DATE_OF_SERVICE_ASSUMED"), true);
});

test("the patient name and date of birth come from the patient record", () => {
  const claim = populateClaim(facts, oneCode, testProviderProfile, {
    patient: { name: "Molly Chen (synthetic)", dateOfBirth: "1990-04-12" },
  });
  assert.equal(claim.patient.name, "Molly Chen (synthetic)");
  assert.equal(claim.patient.dob, "1990-04-12");
  assert.equal(claim.warnings.some((w) => w.code === "PLACEHOLDER_PATIENT"), false);
});

test("sex and member ID stay placeholders, without warning on every claim", () => {
  // The schema carries no coverage, so these two are invented on every claim.
  // They are marked on their own field labels in the claim form rather than
  // warned about -- a warning true of every claim is noise, and it would sit in
  // the same red box as an actual denial risk.
  const claim = populateClaim(facts, oneCode, testProviderProfile, {
    patient: { name: "Molly Chen (synthetic)", dateOfBirth: "1990-04-12" },
  });
  assert.equal(claim.patient.sex, "U");
  assert.equal(claim.patient.memberId, "SAMPLE-0001");
  // Names the regression it guards -- someone re-adding the blanket warning --
  // rather than counting, which would break on any unrelated warning class.
  assert.equal(claim.warnings.some((w) => w.code === "PLACEHOLDER_COVERAGE"), false);
});

test("a fully-specified claim carries exactly the warnings it should, and no others", () => {
  // The one place "nothing unexpected appeared" is asserted. The linkage tests
  // used to carry it as a side effect of counting every warning, which is what
  // made them fail whenever an unrelated warning class was added. Keeping it
  // here means a new warning class breaks one test with a readable set diff
  // rather than four with "2 !== 0".
  const claim = populateClaim(facts, twoProblemCodes, testProviderProfile, {
    dateOfService: "2026-08-04",
    patient: { name: "Molly Chen (synthetic)", dateOfBirth: "1990-04-12" },
  });
  assert.deepEqual(new Set(claim.warnings.map((w) => w.code)), new Set());
});

test("with no patient record every subscriber field is a flagged placeholder", () => {
  const claim = populateClaim(facts, oneCode, testProviderProfile);
  assert.equal(claim.patient.name, "Sample Patient (synthetic)");
  assert.equal(claim.warnings.some((w) => w.code === "PLACEHOLDER_PATIENT"), true);
});

test("a patient record missing a name does not blank the claim", () => {
  const claim = populateClaim(facts, oneCode, testProviderProfile, { patient: { dateOfBirth: "1990-04-12" } });
  assert.equal(claim.patient.name, "Sample Patient (synthetic)");
  assert.equal(claim.patient.dob, "1990-04-12");
});
