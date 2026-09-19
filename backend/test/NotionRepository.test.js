import test from "node:test";
import assert from "node:assert/strict";

import { NotionRepository, NotionRepositoryError } from "../src/repository/NotionRepository.js";

// A minimal in-memory stand-in for @notionhq/client, implementing just
// enough of dataSources.query / pages.create / pages.update to exercise
// NotionRepository's logic without a network call or a real integration
// token. One store per data source, one title property each.
function fakeNotionClient() {
  const stores = {
    patients: new Map(),
    cases: new Map(),
    encounters: new Map(),
    artifacts: new Map(),
    claims: new Map(),
    documents: new Map(),
    payerFeedback: new Map(),
  };
  let nextPageId = 1;

  function storeFor(dataSourceId) {
    if (dataSourceId === "ds_patients") return stores.patients;
    if (dataSourceId === "ds_cases") return stores.cases;
    if (dataSourceId === "ds_encounters") return stores.encounters;
    if (dataSourceId === "ds_artifacts") return stores.artifacts;
    if (dataSourceId === "ds_claims") return stores.claims;
    if (dataSourceId === "ds_documents") return stores.documents;
    if (dataSourceId === "ds_payer_feedback") return stores.payerFeedback;
    throw new Error(`fakeNotionClient: unknown data source '${dataSourceId}'`);
  }

  function matchesFilter(page, filter) {
    if (!filter) return true;
    if (filter.and) return filter.and.every((f) => matchesFilter(page, f));
    const value = page.properties[filter.property];
    if (filter.title) return (value?.title?.[0]?.text?.content || "") === filter.title.equals;
    if (filter.rich_text) return (value?.rich_text?.map((t) => t.text.content).join("") || "") === filter.rich_text.equals;
    if (filter.select) return (value?.select?.name || null) === filter.select.equals;
    throw new Error(`fakeNotionClient: unsupported filter ${JSON.stringify(filter)}`);
  }

  // The fake stores properties in "request" shape ({ title: [{ text: {...} }] })
  // and echoes them back reshaped into "response" shape (adding plain_text),
  // matching what the real API round-trips.
  function toResponseProperties(properties) {
    const out = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value.title) {
        out[key] = { type: "title", title: value.title.map((t) => ({ ...t, plain_text: t.text.content })) };
      } else if (value.rich_text) {
        out[key] = { type: "rich_text", rich_text: value.rich_text.map((t) => ({ ...t, plain_text: t.text.content })) };
      } else if (value.date) {
        out[key] = { type: "date", date: value.date };
      } else if (value.select) {
        out[key] = { type: "select", select: value.select };
      } else if (typeof value.number === "number") {
        out[key] = { type: "number", number: value.number };
      } else {
        throw new Error(`fakeNotionClient: unsupported property shape ${JSON.stringify(value)}`);
      }
    }
    return out;
  }

  return {
    dataSources: {
      async query({ data_source_id, filter }) {
        const store = storeFor(data_source_id);
        // The real API drops trashed pages from a query. A fake that kept
        // returning them would let a broken delete look like a working one.
        const results = [...store.values()].filter((page) => !page.in_trash && matchesFilter(page, filter));
        return { results, has_more: false, next_cursor: null };
      },
    },
    pages: {
      async create({ parent, properties }) {
        const store = storeFor(parent.data_source_id);
        // Monotonically increasing, not a fixed timestamp -- getClaimChain
        // sorts by createdAt, so distinct creation order needs to be
        // observable, the way it would be against the real API.
        const createdTime = new Date(2026, 8, 2, 0, 0, nextPageId).toISOString();
        const page = {
          id: `page_${nextPageId++}`,
          created_time: createdTime,
          properties: { ...toResponseProperties(properties), created_at: { type: "created_time", created_time: createdTime } },
        };
        store.set(page.id, page);
        return page;
      },
      async update({ page_id, properties, in_trash }) {
        for (const store of Object.values(stores)) {
          if (store.has(page_id)) {
            const page = store.get(page_id);
            if (properties) page.properties = { ...page.properties, ...toResponseProperties(properties) };
            if (in_trash !== undefined) page.in_trash = in_trash;
            return page;
          }
        }
        throw new Error(`fakeNotionClient: no page '${page_id}'`);
      },
    },
    // For tests that need to shape a stored page by hand -- e.g. a row written
    // before a property existed, which has no key for it at all.
    _stores: stores,
  };
}

function makeRepository() {
  return new NotionRepository({
    client: fakeNotionClient(),
    patientsDataSourceId: "ds_patients",
    casesDataSourceId: "ds_cases",
    encountersDataSourceId: "ds_encounters",
    artifactsDataSourceId: "ds_artifacts",
    claimsDataSourceId: "ds_claims",
    documentsDataSourceId: "ds_documents",
    payerFeedbackDataSourceId: "ds_payer_feedback",
  });
}

async function makeCase(repo, { patientName = "Molly Chen", caseTitle = "Broken left arm" } = {}) {
  const patient = await repo.createPatient({ name: patientName, dateOfBirth: "1990-04-12" });
  const encounterCase = await repo.createCase({ patientId: patient.patientId, title: caseTitle });
  return { patient, case: encounterCase };
}

// A claim needs an encounter and a claim-stage artifact to point at --
// this builds both so claim tests can start from "here's an encounter
// with a claim artifact ready" instead of repeating the setup.
async function makeEncounterWithClaimArtifact(repo) {
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });
  const artifact = await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "claim",
    content: { serviceLines: [{ code: "87880", diagnosisPointers: "A" }] },
    createdBy: "system",
  });
  return { encounter, artifact };
}

test("createPatient assigns sequential IDs starting at P001", async () => {
  const repo = makeRepository();
  const first = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });
  const second = await repo.createPatient({ name: "Sam Rivera", dateOfBirth: "1985-11-02" });

  assert.equal(first.patientId, "P001");
  assert.equal(second.patientId, "P002");
  assert.equal(first.name, "Molly Chen");
  assert.equal(first.dateOfBirth, "1990-04-12");
});

test("createPatient rejects a missing name or date of birth", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.createPatient({ dateOfBirth: "1990-04-12" }), NotionRepositoryError);
  await assert.rejects(() => repo.createPatient({ name: "Molly Chen" }), NotionRepositoryError);
});

test("createPatient stores sex and insurance status and reads them back", async () => {
  const repo = makeRepository();
  const created = await repo.createPatient({
    name: "Molly Chen",
    dateOfBirth: "1990-04-12",
    sex: "female",
    insuranceStatus: "insured",
  });
  assert.equal(created.sex, "female");
  assert.equal(created.insuranceStatus, "insured");
  const fetched = await repo.getPatient(created.patientId);
  assert.equal(fetched.sex, "female");
  assert.equal(fetched.insuranceStatus, "insured");
});

test("createPatient leaves sex and insurance status unset when not given", async () => {
  // Absent means "not recorded". The property is omitted, not written with a
  // placeholder option -- an empty select says that honestly.
  const repo = makeRepository();
  const created = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });
  assert.equal(created.sex, null);
  assert.equal(created.insuranceStatus, null);
});

test("createPatient rejects a sex or insurance status outside the vocabulary", async () => {
  // Notion would mint a new select option rather than reject it, and a typo
  // would become a permanent column value. The repository is the guard.
  const repo = makeRepository();
  await assert.rejects(
    () => repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12", sex: "F" }),
    NotionRepositoryError
  );
  await assert.rejects(
    () => repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12", insuranceStatus: "medicare" }),
    NotionRepositoryError
  );
});

test("a patient row written before sex and insurance existed still parses", async () => {
  // Rows that predate the two properties have no such keys at all -- not an
  // empty select, no key. Reading one must not throw or misbehave.
  const repo = makeRepository();
  const created = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });
  const page = [...repo.client._stores.patients.values()][0];
  delete page.properties.sex;
  delete page.properties.insurance_status;
  const fetched = await repo.getPatient(created.patientId);
  assert.equal(fetched.name, "Molly Chen");
  assert.equal(fetched.sex, null);
  assert.equal(fetched.insuranceStatus, null);
});

test("getPatient finds an existing patient and returns null for an unknown one", async () => {
  const repo = makeRepository();
  const created = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });

  assert.deepEqual(await repo.getPatient(created.patientId), created);
  assert.equal(await repo.getPatient("P999"), null);
});

test("listPatients returns every created patient", async () => {
  const repo = makeRepository();
  await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });
  await repo.createPatient({ name: "Sam Rivera", dateOfBirth: "1985-11-02" });

  const patients = await repo.listPatients();
  assert.equal(patients.length, 2);
  assert.deepEqual(
    patients.map((p) => p.name).sort(),
    ["Molly Chen", "Sam Rivera"],
  );
});

test("a patient can have two concurrent open cases", async () => {
  const repo = makeRepository();
  const patient = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });

  const ortho = await repo.createCase({ patientId: patient.patientId, title: "Broken left arm" });
  const pregnancy = await repo.createCase({ patientId: patient.patientId, title: "Pregnancy" });

  assert.equal(ortho.caseId, "C001");
  assert.equal(pregnancy.caseId, "C002");
  assert.equal(ortho.status, "open");
  assert.equal(pregnancy.status, "open");
  assert.equal(ortho.patientId, patient.patientId);

  const cases = await repo.listCasesForPatient(patient.patientId);
  assert.equal(cases.length, 2);
  assert.deepEqual(
    cases.map((c) => c.title).sort(),
    ["Broken left arm", "Pregnancy"],
  );
});

test("createCase rejects a patientId that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(
    () => repo.createCase({ patientId: "P999", title: "Broken left arm" }),
    NotionRepositoryError,
  );
});

test("closeCase sets status to closed and stamps closedAt", async () => {
  const repo = makeRepository();
  const patient = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });
  const created = await repo.createCase({ patientId: patient.patientId, title: "Broken left arm" });

  assert.equal(created.closedAt, null);

  const closed = await repo.closeCase(created.caseId);
  assert.equal(closed.status, "closed");
  assert.ok(closed.closedAt);

  const reloaded = await repo.getCase(created.caseId);
  assert.equal(reloaded.status, "closed");
});

test("closeCase rejects a caseId that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.closeCase("C999"), NotionRepositoryError);
});

test("createEncounter derives patientId from the case, defaults to draft", async () => {
  const repo = makeRepository();
  const { patient, case: c } = await makeCase(repo);

  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  assert.equal(encounter.encounterId, "E001");
  assert.equal(encounter.caseId, c.caseId);
  assert.equal(encounter.patientId, patient.patientId);
  assert.equal(encounter.status, "draft");
});

test("createEncounter rejects a caseId that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.createEncounter({ caseId: "C999", occurredAt: "2026-09-01" }), NotionRepositoryError);
});

test("listEncountersForCase returns them in chronological order", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-03" });
  await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });
  await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-02" });

  const encounters = await repo.listEncountersForCase(c.caseId);
  assert.deepEqual(
    encounters.map((e) => e.occurredAt),
    ["2026-09-01", "2026-09-02", "2026-09-03"],
  );
});

test("updateEncounterStatus changes status", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  const updated = await repo.updateEncounterStatus(encounter.encounterId, "reviewed");
  assert.equal(updated.status, "reviewed");
});

test("running the pipeline against a synthetic transcript persists four versioned artifacts under one encounter", async () => {
  // This is build-order step 2's own verification: create an encounter,
  // persist transcript -> facts -> codes -> claim as it would come out of
  // the real pipeline, and confirm all four land as separate artifact
  // versions under that one encounter.
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  const stageOutputs = {
    transcript: { cleaned: "Patient reports sore throat for three days." },
    facts: { chiefComplaint: "Sore throat", symptoms: ["sore throat"] },
    codes: [{ code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis" }],
    claim: { serviceLines: [{ code: "87880", diagnosisPointers: "A" }] },
  };

  for (const [stage, content] of Object.entries(stageOutputs)) {
    await repo.createArtifact({ encounterId: encounter.encounterId, stage, content, createdBy: "system" });
  }

  const history = await repo.getArtifactHistory(encounter.encounterId);
  assert.equal(history.length, 4);
  assert.deepEqual(
    history.map((a) => a.stage),
    ["transcript", "facts", "codes", "claim"],
  );
  for (const artifact of history) {
    assert.equal(artifact.version, 1);
    assert.equal(artifact.encounterId, encounter.encounterId);
    assert.deepEqual(artifact.content, stageOutputs[artifact.stage]);
  }
});

test("createArtifact increments version per (encounter, stage) instead of overwriting", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "facts",
    content: { chiefComplaint: "Sore throat" },
    createdBy: "system",
  });
  const editedVersion = await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "facts",
    content: { chiefComplaint: "Sore throat, worsening" },
    createdBy: "provider_edit",
  });

  assert.equal(editedVersion.version, 2);

  const latest = await repo.getLatestArtifact(encounter.encounterId, "facts");
  assert.equal(latest.version, 2);
  assert.deepEqual(latest.content, { chiefComplaint: "Sore throat, worsening" });

  const history = await repo.getArtifactHistory(encounter.encounterId);
  assert.equal(history.length, 2, "editing a stage adds a version, it does not overwrite the old one");
});

test("createArtifact content survives the round trip past Notion's 2000-char rich_text limit", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  const bigContent = { note: "x".repeat(5000) };
  const artifact = await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "transcript",
    content: bigContent,
    createdBy: "system",
  });

  assert.deepEqual(artifact.content, bigContent);
  const reloaded = await repo.getLatestArtifact(encounter.encounterId, "transcript");
  assert.deepEqual(reloaded.content, bigContent);
});

test("createArtifact rejects an encounterId that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(
    () => repo.createArtifact({ encounterId: "E999", stage: "facts", content: {}, createdBy: "system" }),
    NotionRepositoryError,
  );
});

test("createArtifact rejects an unknown stage or createdBy", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  await assert.rejects(
    () => repo.createArtifact({ encounterId: encounter.encounterId, stage: "vitals", content: {}, createdBy: "system" }),
    NotionRepositoryError,
  );
  await assert.rejects(
    () => repo.createArtifact({ encounterId: encounter.encounterId, stage: "facts", content: {}, createdBy: "provider" }),
    NotionRepositoryError,
  );
});

test("getLatestArtifact returns null when a stage has no artifacts yet", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  assert.equal(await repo.getLatestArtifact(encounter.encounterId, "claim"), null);
});

test("createClaim creates an original claim in draft status", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);

  const claim = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });

  assert.equal(claim.claimId, "CL001");
  assert.equal(claim.status, "draft");
  assert.equal(claim.claimType, "original");
  assert.equal(claim.parentClaimId, null);
  assert.equal(claim.submittedAt, null);
});

test("createClaim and createArtifact stamp the provider they were given", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);

  const stamped = await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "facts",
    content: { chiefComplaint: "sore throat" },
    createdBy: "system",
    providerId: "default",
  });
  assert.equal(stamped.providerId, "default");

  const claim = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
    providerId: "default",
  });
  assert.equal(claim.providerId, "default");
  assert.equal((await repo.getClaim(claim.claimId)).providerId, "default");
});

test("provider_id is optional, and a row written before it existed reads as null", async () => {
  // Two shapes of absence: a new row with no provider given (written as ""),
  // and an old row with no property at all. Both must read back null, and
  // neither may throw -- nothing that reads Claim or Artifact today may start
  // misbehaving on rows that predate the field.
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);

  const claim = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });
  assert.equal(claim.providerId, null);
  assert.equal(artifact.providerId, null);

  for (const page of repo.client._stores.claims.values()) delete page.properties.provider_id;
  for (const page of repo.client._stores.artifacts.values()) delete page.properties.provider_id;
  assert.equal((await repo.getClaim(claim.claimId)).providerId, null);
  assert.equal((await repo.getLatestArtifact(encounter.encounterId, "claim")).providerId, null);
});

test("createClaim rejects an encounterId, artifactId, or parentClaimId that doesn't exist", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);
  const validInput = {
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  };

  await assert.rejects(() => repo.createClaim({ ...validInput, encounterId: "E999" }), NotionRepositoryError);
  await assert.rejects(() => repo.createClaim({ ...validInput, artifactId: "A999" }), NotionRepositoryError);
  await assert.rejects(
    () => repo.createClaim({ ...validInput, claimType: "corrected", parentClaimId: "CL999" }),
    NotionRepositoryError,
  );
});

test("createClaim rejects an unknown claimType", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);

  await assert.rejects(
    () =>
      repo.createClaim({
        encounterId: encounter.encounterId,
        artifactId: artifact.artifactId,
        claimType: "resubmission",
        payerName: "Sample Payer Insurance",
        memberId: "M123456",
      }),
    NotionRepositoryError,
  );
});

test("updateClaimStatus moves a claim to submitted and stamps submittedAt", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);
  const claim = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });

  assert.equal(claim.submittedAt, null);
  const submitted = await repo.updateClaimStatus(claim.claimId, "submitted");
  assert.equal(submitted.status, "submitted");
  assert.ok(submitted.submittedAt);
});

test("updateClaimStatus rejects an unknown status", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);
  const claim = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });

  await assert.rejects(() => repo.updateClaimStatus(claim.claimId, "voided"), NotionRepositoryError);
});

async function makeDraftClaim(repo) {
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);
  const claim = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });
  return { encounter, artifact, claim };
}

test("deleteClaim removes a draft from the encounter's claims and from listAllClaims", async () => {
  const repo = makeRepository();
  const { encounter, claim } = await makeDraftClaim(repo);

  const deleted = await repo.deleteClaim(claim.claimId);
  assert.equal(deleted.claimId, claim.claimId);

  assert.equal(await repo.getClaim(claim.claimId), null);
  assert.deepEqual(await repo.listClaimsForEncounter(encounter.encounterId), []);
  assert.deepEqual(await repo.listAllClaims(), []);
});

test("deleteClaim leaves every other claim alone", async () => {
  const repo = makeRepository();
  const { encounter, artifact, claim: first } = await makeDraftClaim(repo);
  const second = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });

  await repo.deleteClaim(first.claimId);

  const left = await repo.listClaimsForEncounter(encounter.encounterId);
  assert.deepEqual(left.map((c) => c.claimId), [second.claimId]);
});

// The point of the whole feature: a claim the payer has seen is the record of
// what was billed. Every non-draft status refuses, not just "submitted".
for (const status of ["submitted", "accepted", "rejected", "denied", "pending"]) {
  test(`deleteClaim refuses a ${status} claim`, async () => {
    const repo = makeRepository();
    const { claim } = await makeDraftClaim(repo);
    await repo.updateClaimStatus(claim.claimId, status);

    await assert.rejects(() => repo.deleteClaim(claim.claimId), NotionRepositoryError);
    assert.ok(await repo.getClaim(claim.claimId));
  });
}

test("deleteClaim refuses a claim another claim was filed against", async () => {
  const repo = makeRepository();
  const { encounter, artifact, claim: original } = await makeDraftClaim(repo);
  await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "corrected",
    parentClaimId: original.claimId,
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });

  // A draft parent is only reachable in an odd order of operations, but an
  // orphaned correction is worse than a draft that sticks around.
  await assert.rejects(() => repo.deleteClaim(original.claimId), NotionRepositoryError);
  assert.ok(await repo.getClaim(original.claimId));
});

test("deleteClaim rejects an unknown claim id", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.deleteClaim("CL999"), NotionRepositoryError);
});

test("getClaimChain returns the original plus a corrected claim pointing at it, oldest first", async () => {
  // Build-order step 3's own verification: create an original claim, then
  // a corrected claim pointing at it.
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);

  const original = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });
  await repo.updateClaimStatus(original.claimId, "denied");

  const corrected = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "corrected",
    parentClaimId: original.claimId,
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });

  const chainFromOriginal = await repo.getClaimChain(original.claimId);
  const chainFromCorrected = await repo.getClaimChain(corrected.claimId);

  for (const chain of [chainFromOriginal, chainFromCorrected]) {
    assert.equal(chain.length, 2);
    assert.equal(chain[0].claimId, original.claimId);
    assert.equal(chain[0].parentClaimId, null);
    assert.equal(chain[1].claimId, corrected.claimId);
    assert.equal(chain[1].parentClaimId, original.claimId);
  }
});

test("getClaimChain includes a secondary claim as a sibling of a corrected claim", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);

  const original = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Primary Payer",
    memberId: "M123456",
  });
  const corrected = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "corrected",
    parentClaimId: original.claimId,
    payerName: "Primary Payer",
    memberId: "M123456",
  });
  const secondary = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "secondary",
    parentClaimId: original.claimId,
    payerName: "Secondary Payer",
    memberId: "M654321",
  });

  const chain = await repo.getClaimChain(secondary.claimId);
  assert.deepEqual(
    chain.map((c) => c.claimId),
    [original.claimId, corrected.claimId, secondary.claimId],
  );
});

test("getClaimChain rejects a claimId that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.getClaimChain("CL999"), NotionRepositoryError);
});

test("listClaimsForEncounter returns every claim on an encounter, oldest first", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);

  const original = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });
  const corrected = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "corrected",
    parentClaimId: original.claimId,
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });

  const claims = await repo.listClaimsForEncounter(encounter.encounterId);
  assert.deepEqual(
    claims.map((c) => c.claimId),
    [original.claimId, corrected.claimId],
  );
});

test("listClaimsForEncounter returns an empty array for an encounter with no claims", async () => {
  const repo = makeRepository();
  const { encounter } = await makeEncounterWithClaimArtifact(repo);
  assert.deepEqual(await repo.listClaimsForEncounter(encounter.encounterId), []);
});

// A claim needs to exist before any payer feedback can attach to it.
async function makeSubmittedClaim(repo) {
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);
  const claim = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M123456",
  });
  await repo.updateClaimStatus(claim.claimId, "submitted");
  return { encounter, artifact, claim };
}

test("a new claim has no payer control number until the payer sends one", async () => {
  const repo = makeRepository();
  const { claim } = await makeSubmittedClaim(repo);
  assert.equal(claim.payerClaimControlNumber, null);

  const updated = await repo.setPayerClaimControlNumber(claim.claimId, "2026250012345");
  assert.equal(updated.payerClaimControlNumber, "2026250012345");
  // And it survives a read back -- this is the field a corrected claim
  // cannot be filed without.
  assert.equal((await repo.getClaim(claim.claimId)).payerClaimControlNumber, "2026250012345");
});

test("setPayerClaimControlNumber rejects a claim that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.setPayerClaimControlNumber("CL999", "123"), NotionRepositoryError);
});

test("createPayerFeedback stores a remittance against its claim", async () => {
  const repo = makeRepository();
  const { claim } = await makeSubmittedClaim(repo);

  const feedback = await repo.createPayerFeedback({
    claimId: claim.claimId,
    feedbackType: "remittance",
    receivedAt: "2026-09-08",
    payerClaimControlNumber: "2026250012345",
    claimStatus: "denied",
    recommendedRoute: "appeal",
    amountAtRisk: 150,
    storageRef: "blob://synthetic-835-001",
    content: { status: "denied", findings: [{ reasonCode: "50", amount: 150 }] },
  });

  assert.equal(feedback.feedbackId, "PF001");
  assert.equal(feedback.claimId, claim.claimId);
  assert.equal(feedback.feedbackType, "remittance");
  assert.equal(feedback.claimStatus, "denied");
  assert.equal(feedback.recommendedRoute, "appeal");
  assert.equal(feedback.amountAtRisk, 150);
  assert.equal(feedback.storageRef, "blob://synthetic-835-001");
  assert.equal(feedback.content.findings[0].reasonCode, "50");

  assert.equal((await repo.getPayerFeedback("PF001")).claimId, claim.claimId);
});

test("an acknowledgment carries no verdict or route rather than a guessed one", async () => {
  const repo = makeRepository();
  const { claim } = await makeSubmittedClaim(repo);

  const ack = await repo.createPayerFeedback({
    claimId: claim.claimId,
    feedbackType: "acknowledgment",
    receivedAt: "2026-09-02",
    content: { accepted: true },
  });

  assert.equal(ack.feedbackType, "acknowledgment");
  assert.equal(ack.claimStatus, null);
  assert.equal(ack.recommendedRoute, null);
  assert.equal(ack.amountAtRisk, null);
});

test("createPayerFeedback rejects an unknown type or a missing claim", async () => {
  const repo = makeRepository();
  const { claim } = await makeSubmittedClaim(repo);

  await assert.rejects(
    () => repo.createPayerFeedback({ claimId: claim.claimId, feedbackType: "telepathy", content: {} }),
    NotionRepositoryError
  );
  await assert.rejects(
    () => repo.createPayerFeedback({ claimId: "CL999", feedbackType: "remittance", content: {} }),
    NotionRepositoryError
  );
});

test("listPayerFeedbackForClaim returns every document for that claim, oldest first", async () => {
  const repo = makeRepository();
  const { claim } = await makeSubmittedClaim(repo);

  const ack = await repo.createPayerFeedback({
    claimId: claim.claimId,
    feedbackType: "acknowledgment",
    receivedAt: "2026-09-02",
    content: { accepted: true },
  });
  const remit = await repo.createPayerFeedback({
    claimId: claim.claimId,
    feedbackType: "remittance",
    receivedAt: "2026-09-08",
    content: { status: "denied" },
  });

  const all = await repo.listPayerFeedbackForClaim(claim.claimId);
  assert.deepEqual(
    all.map((f) => f.feedbackId),
    [ack.feedbackId, remit.feedbackId]
  );
  assert.deepEqual(await repo.listPayerFeedbackForClaim("CL999"), []);
});

test("payer-feedback methods fail with a clear config error when the data source is unset", async () => {
  // The env var arrived after the other six were already deployed. An
  // unconfigured deploy has to keep working, with only these methods
  // complaining -- not lose persistence entirely.
  const repo = new NotionRepository({
    client: fakeNotionClient(),
    patientsDataSourceId: "ds_patients",
    casesDataSourceId: "ds_cases",
    claimsDataSourceId: "ds_claims",
  });

  await assert.rejects(
    () => repo.createPayerFeedback({ claimId: "CL001", feedbackType: "remittance", content: {} }),
    /payerFeedbackDataSourceId/
  );
  await assert.rejects(() => repo.listPayerFeedbackForClaim("CL001"), /payerFeedbackDataSourceId/);
});

test("createDocument works with and without a caseId, defaults extractionStatus to none", async () => {
  const repo = makeRepository();
  const { patient, case: c } = await makeCase(repo);

  const caseSpecific = await repo.createDocument({
    patientId: patient.patientId,
    caseId: c.caseId,
    source: "upload",
    documentDate: "2026-08-15",
    storageRef: "documents/D001/original.pdf",
  });
  const patientLevel = await repo.createDocument({
    patientId: patient.patientId,
    source: "fax",
    documentDate: "2026-08-16",
    storageRef: "documents/D002/original.pdf",
  });

  assert.equal(caseSpecific.documentId, "D001");
  assert.equal(caseSpecific.caseId, c.caseId);
  assert.equal(caseSpecific.extractionStatus, "none");

  assert.equal(patientLevel.documentId, "D002");
  assert.equal(patientLevel.caseId, null);
});

test("createDocument rejects an unknown patientId, caseId, or source", async () => {
  const repo = makeRepository();
  const { patient, case: c } = await makeCase(repo);
  const validInput = {
    patientId: patient.patientId,
    source: "upload",
    documentDate: "2026-08-15",
    storageRef: "documents/D001/original.pdf",
  };

  await assert.rejects(() => repo.createDocument({ ...validInput, patientId: "P999" }), NotionRepositoryError);
  await assert.rejects(() => repo.createDocument({ ...validInput, caseId: "C999" }), NotionRepositoryError);
  await assert.rejects(() => repo.createDocument({ ...validInput, source: "email" }), NotionRepositoryError);
});

test("getDocument and listDocumentsForPatient read documents back", async () => {
  const repo = makeRepository();
  const { patient } = await makeCase(repo);
  await repo.createDocument({
    patientId: patient.patientId,
    source: "upload",
    documentDate: "2026-08-15",
    storageRef: "documents/D001/original.pdf",
  });
  await repo.createDocument({
    patientId: patient.patientId,
    source: "ehr_sync",
    documentDate: "2026-08-16",
    storageRef: "documents/D002/original.pdf",
  });

  const documents = await repo.listDocumentsForPatient(patient.patientId);
  assert.equal(documents.length, 2);

  const first = await repo.getDocument("D001");
  assert.equal(first.storageRef, "documents/D001/original.pdf");
  assert.equal(first.source, "upload");

  assert.equal(await repo.getDocument("D999"), null);
});

// --- updateClaimArtifact: one draft per visit, not one per populate ---------

test("updateClaimArtifact repoints a draft at a newer artifact", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);
  const claim = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer",
    memberId: "SAMPLE-0001",
  });

  const newer = await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "claim",
    content: { serviceLines: [{ code: "99213", diagnosisPointers: "A" }] },
    createdBy: "system",
  });

  const updated = await repo.updateClaimArtifact(claim.claimId, newer.artifactId);
  assert.equal(updated.artifactId, newer.artifactId);
  assert.equal(updated.claimId, claim.claimId);

  // The point of the fix: still one claim on the encounter, not two.
  const claims = await repo.listClaimsForEncounter(encounter.encounterId);
  assert.equal(claims.length, 1);
});

for (const status of ["submitted", "accepted", "denied"]) {
  test(`updateClaimArtifact refuses a ${status} claim`, async () => {
    const repo = makeRepository();
    const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);
    const claim = await repo.createClaim({
      encounterId: encounter.encounterId,
      artifactId: artifact.artifactId,
      claimType: "original",
      payerName: "Sample Payer",
      memberId: "SAMPLE-0001",
    });
    await repo.updateClaimStatus(claim.claimId, status);

    const newer = await repo.createArtifact({
      encounterId: encounter.encounterId,
      stage: "claim",
      content: { serviceLines: [] },
      createdBy: "system",
    });
    await assert.rejects(() => repo.updateClaimArtifact(claim.claimId, newer.artifactId), NotionRepositoryError);
  });
}

test("updateClaimArtifact refuses an artifact from another encounter", async () => {
  // The artifact pointer is what makes a claim resolve to the record it was
  // built from. Pointing it at another visit would make the claim cite someone
  // else's encounter, and nothing downstream would notice.
  const repo = makeRepository();
  const mine = await makeEncounterWithClaimArtifact(repo);
  const theirs = await makeEncounterWithClaimArtifact(repo);
  const claim = await repo.createClaim({
    encounterId: mine.encounter.encounterId,
    artifactId: mine.artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer",
    memberId: "SAMPLE-0001",
  });

  await assert.rejects(
    () => repo.updateClaimArtifact(claim.claimId, theirs.artifact.artifactId),
    NotionRepositoryError
  );
});

test("updateClaimArtifact refuses an artifact that is not a claim", async () => {
  const repo = makeRepository();
  const { encounter, artifact } = await makeEncounterWithClaimArtifact(repo);
  const claim = await repo.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer",
    memberId: "SAMPLE-0001",
  });

  const facts = await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "facts",
    content: { chiefComplaint: "Sore throat" },
    createdBy: "system",
  });
  await assert.rejects(() => repo.updateClaimArtifact(claim.claimId, facts.artifactId), NotionRepositoryError);
});

test("updateClaimArtifact rejects an unknown claim id", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.updateClaimArtifact("CL999", "A001"), NotionRepositoryError);
});
