import test from "node:test";
import assert from "node:assert/strict";

import { Repository, BlobStore, NotImplementedError } from "../src/repository/Repository.js";

test("every Repository method throws NotImplementedError until a subclass overrides it", async () => {
  const repo = new Repository();
  const calls = [
    () => repo.createPatient({}),
    () => repo.getPatient("P001"),
    () => repo.listPatients(),
    () => repo.createCase({}),
    () => repo.getCase("C001"),
    () => repo.listCasesForPatient("P001"),
    () => repo.closeCase("C001"),
    () => repo.createEncounter({}),
    () => repo.getEncounter("E001"),
    () => repo.listEncountersForCase("C001"),
    () => repo.updateEncounterStatus("E001", "reviewed"),
    () => repo.createArtifact({}),
    () => repo.getArtifactHistory("E001"),
    () => repo.getLatestArtifact("E001", "facts"),
    () => repo.createClaim({}),
    () => repo.getClaim("CL001"),
    () => repo.updateClaimStatus("CL001", "submitted"),
    () => repo.getClaimChain("CL001"),
    () => repo.deleteClaim("CL001"),
    () => repo.listClaimsForEncounter("E001"),
    () => repo.setPayerClaimControlNumber("CL001", "123"),
    () => repo.createPayerFeedback({}),
    () => repo.getPayerFeedback("PF001"),
    () => repo.listPayerFeedbackForClaim("CL001"),
    () => repo.createDocument({}),
    () => repo.getDocument("D001"),
    () => repo.listDocumentsForPatient("P001"),
  ];

  for (const call of calls) {
    await assert.rejects(call, NotImplementedError);
  }
});

test("BlobStore methods throw NotImplementedError until a subclass overrides them", async () => {
  const store = new BlobStore();
  await assert.rejects(() => store.putBlob("key", Buffer.from("x")), NotImplementedError);
  await assert.rejects(() => store.getBlob("ref"), NotImplementedError);
});
