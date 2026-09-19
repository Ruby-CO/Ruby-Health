// Notion-backed Repository. Demo only -- synthetic data only. See
// Repository.js for the interface contract and reference/README-adjacent
// constraints: this file must never be handed real patient data, and no
// other module should import @notionhq/client or know a Notion page ID
// exists. That boundary is what lets a PostgresRepository replace this one
// later without touching a call site.
//
// IDs are sequential and human-readable (P001, C001, ...), per the demo
// convention -- production must mint UUIDs instead, since sequential IDs
// are enumerable. Foreign keys (a Case's patient_id) are stored as plain
// text, not Notion relations, so the adapter's behavior stays close to
// what the Postgres implementation will do.

import { Repository } from "./Repository.js";

export class NotionRepositoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotionRepositoryError";
  }
}

const STAGES = ["transcript", "facts", "codes", "claim"];
const CREATED_BY_VALUES = ["system", "provider_edit"];
const CLAIM_TYPES = ["original", "corrected", "secondary"];
const CLAIM_STATUSES = ["draft", "submitted", "accepted", "rejected", "denied", "pending"];
const DOCUMENT_SOURCES = ["upload", "fax", "ehr_sync"];
const FEEDBACK_TYPES = ["acknowledgment", "remittance"];
// Lowercase words, like every other select here; populateClaim maps them to
// the M/F/U the claim form carries. Locked before the first write on purpose:
// Notion mints a new option on any unknown value rather than rejecting it.
const PATIENT_SEXES = ["male", "female", "unknown"];
const INSURANCE_STATUSES = ["self_pay", "insured", "pending"];
const AUDIT_ENTITY_TYPES = ["claim", "artifact"];
const AUDIT_ACTIONS = ["created", "edited", "status_changed", "submitted", "approved"];

function titleText(page, property) {
  return page.properties[property]?.title?.[0]?.plain_text || "";
}

function richText(page, property) {
  return page.properties[property]?.rich_text?.[0]?.plain_text || "";
}

// Notion caps each rich_text item at 2000 characters. Artifact content is
// arbitrary pipeline-stage JSON and can easily exceed that, so it's written
// and read as a concatenation of chunks rather than a single item.
function richTextAll(page, property) {
  return (page.properties[property]?.rich_text || []).map((item) => item.plain_text).join("");
}

const RICH_TEXT_CHUNK_SIZE = 2000;

function chunkedRichText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_CHUNK_SIZE) {
    chunks.push({ text: { content: text.slice(i, i + RICH_TEXT_CHUNK_SIZE) } });
  }
  // Notion rejects an empty rich_text array -- an empty string still needs
  // one (empty) chunk to round-trip as "" rather than being omitted.
  return chunks.length > 0 ? chunks : [{ text: { content: "" } }];
}

function dateValue(page, property) {
  return page.properties[property]?.date?.start || null;
}

function selectValue(page, property) {
  return page.properties[property]?.select?.name || null;
}

function numberValue(page, property) {
  const value = page.properties[property]?.number;
  return typeof value === "number" ? value : null;
}

function parsePatient(page) {
  return {
    patientId: titleText(page, "patient_id"),
    name: richText(page, "name"),
    dateOfBirth: dateValue(page, "date_of_birth"),
    sex: selectValue(page, "sex"),
    insuranceStatus: selectValue(page, "insurance_status"),
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

function parseCase(page) {
  return {
    caseId: titleText(page, "case_id"),
    patientId: richText(page, "patient_id"),
    title: richText(page, "case_title"),
    status: selectValue(page, "status"),
    openedAt: dateValue(page, "opened_at"),
    closedAt: dateValue(page, "closed_at"),
  };
}

function parseEncounter(page) {
  return {
    encounterId: titleText(page, "encounter_id"),
    caseId: richText(page, "case_id"),
    patientId: richText(page, "patient_id"),
    occurredAt: dateValue(page, "occurred_at"),
    status: selectValue(page, "status"),
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

function parseDocument(page) {
  return {
    documentId: titleText(page, "document_id"),
    patientId: richText(page, "patient_id"),
    caseId: richText(page, "case_id") || null,
    source: selectValue(page, "source"),
    documentDate: dateValue(page, "document_date"),
    storageRef: richText(page, "storage_ref"),
    extractionStatus: selectValue(page, "extraction_status"),
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

function parseClaim(page) {
  return {
    claimId: titleText(page, "claim_id"),
    encounterId: richText(page, "encounter_id"),
    artifactId: richText(page, "artifact_id"),
    claimType: selectValue(page, "claim_type"),
    parentClaimId: richText(page, "parent_claim_id") || null,
    payerName: richText(page, "payer_name"),
    memberId: richText(page, "member_id"),
    status: selectValue(page, "status"),
    submittedAt: dateValue(page, "submitted_at"),
    // Assigned by the payer, so it is empty until a 277CA or 835 comes back.
    payerClaimControlNumber: richText(page, "payer_claim_control_number") || null,
    // Soft FK to the provider profile. Null on rows that predate the field.
    providerId: richText(page, "provider_id") || null,
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

function parseAuditEntry(page) {
  return {
    logId: titleText(page, "log_id"),
    providerId: richText(page, "provider_id") || null,
    entityType: selectValue(page, "entity_type"),
    // Empty when the write it describes failed before an id existed; the
    // detail names the encounter and stage in that case.
    entityId: richText(page, "entity_id") || null,
    action: selectValue(page, "action"),
    detail: richTextAll(page, "detail"),
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

function parsePayerFeedback(page) {
  const raw = richTextAll(page, "content");
  let content = null;
  try {
    content = raw ? JSON.parse(raw) : null;
  } catch {
    content = raw;
  }
  return {
    feedbackId: titleText(page, "feedback_id"),
    claimId: richText(page, "claim_id"),
    feedbackType: selectValue(page, "feedback_type"),
    receivedAt: dateValue(page, "received_at"),
    payerClaimControlNumber: richText(page, "payer_claim_control_number") || null,
    claimStatus: selectValue(page, "claim_status"),
    recommendedRoute: selectValue(page, "recommended_route"),
    amountAtRisk: numberValue(page, "amount_at_risk"),
    storageRef: richText(page, "storage_ref") || null,
    content,
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

function parseArtifact(page) {
  const raw = richTextAll(page, "content");
  let content = null;
  try {
    content = raw ? JSON.parse(raw) : null;
  } catch {
    // Should never happen -- createArtifact always writes JSON.stringify
    // output. Surfacing the raw text beats throwing on read.
    content = raw;
  }
  return {
    artifactId: titleText(page, "artifact_id"),
    encounterId: richText(page, "encounter_id"),
    stage: selectValue(page, "stage"),
    version: numberValue(page, "version"),
    content,
    createdBy: selectValue(page, "created_by"),
    providerId: richText(page, "provider_id") || null,
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

export class NotionRepository extends Repository {
  /**
   * @param {{ client: import("@notionhq/client").Client,
   *   patientsDataSourceId: string, casesDataSourceId: string,
   *   encountersDataSourceId?: string, artifactsDataSourceId?: string,
   *   claimsDataSourceId?: string, documentsDataSourceId?: string }} config
   *   The encounter/artifact/claim/document IDs are optional for now so existing
   *   callers built against just Patient/Case don't need to change -- methods
   *   that need them throw a clear config error instead of a confusing
   *   undefined-ID query.
   */
  constructor({
    client,
    patientsDataSourceId,
    casesDataSourceId,
    encountersDataSourceId,
    artifactsDataSourceId,
    claimsDataSourceId,
    documentsDataSourceId,
    payerFeedbackDataSourceId,
    auditLogDataSourceId,
  }) {
    super();
    if (!client) throw new NotionRepositoryError("NotionRepository requires a Notion client.");
    if (!patientsDataSourceId) throw new NotionRepositoryError("NotionRepository requires patientsDataSourceId.");
    if (!casesDataSourceId) throw new NotionRepositoryError("NotionRepository requires casesDataSourceId.");
    this.client = client;
    this.patientsDataSourceId = patientsDataSourceId;
    this.casesDataSourceId = casesDataSourceId;
    this.encountersDataSourceId = encountersDataSourceId;
    this.artifactsDataSourceId = artifactsDataSourceId;
    this.claimsDataSourceId = claimsDataSourceId;
    this.documentsDataSourceId = documentsDataSourceId;
    this.payerFeedbackDataSourceId = payerFeedbackDataSourceId;
    this.auditLogDataSourceId = auditLogDataSourceId;
  }

  _requireEncountersDataSource() {
    if (!this.encountersDataSourceId) {
      throw new NotionRepositoryError("NotionRepository was not configured with encountersDataSourceId.");
    }
  }

  _requireArtifactsDataSource() {
    if (!this.artifactsDataSourceId) {
      throw new NotionRepositoryError("NotionRepository was not configured with artifactsDataSourceId.");
    }
  }

  _requireClaimsDataSource() {
    if (!this.claimsDataSourceId) {
      throw new NotionRepositoryError("NotionRepository was not configured with claimsDataSourceId.");
    }
  }

  _requireDocumentsDataSource() {
    if (!this.documentsDataSourceId) {
      throw new NotionRepositoryError("NotionRepository was not configured with documentsDataSourceId.");
    }
  }

  _requirePayerFeedbackDataSource() {
    if (!this.payerFeedbackDataSourceId) {
      throw new NotionRepositoryError("NotionRepository was not configured with payerFeedbackDataSourceId.");
    }
  }

  _requireAuditLogDataSource() {
    if (!this.auditLogDataSourceId) {
      throw new NotionRepositoryError("NotionRepository was not configured with auditLogDataSourceId.");
    }
  }

  async createPatient({ name, dateOfBirth, sex, insuranceStatus }) {
    if (!name) throw new NotionRepositoryError("createPatient requires a name.");
    if (!dateOfBirth) throw new NotionRepositoryError("createPatient requires a dateOfBirth.");
    if (sex != null && !PATIENT_SEXES.includes(sex)) {
      throw new NotionRepositoryError(`createPatient sex must be one of: ${PATIENT_SEXES.join(", ")}.`);
    }
    if (insuranceStatus != null && !INSURANCE_STATUSES.includes(insuranceStatus)) {
      throw new NotionRepositoryError(
        `createPatient insuranceStatus must be one of: ${INSURANCE_STATUSES.join(", ")}.`
      );
    }

    const patientId = await this._nextSequentialId(this.patientsDataSourceId, "patient_id", "P");
    const properties = {
      patient_id: { title: [{ text: { content: patientId } }] },
      name: { rich_text: [{ text: { content: name } }] },
      date_of_birth: { date: { start: dateOfBirth } },
    };
    // Both optional, and absent means "not recorded" -- written by omitting
    // the property, never with a placeholder option that would read as a fact.
    if (sex != null) properties.sex = { select: { name: sex } };
    if (insuranceStatus != null) properties.insurance_status = { select: { name: insuranceStatus } };

    const page = await this.client.pages.create({
      parent: { data_source_id: this.patientsDataSourceId },
      properties,
    });
    return parsePatient(page);
  }

  async getPatient(patientId) {
    const page = await this._findByTitle(this.patientsDataSourceId, "patient_id", patientId);
    return page ? parsePatient(page) : null;
  }

  async listPatients() {
    const pages = await this._queryAll(this.patientsDataSourceId);
    return pages.map(parsePatient);
  }

  async createCase({ patientId, title }) {
    if (!patientId) throw new NotionRepositoryError("createCase requires a patientId.");
    if (!title) throw new NotionRepositoryError("createCase requires a title.");

    const patient = await this.getPatient(patientId);
    if (!patient) throw new NotionRepositoryError(`No patient found with patient_id '${patientId}'.`);

    const caseId = await this._nextSequentialId(this.casesDataSourceId, "case_id", "C");
    const openedAt = new Date().toISOString().slice(0, 10);
    const page = await this.client.pages.create({
      parent: { data_source_id: this.casesDataSourceId },
      properties: {
        case_id: { title: [{ text: { content: caseId } }] },
        patient_id: { rich_text: [{ text: { content: patientId } }] },
        // Notion's API key "title" always refers to whichever property is
        // type=title (case_id here), regardless of a property's actual
        // display name -- a property literally named "title" is unreachable
        // under that key. The Cases database's human-readable title lives in
        // a "case_title" column for exactly this reason.
        case_title: { rich_text: [{ text: { content: title } }] },
        status: { select: { name: "open" } },
        opened_at: { date: { start: openedAt } },
      },
    });
    return parseCase(page);
  }

  async getCase(caseId) {
    const page = await this._findByTitle(this.casesDataSourceId, "case_id", caseId);
    return page ? parseCase(page) : null;
  }

  async listCasesForPatient(patientId) {
    const pages = await this._queryAll(this.casesDataSourceId, {
      property: "patient_id",
      rich_text: { equals: patientId },
    });
    return pages.map(parseCase);
  }

  async closeCase(caseId) {
    const page = await this._findByTitle(this.casesDataSourceId, "case_id", caseId);
    if (!page) throw new NotionRepositoryError(`No case found with case_id '${caseId}'.`);

    const closedAt = new Date().toISOString().slice(0, 10);
    const updated = await this.client.pages.update({
      page_id: page.id,
      properties: {
        status: { select: { name: "closed" } },
        closed_at: { date: { start: closedAt } },
      },
    });
    return parseCase(updated);
  }

  async createEncounter({ caseId, occurredAt }) {
    this._requireEncountersDataSource();
    if (!caseId) throw new NotionRepositoryError("createEncounter requires a caseId.");
    if (!occurredAt) throw new NotionRepositoryError("createEncounter requires an occurredAt.");

    const encounterCase = await this.getCase(caseId);
    if (!encounterCase) throw new NotionRepositoryError(`No case found with case_id '${caseId}'.`);

    const encounterId = await this._nextSequentialId(this.encountersDataSourceId, "encounter_id", "E");
    const page = await this.client.pages.create({
      parent: { data_source_id: this.encountersDataSourceId },
      properties: {
        encounter_id: { title: [{ text: { content: encounterId } }] },
        case_id: { rich_text: [{ text: { content: caseId } }] },
        patient_id: { rich_text: [{ text: { content: encounterCase.patientId } }] },
        occurred_at: { date: { start: occurredAt } },
        status: { select: { name: "draft" } },
      },
    });
    return parseEncounter(page);
  }

  async getEncounter(encounterId) {
    this._requireEncountersDataSource();
    const page = await this._findByTitle(this.encountersDataSourceId, "encounter_id", encounterId);
    return page ? parseEncounter(page) : null;
  }

  async listEncountersForCase(caseId) {
    this._requireEncountersDataSource();
    const pages = await this._queryAll(this.encountersDataSourceId, {
      property: "case_id",
      rich_text: { equals: caseId },
    });
    return pages.map(parseEncounter).sort((a, b) => (a.occurredAt || "").localeCompare(b.occurredAt || ""));
  }

  async updateEncounterStatus(encounterId, status) {
    this._requireEncountersDataSource();
    const page = await this._findByTitle(this.encountersDataSourceId, "encounter_id", encounterId);
    if (!page) throw new NotionRepositoryError(`No encounter found with encounter_id '${encounterId}'.`);

    const updated = await this.client.pages.update({
      page_id: page.id,
      properties: { status: { select: { name: status } } },
    });
    return parseEncounter(updated);
  }

  async createArtifact({ encounterId, stage, content, createdBy, providerId }) {
    this._requireArtifactsDataSource();
    if (!encounterId) throw new NotionRepositoryError("createArtifact requires an encounterId.");
    if (!STAGES.includes(stage)) throw new NotionRepositoryError(`createArtifact stage must be one of: ${STAGES.join(", ")}.`);
    if (!CREATED_BY_VALUES.includes(createdBy)) {
      throw new NotionRepositoryError(`createArtifact createdBy must be one of: ${CREATED_BY_VALUES.join(", ")}.`);
    }

    const encounter = await this.getEncounter(encounterId);
    if (!encounter) throw new NotionRepositoryError(`No encounter found with encounter_id '${encounterId}'.`);

    const priorVersions = await this._queryAll(this.artifactsDataSourceId, {
      and: [
        { property: "encounter_id", rich_text: { equals: encounterId } },
        { property: "stage", select: { equals: stage } },
      ],
    });
    const version = priorVersions.reduce((max, page) => Math.max(max, numberValue(page, "version") || 0), 0) + 1;

    const artifactId = await this._nextSequentialId(this.artifactsDataSourceId, "artifact_id", "A");
    const page = await this.client.pages.create({
      parent: { data_source_id: this.artifactsDataSourceId },
      properties: {
        artifact_id: { title: [{ text: { content: artifactId } }] },
        encounter_id: { rich_text: [{ text: { content: encounterId } }] },
        stage: { select: { name: stage } },
        version: { number: version },
        content: { rich_text: chunkedRichText(JSON.stringify(content)) },
        created_by: { select: { name: createdBy } },
        // Not checked against the profile store on purpose: this file may not
        // know provider profiles exist. A soft FK like every other one here.
        provider_id: { rich_text: [{ text: { content: providerId || "" } }] },
      },
    });
    return parseArtifact(page);
  }

  async getArtifactHistory(encounterId) {
    this._requireArtifactsDataSource();
    const pages = await this._queryAll(this.artifactsDataSourceId, {
      property: "encounter_id",
      rich_text: { equals: encounterId },
    });
    return pages
      .map(parseArtifact)
      .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || b.version - a.version);
  }

  async getLatestArtifact(encounterId, stage) {
    this._requireArtifactsDataSource();
    const pages = await this._queryAll(this.artifactsDataSourceId, {
      and: [
        { property: "encounter_id", rich_text: { equals: encounterId } },
        { property: "stage", select: { equals: stage } },
      ],
    });
    if (pages.length === 0) return null;
    const artifacts = pages.map(parseArtifact);
    return artifacts.reduce((latest, artifact) => (artifact.version > latest.version ? artifact : latest));
  }

  async createClaim({ encounterId, artifactId, claimType, parentClaimId, payerName, memberId, providerId }) {
    this._requireClaimsDataSource();
    if (!CLAIM_TYPES.includes(claimType)) {
      throw new NotionRepositoryError(`createClaim claimType must be one of: ${CLAIM_TYPES.join(", ")}.`);
    }
    if (!payerName) throw new NotionRepositoryError("createClaim requires a payerName.");
    if (!memberId) throw new NotionRepositoryError("createClaim requires a memberId.");

    const encounter = await this.getEncounter(encounterId);
    if (!encounter) throw new NotionRepositoryError(`No encounter found with encounter_id '${encounterId}'.`);

    const artifact = await this._findByTitle(this.artifactsDataSourceId, "artifact_id", artifactId);
    if (!artifact) throw new NotionRepositoryError(`No artifact found with artifact_id '${artifactId}'.`);

    if (parentClaimId) {
      const parent = await this.getClaim(parentClaimId);
      if (!parent) throw new NotionRepositoryError(`No claim found with claim_id '${parentClaimId}'.`);
    }

    const claimId = await this._nextSequentialId(this.claimsDataSourceId, "claim_id", "CL");
    const page = await this.client.pages.create({
      parent: { data_source_id: this.claimsDataSourceId },
      properties: {
        claim_id: { title: [{ text: { content: claimId } }] },
        encounter_id: { rich_text: [{ text: { content: encounterId } }] },
        artifact_id: { rich_text: [{ text: { content: artifactId } }] },
        claim_type: { select: { name: claimType } },
        parent_claim_id: { rich_text: [{ text: { content: parentClaimId || "" } }] },
        payer_name: { rich_text: [{ text: { content: payerName } }] },
        member_id: { rich_text: [{ text: { content: memberId } }] },
        provider_id: { rich_text: [{ text: { content: providerId || "" } }] },
        status: { select: { name: "draft" } },
      },
    });
    return parseClaim(page);
  }

  async getClaim(claimId) {
    this._requireClaimsDataSource();
    const page = await this._findByTitle(this.claimsDataSourceId, "claim_id", claimId);
    return page ? parseClaim(page) : null;
  }

  async updateClaimStatus(claimId, status) {
    this._requireClaimsDataSource();
    if (!CLAIM_STATUSES.includes(status)) {
      throw new NotionRepositoryError(`updateClaimStatus status must be one of: ${CLAIM_STATUSES.join(", ")}.`);
    }
    const page = await this._findByTitle(this.claimsDataSourceId, "claim_id", claimId);
    if (!page) throw new NotionRepositoryError(`No claim found with claim_id '${claimId}'.`);

    const properties = { status: { select: { name: status } } };
    if (status === "submitted") {
      properties.submitted_at = { date: { start: new Date().toISOString().slice(0, 10) } };
    }
    const updated = await this.client.pages.update({ page_id: page.id, properties });
    return parseClaim(updated);
  }

  // A draft was never filed, so throwing it away costs nothing. Anything the
  // payer has seen is the billing record and stays -- as does any claim a
  // correction was chained to, which deleting would orphan.
  //
  // Notion's trash, not an erase: a claim deleted by a misclick is still
  // recoverable from the workspace for 30 days.
  async updateClaimArtifact(claimId, artifactId) {
    this._requireClaimsDataSource();
    this._requireArtifactsDataSource();
    if (!artifactId) throw new NotionRepositoryError("updateClaimArtifact requires an artifactId.");

    const page = await this._findByTitle(this.claimsDataSourceId, "claim_id", claimId);
    if (!page) throw new NotionRepositoryError(`No claim found with claim_id '${claimId}'.`);

    const claim = parseClaim(page);
    if (claim.status !== "draft") {
      throw new NotionRepositoryError(
        `Claim '${claimId}' is ${claim.status}, not a draft. The artifact a submitted claim points at is the record of what was billed and cannot be repointed.`,
      );
    }

    // The artifact pointer is the audit trail -- it is what makes a claim
    // resolve to the record it was built from. A pointer at another
    // encounter's artifact would make the claim cite someone else's visit, so
    // the pairing is checked rather than trusted.
    const artifactPage = await this._findByTitle(this.artifactsDataSourceId, "artifact_id", artifactId);
    if (!artifactPage) throw new NotionRepositoryError(`No artifact found with artifact_id '${artifactId}'.`);

    const artifact = parseArtifact(artifactPage);
    if (artifact.encounterId !== claim.encounterId) {
      throw new NotionRepositoryError(
        `Artifact '${artifactId}' belongs to encounter '${artifact.encounterId}', not to claim '${claimId}''s encounter '${claim.encounterId}'.`,
      );
    }
    if (artifact.stage !== "claim") {
      throw new NotionRepositoryError(
        `Artifact '${artifactId}' is a '${artifact.stage}' artifact, not a claim.`,
      );
    }

    const updated = await this.client.pages.update({
      page_id: page.id,
      properties: { artifact_id: { rich_text: [{ text: { content: artifactId } }] } },
    });
    return parseClaim(updated);
  }

  async deleteClaim(claimId) {
    this._requireClaimsDataSource();
    const page = await this._findByTitle(this.claimsDataSourceId, "claim_id", claimId);
    if (!page) throw new NotionRepositoryError(`No claim found with claim_id '${claimId}'.`);

    const claim = parseClaim(page);
    if (claim.status !== "draft") {
      throw new NotionRepositoryError(
        `Claim '${claimId}' is ${claim.status}, not a draft. A claim the payer has seen is the record of what was billed and cannot be deleted.`,
      );
    }

    const children = await this._queryAll(this.claimsDataSourceId, {
      property: "parent_claim_id",
      rich_text: { equals: claimId },
    });
    if (children.length > 0) {
      const ids = children.map((child) => parseClaim(child).claimId).join(", ");
      throw new NotionRepositoryError(
        `Claim '${claimId}' cannot be deleted because ${ids} ${children.length === 1 ? "was" : "were"} filed against it.`,
      );
    }

    await this.client.pages.update({ page_id: page.id, in_trash: true });
    return claim;
  }

  async listClaimsForEncounter(encounterId) {
    this._requireClaimsDataSource();
    const pages = await this._queryAll(this.claimsDataSourceId, {
      property: "encounter_id",
      rich_text: { equals: encounterId },
    });
    return pages.map(parseClaim).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  }

  // One query rather than walking patients -> cases -> encounters -> claims,
  // which is what the activity feed does and what a bucketed History page
  // would otherwise repeat on every visit.
  async listAllClaims() {
    this._requireClaimsDataSource();
    const pages = await this._queryAll(this.claimsDataSourceId);
    return pages.map(parseClaim).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  async setPayerClaimControlNumber(claimId, controlNumber) {
    this._requireClaimsDataSource();
    const page = await this._findByTitle(this.claimsDataSourceId, "claim_id", claimId);
    if (!page) throw new NotionRepositoryError(`No claim found with claim_id '${claimId}'.`);

    const updated = await this.client.pages.update({
      page_id: page.id,
      properties: { payer_claim_control_number: { rich_text: [{ text: { content: controlNumber || "" } }] } },
    });
    return parseClaim(updated);
  }

  async createPayerFeedback({
    claimId,
    feedbackType,
    receivedAt,
    payerClaimControlNumber,
    claimStatus,
    recommendedRoute,
    amountAtRisk,
    storageRef,
    content,
  }) {
    this._requirePayerFeedbackDataSource();
    if (!claimId) throw new NotionRepositoryError("createPayerFeedback requires a claimId.");
    if (!FEEDBACK_TYPES.includes(feedbackType)) {
      throw new NotionRepositoryError(`createPayerFeedback feedbackType must be one of: ${FEEDBACK_TYPES.join(", ")}.`);
    }

    const claim = await this.getClaim(claimId);
    if (!claim) throw new NotionRepositoryError(`No claim found with claim_id '${claimId}'.`);

    const feedbackId = await this._nextSequentialId(this.payerFeedbackDataSourceId, "feedback_id", "PF");
    const properties = {
      feedback_id: { title: [{ text: { content: feedbackId } }] },
      claim_id: { rich_text: [{ text: { content: claimId } }] },
      feedback_type: { select: { name: feedbackType } },
      received_at: { date: { start: receivedAt || new Date().toISOString().slice(0, 10) } },
      payer_claim_control_number: { rich_text: [{ text: { content: payerClaimControlNumber || "" } }] },
      storage_ref: { rich_text: [{ text: { content: storageRef || "" } }] },
      content: { rich_text: chunkedRichText(JSON.stringify(content ?? null)) },
    };
    // Left unset rather than guessed at: an acknowledgment carries no verdict
    // or route, and an empty select reads as "not applicable" rather than
    // implying one was computed.
    if (claimStatus) properties.claim_status = { select: { name: claimStatus } };
    if (recommendedRoute) properties.recommended_route = { select: { name: recommendedRoute } };
    if (typeof amountAtRisk === "number") properties.amount_at_risk = { number: amountAtRisk };

    const page = await this.client.pages.create({
      parent: { data_source_id: this.payerFeedbackDataSourceId },
      properties,
    });
    return parsePayerFeedback(page);
  }

  async getPayerFeedback(feedbackId) {
    this._requirePayerFeedbackDataSource();
    const page = await this._findByTitle(this.payerFeedbackDataSourceId, "feedback_id", feedbackId);
    return page ? parsePayerFeedback(page) : null;
  }

  async listPayerFeedbackForClaim(claimId) {
    this._requirePayerFeedbackDataSource();
    const pages = await this._queryAll(this.payerFeedbackDataSourceId, {
      property: "claim_id",
      rich_text: { equals: claimId },
    });
    return pages.map(parsePayerFeedback).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  }

  // A "chain" is every claim connected to a given one via parent_claim_id --
  // corrections and secondary submissions off the same original claim, not
  // necessarily a single straight line. All claims in a chain attach to the
  // same encounter (see the handoff doc), so the traversal is scoped there
  // rather than across the whole Claims database.
  async getClaimChain(claimId) {
    this._requireClaimsDataSource();
    const claim = await this.getClaim(claimId);
    if (!claim) throw new NotionRepositoryError(`No claim found with claim_id '${claimId}'.`);

    const encounterClaims = await this.listClaimsForEncounter(claim.encounterId);
    const claimsById = new Map(encounterClaims.map((c) => [c.claimId, c]));

    let root = claimsById.get(claimId);
    while (root.parentClaimId && claimsById.has(root.parentClaimId)) {
      root = claimsById.get(root.parentClaimId);
    }

    const chain = [];
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift();
      chain.push(current);
      for (const candidate of claimsById.values()) {
        if (candidate.parentClaimId === current.claimId) queue.push(candidate);
      }
    }
    return chain.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  }

  // Append-only. Nothing here updates or deletes a log row, and there is
  // deliberately no method that could. The entity is not re-checked to exist:
  // a log entry for a write that failed is exactly the case this has to cover,
  // and a lookup that could itself fail would make the log the fragile part.
  async createLogEntry({ providerId, entityType, entityId, action, detail }) {
    this._requireAuditLogDataSource();
    if (!AUDIT_ENTITY_TYPES.includes(entityType)) {
      throw new NotionRepositoryError(`createLogEntry entityType must be one of: ${AUDIT_ENTITY_TYPES.join(", ")}.`);
    }
    if (!AUDIT_ACTIONS.includes(action)) {
      throw new NotionRepositoryError(`createLogEntry action must be one of: ${AUDIT_ACTIONS.join(", ")}.`);
    }

    const logId = await this._nextSequentialId(this.auditLogDataSourceId, "log_id", "LOG");
    const page = await this.client.pages.create({
      parent: { data_source_id: this.auditLogDataSourceId },
      properties: {
        log_id: { title: [{ text: { content: logId } }] },
        provider_id: { rich_text: [{ text: { content: providerId || "" } }] },
        entity_type: { select: { name: entityType } },
        entity_id: { rich_text: [{ text: { content: entityId || "" } }] },
        action: { select: { name: action } },
        // Chunked so a long error message can never be the reason the log
        // write itself fails.
        detail: { rich_text: chunkedRichText(String(detail ?? "")) },
      },
    });
    return parseAuditEntry(page);
  }

  async getLogForEntity(entityType, entityId) {
    this._requireAuditLogDataSource();
    if (!AUDIT_ENTITY_TYPES.includes(entityType)) {
      throw new NotionRepositoryError(`getLogForEntity entityType must be one of: ${AUDIT_ENTITY_TYPES.join(", ")}.`);
    }
    const pages = await this._queryAll(this.auditLogDataSourceId, {
      and: [
        { property: "entity_type", select: { equals: entityType } },
        { property: "entity_id", rich_text: { equals: entityId } },
      ],
    });
    return pages.map(parseAuditEntry).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  }

  async createDocument({ patientId, caseId, source, documentDate, storageRef }) {
    this._requireDocumentsDataSource();
    if (!DOCUMENT_SOURCES.includes(source)) {
      throw new NotionRepositoryError(`createDocument source must be one of: ${DOCUMENT_SOURCES.join(", ")}.`);
    }
    if (!documentDate) throw new NotionRepositoryError("createDocument requires a documentDate.");
    if (!storageRef) throw new NotionRepositoryError("createDocument requires a storageRef.");

    const patient = await this.getPatient(patientId);
    if (!patient) throw new NotionRepositoryError(`No patient found with patient_id '${patientId}'.`);
    if (caseId) {
      const documentCase = await this.getCase(caseId);
      if (!documentCase) throw new NotionRepositoryError(`No case found with case_id '${caseId}'.`);
    }

    const documentId = await this._nextSequentialId(this.documentsDataSourceId, "document_id", "D");
    const page = await this.client.pages.create({
      parent: { data_source_id: this.documentsDataSourceId },
      properties: {
        document_id: { title: [{ text: { content: documentId } }] },
        patient_id: { rich_text: [{ text: { content: patientId } }] },
        case_id: { rich_text: [{ text: { content: caseId || "" } }] },
        source: { select: { name: source } },
        document_date: { date: { start: documentDate } },
        storage_ref: { rich_text: [{ text: { content: storageRef } }] },
        extraction_status: { select: { name: "none" } },
      },
    });
    return parseDocument(page);
  }

  async getDocument(documentId) {
    this._requireDocumentsDataSource();
    const page = await this._findByTitle(this.documentsDataSourceId, "document_id", documentId);
    return page ? parseDocument(page) : null;
  }

  async listDocumentsForPatient(patientId) {
    this._requireDocumentsDataSource();
    const pages = await this._queryAll(this.documentsDataSourceId, {
      property: "patient_id",
      rich_text: { equals: patientId },
    });
    return pages.map(parseDocument);
  }

  async _findByTitle(dataSourceId, titleProperty, value) {
    const response = await this.client.dataSources.query({
      data_source_id: dataSourceId,
      filter: { property: titleProperty, title: { equals: value } },
      page_size: 1,
    });
    return response.results[0] || null;
  }

  async _queryAll(dataSourceId, filter) {
    const results = [];
    let cursor;
    do {
      const response = await this.client.dataSources.query({
        data_source_id: dataSourceId,
        ...(filter ? { filter } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
        page_size: 100,
      });
      results.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  // IDs are assigned by scanning existing titles rather than by a counter
  // property, since Notion has no atomic sequence primitive -- fine at demo
  // volume, and the production repository won't need this at all (Postgres
  // gets a real sequence or a UUID default).
  async _nextSequentialId(dataSourceId, titleProperty, prefix) {
    const pages = await this._queryAll(dataSourceId);
    let max = 0;
    for (const page of pages) {
      const title = titleText(page, titleProperty);
      if (title.startsWith(prefix) && /^\d+$/.test(title.slice(prefix.length))) {
        max = Math.max(max, parseInt(title.slice(prefix.length), 10));
      }
    }
    return `${prefix}${String(max + 1).padStart(3, "0")}`;
  }
}
