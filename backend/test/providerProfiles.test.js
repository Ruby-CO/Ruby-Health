import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the store at a throwaway temp file BEFORE importing the module, since
// it reads process.env.PROVIDER_PROFILES_PATH once at module load time.
const tmpDir = mkdtempSync(path.join(tmpdir(), "ruby-provider-profiles-"));
process.env.PROVIDER_PROFILES_PATH = path.join(tmpDir, "provider-profiles.json");

const { getProviderProfile, upsertProviderProfile, listProviderProfiles, ProviderProfileError, DEFAULT_PROVIDER_ID } =
  await import("../src/providerProfiles.js");
const { populateClaim } = await import("../src/pipeline/populateClaim.js");

test.after(() => rmSync(tmpDir, { recursive: true, force: true }));

const facts = { chiefComplaint: "Sore throat", medicalNecessityLanguage: [] };
const codes = [
  { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
  { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: ["J02.9"] },
];

test("no profile configured yet returns null, not a fake profile", () => {
  assert.equal(getProviderProfile("nobody-yet"), null);
});

test("rejects a profile missing a required field", () => {
  assert.throws(() => upsertProviderProfile(DEFAULT_PROVIDER_ID, { name: "Dr. Ruby" }), ProviderProfileError);
});

test("rejects an NPI that isn't exactly 10 digits", () => {
  assert.throws(
    () => upsertProviderProfile(DEFAULT_PROVIDER_ID, { name: "Dr. Ruby", npi: "12345" }),
    ProviderProfileError
  );
});

test("a valid profile saves and can be read back", () => {
  const profile = {
    name: "Ruby Family Medicine",
    npi: "1234567893",
    ein: "987654321",
    taxonomyCode: "207Q00000X",
    address: { address1: "500 Health Way", city: "Springfield", state: "IL", postalCode: "627010000" },
  };
  upsertProviderProfile(DEFAULT_PROVIDER_ID, profile);
  assert.deepEqual(getProviderProfile(DEFAULT_PROVIDER_ID), profile);
  assert.ok(listProviderProfiles().includes(DEFAULT_PROVIDER_ID));
});

test("populateClaim carries a NO_PROVIDER_PROFILE warning when none is passed", () => {
  const claim = populateClaim(facts, codes, null);
  assert.ok(claim.warnings.some((w) => w.code === "NO_PROVIDER_PROFILE"));
  assert.equal(claim.provider.npi, "1999999984");
});

test("populateClaim uses a real provider profile when one is passed, with no warning", () => {
  const profile = {
    name: "Ruby Family Medicine",
    npi: "1234567893",
    address: { address1: "500 Health Way", city: "Springfield", state: "IL", postalCode: "627010000" },
  };
  const claim = populateClaim(facts, codes, profile);
  assert.equal(claim.provider.npi, "1234567893");
  assert.equal(claim.provider.name, "Ruby Family Medicine");
  assert.ok(!claim.warnings.some((w) => w.code === "NO_PROVIDER_PROFILE"));
});

test("organization saves alongside name and reads back", () => {
  const profile = {
    name: "Dana Whitfield, MD",
    organization: "Ruby Family Medicine",
    npi: "1234567893",
    address: { address1: "500 Health Way", city: "Springfield", state: "IL", postalCode: "627010000" },
  };
  upsertProviderProfile("split-name", profile);
  assert.deepEqual(getProviderProfile("split-name"), profile);
});

test("rejects a tax ID that isn't exactly 9 digits", () => {
  const base = { name: "Dr. Ruby", npi: "1234567893" };
  // The hyphenated form is how a human writes it and how a payer rejects it.
  assert.throws(() => upsertProviderProfile("bad-ein", { ...base, ein: "46-2871953" }), ProviderProfileError);
  assert.throws(() => upsertProviderProfile("bad-ein", { ...base, ein: "12345" }), ProviderProfileError);
});

test("a tax ID is optional -- omitting or clearing it still saves", () => {
  const base = { name: "Dr. Ruby", npi: "1234567893" };
  assert.doesNotThrow(() => upsertProviderProfile("no-ein", base));
  assert.doesNotThrow(() => upsertProviderProfile("blank-ein", { ...base, ein: "" }));
});
