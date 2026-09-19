// The persistence interface for everything Ruby remembers: patients, their
// episodes of care, the visits within each, the versioned pipeline output
// for each visit, and the claims produced from it.
//
// Application code (server.js, the pipeline) must depend only on this
// shape -- never on NotionRepository directly, never on a Notion client,
// never on a Notion page ID. That boundary is the whole point: the demo
// runs on Notion because it holds no real patient data and needs no BAA;
// production swaps in a Postgres-backed implementation of the same
// interface without touching a call site. See the "V2 ruby MVP -
// relational database" handoff doc for the full constraint.
//
// Every method here throws NotImplementedError by default. A concrete
// repository overrides only the methods it actually backs -- the base
// class exists so the full shape is visible in one place before any
// implementation exists, and so an unimplemented method fails loudly
// instead of silently returning undefined.

export class NotImplementedError extends Error {
  constructor(methodName) {
    super(`${methodName} is not implemented on this repository.`);
    this.name = "NotImplementedError";
  }
}

export class Repository {
  // --- Patient ---------------------------------------------------------

  /** @param {{ name: string, dateOfBirth: string, sex?: string, insuranceStatus?: string }} input
   *    `sex` is one of male | female | unknown and `insuranceStatus` one of
   *    self_pay | insured | pending. Both optional; omitted means not recorded.
   *  @returns {Promise<object>} the created Patient */
  async createPatient(_input) {
    throw new NotImplementedError("createPatient");
  }

  /** @returns {Promise<object|null>} the Patient, or null if none exists */
  async getPatient(_patientId) {
    throw new NotImplementedError("getPatient");
  }

  /** @returns {Promise<object[]>} every Patient */
  async listPatients() {
    throw new NotImplementedError("listPatients");
  }

  // --- Case --------------------------------------------------------------

  /** @param {{ patientId: string, title: string }} input
   *  @returns {Promise<object>} the created Case, status "open" */
  async createCase(_input) {
    throw new NotImplementedError("createCase");
  }

  /** @returns {Promise<object|null>} the Case, or null if none exists */
  async getCase(_caseId) {
    throw new NotImplementedError("getCase");
  }

  /** @returns {Promise<object[]>} every Case for a patient, open and closed */
  async listCasesForPatient(_patientId) {
    throw new NotImplementedError("listCasesForPatient");
  }

  /** @returns {Promise<object>} the Case, now closed */
  async closeCase(_caseId) {
    throw new NotImplementedError("closeCase");
  }

  // --- Encounter -----------------------------------------------------------

  /** @param {{ caseId: string, occurredAt: string }} input -- patientId is
   *  not accepted here even though Encounter carries it denormalized; it's
   *  looked up from the case instead of trusted from the caller, so the two
   *  can't drift apart.
   *  @returns {Promise<object>} the created Encounter, status "draft" */
  async createEncounter(_input) {
    throw new NotImplementedError("createEncounter");
  }

  /** @returns {Promise<object|null>} the Encounter, or null if none exists */
  async getEncounter(_encounterId) {
    throw new NotImplementedError("getEncounter");
  }

  /** @returns {Promise<object[]>} every Encounter for a case, in chronological order */
  async listEncountersForCase(_caseId) {
    throw new NotImplementedError("listEncountersForCase");
  }

  /** @returns {Promise<object>} the Encounter with its status field updated */
  async updateEncounterStatus(_encounterId, _status) {
    throw new NotImplementedError("updateEncounterStatus");
  }

  // --- Artifact (versioned pipeline stage output) ---------------------------

  /** @param {{ encounterId: string, stage: string, content: object, createdBy: string }} input
   *  @returns {Promise<object>} the created Artifact, version auto-incremented
   *  for this (encounterId, stage) pair */
  async createArtifact(_input) {
    throw new NotImplementedError("createArtifact");
  }

  /** @returns {Promise<object[]>} every version of every stage for an encounter,
   *  newest first within each stage */
  async getArtifactHistory(_encounterId) {
    throw new NotImplementedError("getArtifactHistory");
  }

  /** @returns {Promise<object|null>} the latest Artifact for (encounterId, stage) */
  async getLatestArtifact(_encounterId, _stage) {
    throw new NotImplementedError("getLatestArtifact");
  }

  // --- Claim -----------------------------------------------------------------

  /** @param {{ encounterId: string, artifactId: string, claimType: string,
   *  parentClaimId?: string, payerName: string, memberId: string }} input
   *  @returns {Promise<object>} the created Claim, status "draft" */
  async createClaim(_input) {
    throw new NotImplementedError("createClaim");
  }

  /** @returns {Promise<object|null>} the Claim, or null if none exists */
  async getClaim(_claimId) {
    throw new NotImplementedError("getClaim");
  }

  /** @returns {Promise<object>} the Claim with its status (and submittedAt, if
   *  moving to "submitted") updated */
  async updateClaimStatus(_claimId, _status) {
    throw new NotImplementedError("updateClaimStatus");
  }

  /** Repoints a draft claim at a newer artifact, for when the claim is
   *  populated again from the same encounter. Only a `draft` moves: once the
   *  payer has seen a claim, the artifact it points at is the record of what
   *  was billed, and repointing it would rewrite that history. The artifact
   *  must belong to the same encounter as the claim.
   *  @returns {Promise<object>} the Claim, pointing at the new artifact */
  async updateClaimArtifact(_claimId, _artifactId) {
    throw new NotImplementedError("updateClaimArtifact");
  }

  /** @returns {Promise<object[]>} every Claim attached to an encounter
   *  (original, corrected, secondary alike), oldest first */
  async listClaimsForEncounter(_encounterId) {
    throw new NotImplementedError("listClaimsForEncounter");
  }

  /** @returns {Promise<object[]>} every Claim in the workspace, newest first.
   *  Separate from listClaimsForEncounter because History buckets claims
   *  across every patient and should not walk the tree to do it. */
  async listAllClaims() {
    throw new NotImplementedError("listAllClaims");
  }

  /** Throws away a claim that was drafted but never filed. Only a `draft` is
   *  deletable: once a payer has seen a claim it is the billing record, and
   *  the record of what was billed is not ours to erase. A claim another
   *  claim was chained to is kept for the same reason -- deleting it would
   *  orphan the correction that points at it.
   *  @returns {Promise<object>} the deleted Claim, as it was */
  async deleteClaim(_claimId) {
    throw new NotImplementedError("deleteClaim");
  }

  /** Records the payer's own identifier for a claim (ICN/DCN), which arrives
   *  on the 277CA or 835 rather than at submission time. A corrected claim
   *  cannot be filed without it -- the payer reads a resubmission carrying no
   *  control number as a duplicate and denies it.
   *  @returns {Promise<object>} the Claim, with the control number set */
  async setPayerClaimControlNumber(_claimId, _controlNumber) {
    throw new NotImplementedError("setPayerClaimControlNumber");
  }

  // --- PayerFeedback (what came back after the claim was submitted) --------

  /** @param {{ claimId: string, feedbackType: string, receivedAt: string,
   *  payerClaimControlNumber?: string, claimStatus?: string,
   *  recommendedRoute?: string, amountAtRisk?: number, storageRef?: string,
   *  content: object }} input
   *  @returns {Promise<object>} the created PayerFeedback */
  async createPayerFeedback(_input) {
    throw new NotImplementedError("createPayerFeedback");
  }

  /** @returns {Promise<object|null>} the PayerFeedback, or null if none exists */
  async getPayerFeedback(_feedbackId) {
    throw new NotImplementedError("getPayerFeedback");
  }

  /** @returns {Promise<object[]>} every payer document received for a claim,
   *  oldest first */
  async listPayerFeedbackForClaim(_claimId) {
    throw new NotImplementedError("listPayerFeedbackForClaim");
  }

  /** @returns {Promise<object[]>} the original claim plus every claim chained
   *  to it via parentClaimId, oldest first */
  async getClaimChain(_claimId) {
    throw new NotImplementedError("getClaimChain");
  }

  // --- Document (schema slot -- no upload or extraction UI in this chunk) ----

  /** @param {{ patientId: string, caseId?: string, source: string,
   *  documentDate: string, storageRef: string }} input
   *  @returns {Promise<object>} the created Document, extractionStatus "none" */
  async createDocument(_input) {
    throw new NotImplementedError("createDocument");
  }

  /** @returns {Promise<object|null>} the Document, or null if none exists */
  async getDocument(_documentId) {
    throw new NotImplementedError("getDocument");
  }

  /** @returns {Promise<object[]>} every Document for a patient */
  async listDocumentsForPatient(_patientId) {
    throw new NotImplementedError("listDocumentsForPatient");
  }
}

// Blob storage is a separate small interface, not part of Repository:
// Documents are files, and files don't belong in Notion (or in Postgres
// rows) regardless of which Repository implementation is active. A
// Document row's storageRef points at whatever this returns.
export class BlobStore {
  /** @returns {Promise<string>} a storageRef that getBlob can resolve later */
  async putBlob(_key, _content) {
    throw new NotImplementedError("putBlob");
  }

  /** @returns {Promise<Buffer>} the blob's raw content */
  async getBlob(_storageRef) {
    throw new NotImplementedError("getBlob");
  }
}
