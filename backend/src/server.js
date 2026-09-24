import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { extractAndCode } from "./pipeline/extractAndCode.js";
import { generateBrief } from "./pipeline/cleanupTranscript.js";
import { populateClaim, ClaimError } from "./pipeline/populateClaim.js";
import { verifyNecessityQuotes } from "./pipeline/verifyQuotes.js";
import { buildStediClaim, StediMappingError } from "./pipeline/buildStediClaim.js";
import { buildCorrectedClaim, CorrectedClaimError } from "./pipeline/buildCorrectedClaim.js";
import { submitToStedi, StediSubmissionError } from "./pipeline/submitToStedi.js";
import { annotateValidation, unrecognisedCodes } from "./pipeline/validateCodes.js";
import { usageTotals } from "./usage.js";
import { persistenceFailure } from "./persistence.js";
import { pickOriginalDraft, hasBilledOriginal } from "./draftClaim.js";
import { loadCodeSet } from "../../reference/loadCodes.mjs";
import { createNotionRepositoryFromEnv, createBlobStoreFromEnv, NotionRepositoryError } from "./repository/index.js";
import { RemittanceParseError } from "./pipeline/parseRemittance.js";
import { ingestRemittance, RemittanceIngestError } from "./pipeline/ingestRemittance.js";
import { draftAppeal } from "./pipeline/draftAppeal.js";
import { loadAdjustmentCodes } from "../../reference/loadAdjustmentCodes.mjs";
import {
  getProviderProfile,
  upsertProviderProfile,
  listProviderProfiles,
  ProviderProfileError,
  DEFAULT_PROVIDER_ID,
} from "./providerProfiles.js";
import { DEMO_PROVIDER_PROFILE } from "../scripts/seed-provider-profile.js";
import { recordAudit } from "./auditLog.js";
import { transmitClaim, billedAmountOf } from "./transmitClaim.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");

const PORT = process.env.PORT || 3000;
// The claim path -- extraction and coding. Sonnet for now, deliberately: the
// model worth running here is the one that codes a real conversation best, and
// nobody has measured that yet. Revisit it against the eval suite once there
// are real demo encounters to score, rather than picking from first principles.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// Transcript cleanup is punctuation repair, not judgment, and it regenerates the
// whole transcript as output tokens. It stays on a cheap model until it is
// retired from the claim path entirely.
const UTILITY_MODEL = process.env.ANTHROPIC_UTILITY_MODEL || "claude-haiku-4-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Stedi sandbox credentials -- separate from the Anthropic key, kept out of
// the repo the same way. A test-mode key only reaches Stedi's sandbox network.
const STEDI_API_KEY = process.env.STEDI_API_KEY;

const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

// providerProfiles.js is a JSON file on disk -- fine locally, but Render's
// disk is ephemeral, so a profile seeded by hand (npm run seed:provider)
// does not survive a redeploy or a free-tier spin-down/spin-up. Seeding the
// demo profile here instead, on every boot, means the live service always
// has a real NPI to submit with -- not the 0000000000 placeholder Stedi
// rejects -- without a manual step that's easy to forget after a deploy.
if (!getProviderProfile(DEFAULT_PROVIDER_ID)) {
  upsertProviderProfile(DEFAULT_PROVIDER_ID, DEMO_PROVIDER_PROFILE);
  console.log(`Seeded demo provider profile for '${DEFAULT_PROVIDER_ID}' (none found on disk at boot).`);
}

// Notion-backed persistence -- optional at boot, same as the reference code
// set. A fresh clone (or a deploy) with no NOTION_* env vars still runs the
// claim pipeline exactly as before; only the New Claim intake screen and
// encounter/artifact persistence are unavailable until it's configured.
let repository = null;
try {
  repository = createNotionRepositoryFromEnv();
} catch (err) {
  console.warn("Notion repository not configured -- patient/case persistence disabled:", err.message);
}

// The raw payer document goes to blob storage rather than into a Notion row --
// files don't belong in Notion, which is the whole reason the BlobStore seam
// exists. Same ephemeral-disk caveat as provider profiles: on Render the
// stored document does not survive a redeploy, so a storageRef can dangle.
// Production swaps in Aptible-managed storage behind the same interface.
const blobStore = createBlobStoreFromEnv();

// Reason codes for the denial loop. Committed with the repo, unlike the
// billing code set, so this is expected to load -- but a failure degrades to
// "every code unrecognised" rather than taking denial handling down.
let adjustmentCodes = { carc: new Map(), rarc: new Map(), groupCodes: {}, loaded: false };
loadAdjustmentCodes()
  .then((loaded) => {
    adjustmentCodes = loaded;
    if (!loaded.loaded) {
      console.warn("Could not load reference/adjustment-codes.json -- denial reasons will show as raw codes.");
    }
  })
  .catch((err) => console.warn("Could not load adjustment codes:", err.message));

// Loaded once at boot. Absent or empty is fine: validation reports "unchecked"
// rather than failing, so a fresh clone with no reference files still runs.
let codeIndex = null;
loadCodeSet()
  .then(({ codes, byKey, sources }) => {
    if (codes.length === 0) {
      console.warn("No reference code set found -- code validation is disabled. See reference/README.md.");
      return;
    }
    const coversTypes = new Set(codes.map((c) => c.type));
    codeIndex = { byKey, coversTypes, source: sources.map((s2) => s2.file).join(", "), size: codes.length };
    console.log(`Reference code set: ${codes.length} codes covering ${[...coversTypes].join(", ")}`);
    console.warn(
      "NOTE: the loaded set is not a complete billing code set. Validation is " +
        "warning-level only and never blocks a code. Demo use only."
    );
  })
  .catch((err) => console.warn("Could not load reference code set:", err.message));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(FRONTEND_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(API_KEY),
    model: MODEL,
    utilityModel: UTILITY_MODEL,
    codeValidation: codeIndex
      ? { enabled: true, codes: codeIndex.size, covers: [...codeIndex.coversTypes], blocking: false }
      : { enabled: false },
    persistence: { enabled: Boolean(repository) },
  });
});

function requireRepository(res) {
  if (repository) return true;
  res.status(500).json({
    error: "Notion repository is not configured on the server. Add NOTION_* vars to backend/.env and restart.",
  });
  return false;
}

// Best-effort, and it says so. A persistence hiccup shouldn't take down a
// pipeline stage the provider is actively watching -- but it must not be
// reported as success either, which is what swallowing the error did: the
// stage ticked green and the visit's record had a hole in it that nothing in
// the UI mentioned.
//
// Returns null when persistence was never attempted (no repository configured,
// or no encounter yet). That is not a failure and must not warn.
async function persistArtifact(encounterId, stage, content, providerId) {
  if (!repository || !encounterId) return null;
  try {
    const artifact = await repository.createArtifact({ encounterId, stage, content, createdBy: "system", providerId });
    await recordAudit(repository, {
      providerId,
      entityType: "artifact",
      entityId: artifact.artifactId,
      action: "created",
      detail: `${stage} v${artifact.version} · encounter ${encounterId}`,
    });
    return { stage, saved: true };
  } catch (err) {
    console.error(`Persisting '${stage}' artifact for encounter '${encounterId}' failed:`, err);
    // The failure is logged too -- it is the first time a lost save leaves a
    // trace anywhere but the console. No artifact id exists, so the detail
    // carries what would have identified it. Still logging-and-continuing:
    // whether this should hard-fail is a separate decision.
    await recordAudit(repository, {
      providerId,
      entityType: "artifact",
      entityId: "",
      action: "created",
      detail: `persist failed · encounter ${encounterId} · stage ${stage} · ${err.message}`,
    });
    return { stage, saved: false };
  }
}


// Which provider a request acts for. Single-tenant today, so this is the
// default profile unless the body names another -- and this function is the
// one seam where multi-tenant would attach: every row that records a
// provider gets its id from here, so a real identity source replaces one
// line rather than a dozen call sites.
function resolveProviderId(req) {
  return (req.body && req.body.providerId) || DEFAULT_PROVIDER_ID;
}

// What the stored rows already know about a visit, for populateClaim. Best
// effort on purpose: populate runs before an encounter exists on the New Claim
// path, and a lookup that fails should cost a placeholder and a warning on the
// claim -- which populateClaim adds -- not a failed stage. Unlike a failed
// save, this degradation is visible: the claim says which fields it invented.
async function buildClaimContext(encounterId) {
  if (!repository || !encounterId) return {};
  try {
    const encounter = await repository.getEncounter(encounterId);
    if (!encounter) return {};
    const patient = encounter.patientId ? await repository.getPatient(encounter.patientId) : null;
    return {
      dateOfService: encounter.occurredAt || undefined,
      patient: patient ? { name: patient.name, dateOfBirth: patient.dateOfBirth, sex: patient.sex } : undefined,
    };
  } catch (err) {
    console.error(`Reading claim context for encounter '${encounterId}' failed:`, err);
    return {};
  }
}

// The encounter's newest draft claim, or null. A submitted claim needs its own
// id before it is mapped for the payer, and persistSubmittedClaim needs the
// same row afterwards.
async function findDraftClaim(encounterId) {
  if (!repository || !encounterId) return null;
  try {
    const claims = await repository.listClaimsForEncounter(encounterId);
    return pickOriginalDraft(claims);
  } catch (err) {
    console.error(`Looking up the draft claim for encounter '${encounterId}' failed:`, err);
    return null;
  }
}

// A provider recording a visit shouldn't have to know who the patient is
// before they can start talking -- extraction can run, and the encounter
// still needs to land somewhere real. Every such encounter files under one
// shared placeholder Patient, in its own Case titled from the chief
// complaint, so it's a real findable record instead of being silently lost.
const UNIDENTIFIED_PATIENT_NAME = "Unidentified Patient";
const UNIDENTIFIED_PATIENT_DOB = "1900-01-01";
let unidentifiedPatientCache = null;

async function getOrCreateUnidentifiedPatient() {
  if (unidentifiedPatientCache) return unidentifiedPatientCache;
  const patients = await repository.listPatients();
  const existing = patients.find((p) => p.name === UNIDENTIFIED_PATIENT_NAME);
  unidentifiedPatientCache =
    existing || (await repository.createPatient({ name: UNIDENTIFIED_PATIENT_NAME, dateOfBirth: UNIDENTIFIED_PATIENT_DOB }));
  return unidentifiedPatientCache;
}

function deriveUnidentifiedCaseTitle(facts) {
  const chiefComplaint = ((facts && facts.chiefComplaint) || "").trim();
  return chiefComplaint ? `${chiefComplaint} - unidentified patient` : "Encounter - unidentified patient";
}

// Best-effort, same as persistArtifact: a provisioning hiccup shouldn't
// block returning facts the extraction call already succeeded at.
async function autoProvisionEncounter(facts) {
  if (!repository) return null;
  try {
    const patient = await getOrCreateUnidentifiedPatient();
    const title = deriveUnidentifiedCaseTitle(facts);
    const createdCase = await repository.createCase({ patientId: patient.patientId, title });
    const occurredAt = new Date().toISOString().slice(0, 10);
    const encounter = await repository.createEncounter({ caseId: createdCase.caseId, occurredAt });
    return { patient, case: createdCase, encounter };
  } catch (err) {
    console.error("Auto-provisioning an unidentified-patient encounter failed:", err);
    return null;
  }
}

// Encounters are optional at the repository level (see NotionRepository's
// constructor), so anything computing "last activity" or a visit count from
// them needs to degrade to "no encounters" rather than fail outright.
async function listEncountersForCaseSafe(caseId) {
  try {
    return await repository.listEncountersForCase(caseId);
  } catch (err) {
    if (err instanceof NotionRepositoryError) return [];
    throw err;
  }
}

function latestTimestamp(timestamps) {
  const present = timestamps.filter(Boolean);
  return present.length ? present.sort().at(-1) : null;
}

app.get("/api/patients", async (_req, res) => {
  if (!requireRepository(res)) return;
  try {
    const patients = await repository.listPatients();
    // The History patient list needs open-case count and last-activity per
    // row; every other caller of this endpoint (patient search in the New
    // Claim intake step) just ignores the extra fields.
    const enriched = await Promise.all(
      patients.map(async (patient) => {
        const cases = await repository.listCasesForPatient(patient.patientId);
        const encounterLists = await Promise.all(cases.map((c) => listEncountersForCaseSafe(c.caseId)));
        const encounters = encounterLists.flat();
        return {
          ...patient,
          openCaseCount: cases.filter((c) => c.status === "open").length,
          lastActivity: latestTimestamp([
            ...encounters.map((e) => e.createdAt || e.occurredAt),
            ...cases.map((c) => c.openedAt),
          ]),
        };
      })
    );
    res.json({ patients: enriched });
  } catch (err) {
    console.error("Listing patients failed:", err);
    res.status(502).json({ error: "Listing patients failed. See server logs for details." });
  }
});

app.post("/api/patients", async (req, res) => {
  if (!requireRepository(res)) return;
  const { name, dateOfBirth, sex, insuranceStatus } = req.body || {};

  if (!name || !dateOfBirth) {
    return res.status(400).json({ error: "Request body must include 'name' and 'dateOfBirth'." });
  }

  try {
    // Empty strings from a blank <select> mean "not recorded", same as absent.
    const patient = await repository.createPatient({
      name,
      dateOfBirth,
      sex: sex || undefined,
      insuranceStatus: insuranceStatus || undefined,
    });
    res.json({ patient });
  } catch (err) {
    // An unknown sex or insurance status is the caller's mistake, not the store's.
    if (err instanceof NotionRepositoryError && /must be one of/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Creating patient failed:", err);
    res.status(502).json({ error: "Creating patient failed. See server logs for details." });
  }
});

// The History activity view's data source: recent encounters and recently
// submitted claims, newest first, across every patient. There's no single
// Notion query for "everything recent" -- foreign keys are plain-text IDs,
// not Notion relations (see NotionRepository.js), so this composes the
// existing per-parent list methods instead of adding Notion-specific query
// logic. Fine at demo volume; a Postgres repository would answer this with
// one indexed query instead.
app.get("/api/activity", async (req, res) => {
  if (!requireRepository(res)) return;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  try {
    const patients = await repository.listPatients();
    const patientsById = new Map(patients.map((p) => [p.patientId, p]));

    const caseLists = await Promise.all(patients.map((p) => repository.listCasesForPatient(p.patientId)));
    const cases = caseLists.flat();
    const casesById = new Map(cases.map((c) => [c.caseId, c]));

    const encounterLists = await Promise.all(cases.map((c) => repository.listEncountersForCase(c.caseId)));
    const encounters = encounterLists.flat();
    const encountersById = new Map(encounters.map((e) => [e.encounterId, e]));

    // Claims require the claims data source to be configured, unlike
    // patients/cases/encounters -- degrade to "no claim activity" rather
    // than failing the whole feed when it isn't.
    let claims = [];
    try {
      const claimLists = await Promise.all(encounters.map((e) => repository.listClaimsForEncounter(e.encounterId)));
      claims = claimLists.flat();
    } catch (err) {
      if (!(err instanceof NotionRepositoryError)) throw err;
    }

    // patientId/caseId (and encounterId on a claim item) are here so the
    // activity feed can be clicked straight through to the encounter it
    // describes -- not just displayed as inert text.
    const encounterItems = encounters.map((e) => ({
      type: "encounter",
      id: e.encounterId,
      status: e.status,
      timestamp: e.createdAt || e.occurredAt,
      patientId: e.patientId,
      patientName: patientsById.get(e.patientId)?.name || e.patientId,
      caseId: e.caseId,
      caseTitle: casesById.get(e.caseId)?.title || e.caseId,
    }));

    const claimItems = claims.map((c) => {
      const encounter = encountersById.get(c.encounterId);
      const patient = encounter ? patientsById.get(encounter.patientId) : null;
      return {
        type: "claim",
        id: c.claimId,
        status: c.status,
        timestamp: c.submittedAt || c.createdAt,
        patientId: encounter?.patientId || null,
        patientName: patient?.name || null,
        caseId: encounter?.caseId || null,
        encounterId: c.encounterId,
        payerName: c.payerName,
      };
    });

    const activity = [...encounterItems, ...claimItems]
      .filter((item) => item.timestamp)
      .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
      .slice(0, limit);

    res.json({ activity });
  } catch (err) {
    console.error("Building activity feed failed:", err);
    res.status(502).json({ error: "Building activity feed failed. See server logs for details." });
  }
});

app.get("/api/patients/:patientId/cases", async (req, res) => {
  if (!requireRepository(res)) return;
  try {
    const cases = await repository.listCasesForPatient(req.params.patientId);
    // The History patient view needs a visit count and last-activity per
    // case row; the New Claim intake step's case picker ignores the extras.
    const enriched = await Promise.all(
      cases.map(async (c) => {
        const encounters = await listEncountersForCaseSafe(c.caseId);
        return {
          ...c,
          visitCount: encounters.length,
          lastActivity: latestTimestamp([...encounters.map((e) => e.createdAt || e.occurredAt), c.openedAt]),
        };
      })
    );
    res.json({ cases: enriched });
  } catch (err) {
    console.error("Listing cases failed:", err);
    res.status(502).json({ error: "Listing cases failed. See server logs for details." });
  }
});

// The History case view's encounter list -- chronological, per build-order
// step 8. listEncountersForCase already sorts oldest-first (see
// NotionRepository.js); this is a thin wrapper, same shape as the other
// GET endpoints above.
app.get("/api/cases/:caseId/encounters", async (req, res) => {
  if (!requireRepository(res)) return;
  try {
    const encounters = await repository.listEncountersForCase(req.params.caseId);
    res.json({ encounters });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Listing encounters failed:", err);
    res.status(502).json({ error: "Listing encounters failed. See server logs for details." });
  }
});

// Build-order step 9: the History encounter view reads this to show the
// 4-tab UI in read mode, against what was actually persisted, instead of
// running the live pipeline. Returns every version of every stage -- the
// frontend picks the latest per stage for now; step 10's version-history
// disclosure needs the same data, so this endpoint doesn't change then.
app.get("/api/encounters/:encounterId/artifacts", async (req, res) => {
  if (!requireRepository(res)) return;
  try {
    const history = await repository.getArtifactHistory(req.params.encounterId);
    res.json({ history });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Loading artifact history failed:", err);
    res.status(502).json({ error: "Loading artifact history failed. See server logs for details." });
  }
});

app.post("/api/cases", async (req, res) => {
  if (!requireRepository(res)) return;
  const { patientId, title } = req.body || {};

  if (!patientId || !title) {
    return res.status(400).json({ error: "Request body must include 'patientId' and 'title'." });
  }

  try {
    const createdCase = await repository.createCase({ patientId, title });
    res.json({ case: createdCase });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Creating case failed:", err);
    res.status(502).json({ error: "Creating case failed. See server logs for details." });
  }
});

app.post("/api/encounters", async (req, res) => {
  if (!requireRepository(res)) return;
  const { caseId } = req.body || {};

  if (!caseId) {
    return res.status(400).json({ error: "Request body must include 'caseId'." });
  }

  try {
    const occurredAt = new Date().toISOString().slice(0, 10);
    const encounter = await repository.createEncounter({ caseId, occurredAt });
    res.json({ encounter });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Creating encounter failed:", err);
    res.status(502).json({ error: "Creating encounter failed. See server logs for details." });
  }
});

// Lets the frontend re-file content it already has in hand -- e.g. a
// transcript and facts extracted before the provider attached a patient --
// under a newly-created encounter, without re-running the Claude calls that
// produced them. See the "Attach" handler in index.html: attaching mid-flow
// creates a brand-new encounter, and without this, whatever was already
// extracted stayed orphaned under the auto-provisioned "unidentified
// patient" encounter instead of following the provider's correction.
//
// `submission` is deliberately absent: it is the record of what went to the
// payer, written only by sendClaim. A client must not be able to file one.
const ENCOUNTER_ARTIFACT_STAGES = ["transcript", "facts", "codes", "claim"];
// Who a revision came from. A provider correcting the record in History is not
// the same as Ruby writing it, and the revision list says so -- but only if the
// caller can tell us apart.
const ARTIFACT_AUTHORS = ["system", "provider_edit"];

app.post("/api/encounters/:encounterId/artifacts", async (req, res) => {
  if (!requireRepository(res)) return;
  const { stage, content, createdBy = "system" } = req.body || {};

  if (!ENCOUNTER_ARTIFACT_STAGES.includes(stage)) {
    return res.status(400).json({ error: `Request body must include a 'stage' one of: ${ENCOUNTER_ARTIFACT_STAGES.join(", ")}.` });
  }
  if (!ARTIFACT_AUTHORS.includes(createdBy)) {
    return res.status(400).json({ error: `'createdBy' must be one of: ${ARTIFACT_AUTHORS.join(", ")}.` });
  }

  try {
    const artifact = await repository.createArtifact({
      encounterId: req.params.encounterId,
      stage,
      content,
      createdBy,
      providerId: resolveProviderId(req),
    });
    // The one place a person, not the pipeline, changes an artifact. Logging
    // the machine writes and skipping this one would invert the log's point.
    await recordAudit(repository, {
      providerId: resolveProviderId(req),
      entityType: "artifact",
      entityId: artifact.artifactId,
      action: createdBy === "provider_edit" ? "edited" : "created",
      detail: `${stage} v${artifact.version} · encounter ${req.params.encounterId} · ${createdBy}`,
    });
    res.json({ artifact });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Re-attaching artifact failed:", err);
    res.status(502).json({ error: "Re-attaching artifact failed. See server logs for details." });
  }
});

const ENCOUNTER_STATUSES = ["draft", "reviewed", "submitted"];

app.post("/api/encounters/:encounterId/status", async (req, res) => {
  if (!requireRepository(res)) return;
  const { status } = req.body || {};

  if (!ENCOUNTER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Request body must include a 'status' one of: ${ENCOUNTER_STATUSES.join(", ")}.` });
  }

  try {
    const encounter = await repository.updateEncounterStatus(req.params.encounterId, status);
    res.json({ encounter });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Updating encounter status failed:", err);
    res.status(502).json({ error: "Updating encounter status failed. See server logs for details." });
  }
});

// --- The denial loop: what came back from the payer -----------------------

app.post("/api/claims/:claimId/remittance", async (req, res) => {
  if (!requireRepository(res)) return;
  const { remittance, dateOfService, submittedClaim } = req.body || {};

  if (!remittance) {
    return res.status(400).json({ error: "Request body must include a 'remittance' field (the payer's raw 835 EDI document)." });
  }

  try {
    const result = await ingestRemittance({
      repository,
      blobStore,
      adjustmentCodes,
      claimId: req.params.claimId,
      remittance,
      dateOfService,
      submittedClaim,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof RemittanceIngestError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err instanceof RemittanceParseError || err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Ingesting remittance failed:", err);
    res.status(502).json({ error: "Ingesting remittance failed. See server logs for details." });
  }
});

// The one model call in the denial loop. Everything before it is arithmetic;
// this reads the denial against what actually happened in the room.
app.post("/api/claims/:claimId/appeal", async (req, res) => {
  if (!requireRepository(res)) return;

  if (!anthropic) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  try {
    const claim = await repository.getClaim(req.params.claimId);
    if (!claim) return res.status(404).json({ error: `No claim found with claim_id '${req.params.claimId}'.` });

    const feedback = await repository.listPayerFeedbackForClaim(claim.claimId);
    const latest = feedback[feedback.length - 1];
    const analysis = latest?.content?.analysis;
    if (!analysis) {
      return res.status(400).json({ error: "No payer response has been recorded for this claim yet." });
    }

    // The appeal is built out of the encounter record, so it needs the record.
    const [transcriptArtifact, factsArtifact, codesArtifact] = await Promise.all([
      repository.getLatestArtifact(claim.encounterId, "transcript"),
      repository.getLatestArtifact(claim.encounterId, "facts"),
      repository.getLatestArtifact(claim.encounterId, "codes"),
    ]);

    const transcript = transcriptArtifact?.content?.transcript || "";
    if (!transcript.trim()) {
      return res.status(400).json({
        error: "This encounter has no clinical context on file, so there is nothing to ground an appeal in.",
      });
    }

    const draft = await draftAppeal(anthropic, MODEL, {
      analysis,
      facts: factsArtifact?.content || null,
      transcript,
      codes: codesArtifact?.content || [],
    });

    res.json({ draft });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Drafting an appeal failed:", err);
    res.status(502).json({ error: "Drafting an appeal failed. See server logs for details." });
  }
});

app.get("/api/claims/:claimId/feedback", async (req, res) => {
  if (!requireRepository(res)) return;
  try {
    const feedback = await repository.listPayerFeedbackForClaim(req.params.claimId);
    res.json({ feedback });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Listing payer feedback failed:", err);
    res.status(502).json({ error: "Listing payer feedback failed. See server logs for details." });
  }
});

// The History encounter view needs a claim's status and denial state next to
// the artifacts it was built from.
// Build-order step 11: History stops being one undifferentiated feed and
// becomes buckets a provider triages -- drafts to send, submissions in
// flight, rejections to fix, denials to fight. That needs every claim in one
// list with enough context to show a row and click through, which nothing
// exposed before: claims were only ever reachable one encounter at a time.
app.get("/api/claims", async (_req, res) => {
  if (!requireRepository(res)) return;
  try {
    const claims = await repository.listAllClaims();

    // Claims carry an encounter id and nothing else human-readable, so a row
    // would otherwise say "CL-14" with no patient on it. Resolved here rather
    // than by the client firing a request per row.
    const [patients, encounters] = await Promise.all([
      repository.listPatients(),
      Promise.all(
        [...new Set(claims.map((c) => c.encounterId))].map((id) => repository.getEncounter(id).catch(() => null))
      ),
    ]);
    const patientsById = new Map(patients.map((p) => [p.patientId, p]));
    const encountersById = new Map(encounters.filter(Boolean).map((e) => [e.encounterId, e]));

    const caseLists = await Promise.all(patients.map((p) => repository.listCasesForPatient(p.patientId)));
    const casesById = new Map(caseLists.flat().map((c) => [c.caseId, c]));

    const enriched = claims.map((claim) => {
      const encounter = encountersById.get(claim.encounterId) || null;
      const patient = encounter ? patientsById.get(encounter.patientId) : null;
      const caseObj = encounter ? casesById.get(encounter.caseId) : null;
      return {
        ...claim,
        patientId: encounter?.patientId || null,
        patientName: patient?.name || null,
        caseId: encounter?.caseId || null,
        caseTitle: caseObj?.title || encounter?.caseId || null,
        occurredAt: encounter?.occurredAt || null,
      };
    });

    res.json({ claims: enriched });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Listing claims failed:", err);
    res.status(502).json({ error: "Listing claims failed. See server logs for details." });
  }
});

app.get("/api/encounters/:encounterId/claims", async (req, res) => {
  if (!requireRepository(res)) return;
  try {
    const claims = await repository.listClaimsForEncounter(req.params.encounterId);
    res.json({ claims });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Listing claims for encounter failed:", err);
    res.status(502).json({ error: "Listing claims failed. See server logs for details." });
  }
});

// The repository decides what is deletable -- a draft, never chained to. The
// route only reports its refusal, so the rule lives in one place.
app.delete("/api/claims/:claimId", async (req, res) => {
  if (!requireRepository(res)) return;
  try {
    const claim = await repository.deleteClaim(req.params.claimId);
    res.json({ claim });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Deleting claim failed:", err);
    res.status(502).json({ error: "Deleting the claim failed. See server logs for details." });
  }
});

app.post("/api/extract", async (req, res) => {
  const { transcript, encounterId, skipPersistence } = req.body || {};

  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'transcript' string." });
  }

  if (!anthropic) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  try {
    // One model call reads the transcript and returns both the facts and the
    // code suggestions (P2). The coder sees the actual words, not a summary.
    const { facts, suggestions: rawSuggestions } = await extractAndCode(anthropic, MODEL, transcript);

    // Presented as direct quotation and carried into the claim as the
    // justification for care, so it is checked against the real transcript
    // before a reviewer sees it -- not against any rewritten version.
    facts.medicalNecessityGrounding = verifyNecessityQuotes(facts, transcript);

    const suggestions = annotateValidation(rawSuggestions, codeIndex);
    const unrecognised = unrecognisedCodes(suggestions);
    if (unrecognised.length > 0) {
      console.log(JSON.stringify({ type: "validation", unrecognised }));
    }

    // The eval harness passes skipPersistence: it measures the pipeline and must
    // not write into the product store. Without it, an eval call with no
    // encounterId hits the auto-provision path and files real-looking encounters
    // and artifacts under the shared "Unidentified Patient" (audit C2).
    if (skipPersistence) {
      return res.json({ facts, suggestions, encounterId: null, autoProvisioned: null, persistence: null });
    }

    let effectiveEncounterId = encounterId;
    let autoProvisioned = null;
    if (!effectiveEncounterId) {
      autoProvisioned = await autoProvisionEncounter(facts);
      if (autoProvisioned) effectiveEncounterId = autoProvisioned.encounter.encounterId;
    }

    const providerId = resolveProviderId(req);
    const persistence = persistenceFailure(
      await persistArtifact(effectiveEncounterId, "transcript", { transcript }, providerId),
      await persistArtifact(effectiveEncounterId, "facts", facts, providerId),
      await persistArtifact(effectiveEncounterId, "codes", suggestions, providerId)
    );

    res.json({ facts, suggestions, encounterId: effectiveEncounterId || null, autoProvisioned, persistence });
  } catch (err) {
    console.error("Extraction failed:", err);
    res.status(502).json({ error: "Extraction failed. See server logs for details." });
  }
});

app.post("/api/cleanup-transcript", async (req, res) => {
  const { transcript } = req.body || {};

  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'transcript' string." });
  }

  if (!anthropic) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  try {
    // The brief is a reading aid only -- it never replaces the transcript, so
    // the pipeline and the quote check always run on what was actually said.
    const { summary } = await generateBrief(anthropic, UTILITY_MODEL, transcript);
    res.json({ summary });
  } catch (err) {
    console.error("Brief generation failed:", err);
    res.status(502).json({ error: "Brief generation failed. See server logs for details." });
  }
});

// Best-effort, same as persistArtifact: a claim previously only became a
// real Claim row if it was actually submitted to Stedi, so a claim that was
// drafted but never submitted (or whose submission failed) left no trace in
// History at all -- even though its content was safely persisted as an
// artifact the whole time. Filing a "draft" Claim row as soon as the claim
// is populated means History always reflects what was created, not just
// what got all the way to submission.
async function persistClaimDraft(encounterId, claim, providerId) {
  if (!repository || !encounterId) return;
  try {
    const artifact = await repository.getLatestArtifact(encounterId, "claim");
    if (!artifact) return;

    // One visit, one draft. Walking back into the Claim step re-runs populate
    // whenever the step's input changed, so filing a new row each time left an
    // encounter holding several drafts for the same visit: History listed each
    // as a separate claim, and submitting promoted only the newest -- leaving
    // live-looking draft siblings on an encounter that had already been billed.
    // Repointing the existing draft keeps it aimed at the artifact it was
    // actually built from.
    const existing = await repository.listClaimsForEncounter(encounterId);
    const draft = pickOriginalDraft(existing);
    if (draft) {
      await repository.updateClaimArtifact(draft.claimId, artifact.artifactId);
      return;
    }

    // No reusable original draft. If the encounter already has an original claim
    // that has left draft, the visit has been billed -- do not file a second
    // one (audit S1). The claim is still returned to the caller and its artifact
    // is still versioned; it just does not create a duplicate Claim row.
    if (hasBilledOriginal(existing)) {
      console.log(JSON.stringify({ type: "persist-skip", reason: "encounter already billed", encounterId }));
      return;
    }

    const created = await repository.createClaim({
      encounterId,
      artifactId: artifact.artifactId,
      claimType: "original",
      payerName: claim.payer?.name || "Unknown payer",
      memberId: claim.patient?.memberId || "Unknown member",
      providerId,
    });
    await recordAudit(repository, {
      providerId,
      entityType: "claim",
      entityId: created.claimId,
      action: "created",
      detail: `draft from ${artifact.artifactId}`,
    });
  } catch (err) {
    console.error(`Persisting draft claim for encounter '${encounterId}' failed:`, err);
  }
}

app.post("/api/populate-claim", async (req, res) => {
  const { facts, codes, providerId, encounterId } = req.body || {};

  if (!facts || typeof facts !== "object") {
    return res.status(400).json({ error: "Request body must include a 'facts' object (the extraction output)." });
  }
  if (!Array.isArray(codes)) {
    return res.status(400).json({ error: "Request body must include a 'codes' array (the code suggestions)." });
  }

  try {
    const providerProfile = getProviderProfile(providerId || DEFAULT_PROVIDER_ID);
    const context = await buildClaimContext(encounterId);
    const claim = populateClaim(facts, codes, providerProfile, context);
    const persistence = persistenceFailure(
      await persistArtifact(encounterId, "claim", claim, providerId || DEFAULT_PROVIDER_ID)
    );
    await persistClaimDraft(encounterId, claim, providerId || DEFAULT_PROVIDER_ID);
    res.json({ claim, persistence });
  } catch (err) {
    if (err instanceof ClaimError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Claim population failed:", err);
    res.status(500).json({ error: "Claim population failed. See server logs for details." });
  }
});

app.get("/api/usage", (_req, res) => {
  res.json(usageTotals());
});

app.get("/api/provider-profile", (req, res) => {
  const providerId = req.query.providerId || DEFAULT_PROVIDER_ID;
  const profile = getProviderProfile(providerId);
  res.json({ providerId, profile }); // profile is null if none is configured yet
});

app.get("/api/provider-profiles", (_req, res) => {
  res.json({ providerIds: listProviderProfiles() });
});

app.post("/api/provider-profile", (req, res) => {
  const { providerId, profile } = req.body || {};

  if (!profile || typeof profile !== "object") {
    return res.status(400).json({ error: "Request body must include a 'profile' object." });
  }

  try {
    const saved = upsertProviderProfile(providerId || DEFAULT_PROVIDER_ID, profile);
    res.json({ providerId: providerId || DEFAULT_PROVIDER_ID, profile: saved });
  } catch (err) {
    if (err instanceof ProviderProfileError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Saving provider profile failed:", err);
    res.status(500).json({ error: "Failed to save provider profile." });
  }
});

// Best-effort, same as persistArtifact. /api/populate-claim now files a
// draft Claim row already (see persistClaimDraft) -- reuse the most recent
// one instead of creating a sibling, so a normal draft-then-submit flow
// ends with one Claim row, not two. Only creates a fresh one as a fallback,
// for a claim submitted from an encounter old enough to predate that draft
// row, or if drafting it failed at the time.
// Its own best-effort write, so a failure here (say, the Notion column is
// missing) cannot stop the status and encounter updates around it. The
// submission artifact still holds the full payload if this is lost.
async function recordBilledAmount(claimId, amount) {
  try {
    await repository.setBilledAmount(claimId, amount);
  } catch (err) {
    console.error(`Recording the billed amount on claim '${claimId}' failed:`, err);
  }
}

async function persistSubmittedClaim(encounterId, claim, providerId, billedAmount) {
  if (!repository || !encounterId) return;
  try {
    const existingClaims = await repository.listClaimsForEncounter(encounterId);
    const draft = pickOriginalDraft(existingClaims);
    if (draft) {
      await repository.updateClaimStatus(draft.claimId, "submitted");
      await recordBilledAmount(draft.claimId, billedAmount);
      await recordAudit(repository, {
        providerId,
        entityType: "claim",
        entityId: draft.claimId,
        action: "status_changed",
        detail: "status: draft -> submitted",
      });
    } else {
      const artifact = await repository.getLatestArtifact(encounterId, "claim");
      if (artifact) {
        const created = await repository.createClaim({
          encounterId,
          artifactId: artifact.artifactId,
          claimType: "original",
          payerName: claim.payer?.name || "Unknown payer",
          memberId: claim.patient?.memberId || "Unknown member",
          providerId,
        });
        await recordAudit(repository, {
          providerId,
          entityType: "claim",
          entityId: created.claimId,
          action: "created",
          detail: `draft from ${artifact.artifactId} (filed at submission)`,
        });
        await repository.updateClaimStatus(created.claimId, "submitted");
        await recordBilledAmount(created.claimId, billedAmount);
        await recordAudit(repository, {
          providerId,
          entityType: "claim",
          entityId: created.claimId,
          action: "status_changed",
          detail: "status: draft -> submitted",
        });
      }
    }

    // A submitted claim means the visit itself is done, not just drafted.
    await repository.updateEncounterStatus(encounterId, "submitted");
  } catch (err) {
    console.error(`Persisting submitted claim for encounter '${encounterId}' failed:`, err);
  }
}

// The one way a claim leaves Ruby: sends it and files what was sent as a
// `submission` artifact on the encounter, whether Stedi took it or not.
function sendClaim(encounterId, stediClaim, kind, providerId) {
  return transmitClaim({
    stediClaim,
    kind,
    submit: (payload, idempotencyKey) => submitToStedi(payload, STEDI_API_KEY, idempotencyKey),
    persist: (content) => persistArtifact(encounterId, "submission", content, providerId),
  });
}

app.post("/api/submit-claim", async (req, res) => {
  const { claim, encounterId } = req.body || {};

  if (!claim || typeof claim !== "object") {
    return res.status(400).json({ error: "Request body must include a 'claim' object (the populated claim)." });
  }

  if (!STEDI_API_KEY) {
    return res.status(500).json({
      error: "STEDI_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  // The payer echoes CLP01 back on the remittance, so whatever goes out as the
  // claim control number is the only thread tying an 835 to the claim it
  // answers. buildStediClaim falls back to a throwaway `ruby-<timestamp>` when
  // the claim carries no id, which nothing can match later -- so send the real
  // one. Failing to find it degrades to that old behaviour rather than blocking
  // the submission.
  if (!claim.claimId) {
    const draft = await findDraftClaim(encounterId);
    if (draft) claim.claimId = draft.claimId;
  }

  let stediClaim;
  try {
    stediClaim = buildStediClaim(claim);
  } catch (err) {
    if (err instanceof StediMappingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Stedi claim mapping failed:", err);
    return res.status(500).json({ error: "Failed to map claim for Stedi submission." });
  }

  try {
    const providerId = resolveProviderId(req);
    const stediResponse = await sendClaim(encounterId, stediClaim, "original", providerId);
    await persistSubmittedClaim(encounterId, claim, providerId, billedAmountOf(stediClaim));
    res.json({ stediClaim, stediResponse });
  } catch (err) {
    if (err instanceof StediSubmissionError) {
      console.error("Stedi rejected submission:", JSON.stringify(err.details));
      return res.status(502).json({ error: err.message, details: err.details, stediClaim });
    }
    console.error("Stedi submission failed:", err);
    res.status(502).json({ error: "Stedi submission failed. See server logs for details.", stediClaim });
  }
});

// Step 7 of the denial loop: a corrected claim, chained to the one it
// replaces. Filed as its own Claim row (claimType "corrected", parentClaimId
// pointing at the original) so History shows the pair rather than the
// correction silently overwriting what was submitted before.
app.post("/api/claims/:claimId/resubmit", async (req, res) => {
  if (!requireRepository(res)) return;

  const { suggestedCodeChanges } = req.body || {};
  if (!Array.isArray(suggestedCodeChanges) || suggestedCodeChanges.length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'suggestedCodeChanges' array." });
  }

  if (!STEDI_API_KEY) {
    return res.status(500).json({
      error: "STEDI_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  try {
    const original = await repository.getClaim(req.params.claimId);
    if (!original) return res.status(404).json({ error: `No claim found with claim_id '${req.params.claimId}'.` });

    // Without this, the payer reads the resubmission as a brand-new claim
    // and denies it as a duplicate -- record the remittance first.
    if (!original.payerClaimControlNumber) {
      return res.status(400).json({
        error: "This claim has no payer claim control number on file yet. Record the payer's remittance before filing a correction.",
      });
    }

    const artifact = await repository.getLatestArtifact(original.encounterId, "claim");
    if (!artifact) {
      return res.status(400).json({ error: "No populated claim is on file for this encounter to correct." });
    }

    let correctedClaim;
    try {
      correctedClaim = buildCorrectedClaim(artifact.content, suggestedCodeChanges);
    } catch (err) {
      if (err instanceof CorrectedClaimError) return res.status(400).json({ error: err.message });
      throw err;
    }

    // The row is created before the payload is mapped, not after. The payer
    // echoes CLP01 back on the remittance, so buildStediClaim can only send
    // this claim's real id if the row already exists -- filing it afterwards
    // is why corrections went out as `ruby-<timestamp>` and came back
    // matching nothing.
    //
    // It is filed as a draft and promoted once Stedi accepts it, so a mapping
    // error or a rejected submission leaves the correction on the encounter
    // rather than no trace at all. That is the same reasoning as
    // persistClaimDraft on the original path, and #23's delete path can clear
    // a draft that never went anywhere.
    // A correction belongs to whoever billed the original. Only a claim from
    // before provider_id existed falls back to the request's provider.
    const correctionProviderId = original.providerId || resolveProviderId(req);
    const correctedArtifact = await repository.createArtifact({
      encounterId: original.encounterId,
      stage: "claim",
      content: correctedClaim,
      createdBy: "system",
      providerId: correctionProviderId,
    });
    const correctedClaimRow = await repository.createClaim({
      encounterId: original.encounterId,
      artifactId: correctedArtifact.artifactId,
      claimType: "corrected",
      parentClaimId: original.claimId,
      payerName: original.payerName,
      memberId: original.memberId,
      providerId: correctionProviderId,
    });
    await recordAudit(repository, {
      providerId: correctionProviderId,
      entityType: "claim",
      entityId: correctedClaimRow.claimId,
      action: "created",
      detail: `corrected claim of ${original.claimId}`,
    });

    let stediClaim;
    try {
      stediClaim = buildStediClaim(
        { ...correctedClaim, claimId: correctedClaimRow.claimId },
        {
          claimFrequencyCode: "7",
          originalReferenceNumber: original.payerClaimControlNumber,
        }
      );
    } catch (err) {
      if (err instanceof StediMappingError) return res.status(400).json({ error: err.message });
      throw err;
    }

    const stediResponse = await sendClaim(original.encounterId, stediClaim, "corrected", correctionProviderId);
    await repository.updateClaimStatus(correctedClaimRow.claimId, "submitted");
    await recordBilledAmount(correctedClaimRow.claimId, billedAmountOf(stediClaim));
    await recordAudit(repository, {
      providerId: correctionProviderId,
      entityType: "claim",
      entityId: correctedClaimRow.claimId,
      action: "status_changed",
      detail: "status: draft -> submitted",
    });

    res.json({ claim: correctedClaimRow, stediClaim, stediResponse });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof StediSubmissionError) {
      console.error("Stedi rejected the corrected claim:", JSON.stringify(err.details));
      return res.status(502).json({ error: err.message, details: err.details });
    }
    console.error("Filing a corrected claim failed:", err);
    res.status(502).json({ error: "Filing a corrected claim failed. See server logs for details." });
  }
});

// Step 8 of the denial loop: send the appeal, rather than leaving a drafted
// letter with nowhere to go. An appeal that stands behind the original coding
// reaches the payer as a frequency-7 claim referencing the original -- the
// same wire format as a correction, and the same submission path the first
// submission took.
//
// Two things the schema does not have and this endpoint works around rather
// than migrating: there is no "appeal" claim type (CLAIM_TYPES is original |
// corrected | secondary) and no "appeal" artifact stage, so the appeal is
// chained as a corrected claim and the letter rides along on the claim
// artifact. Both are Notion select options; widening them is a schema change,
// not a code change.
app.post("/api/claims/:claimId/appeal/submit", async (req, res) => {
  if (!requireRepository(res)) return;

  const { letterBody, needsReviewBeforeSending } = req.body || {};

  if (typeof letterBody !== "string" || !letterBody.trim()) {
    return res.status(400).json({ error: "Request body must include a non-empty 'letterBody'." });
  }

  // The draft flags quotes it could not find in the transcript. An appeal
  // quoting a record that does not say what it claims discredits the whole
  // letter, so the server refuses it rather than trusting the client to.
  if (needsReviewBeforeSending) {
    return res.status(400).json({
      error:
        "This draft has quotes that could not be found in the transcript. Fix or remove them before submitting the appeal.",
    });
  }

  if (!STEDI_API_KEY) {
    return res.status(500).json({
      error: "STEDI_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  try {
    const original = await repository.getClaim(req.params.claimId);
    if (!original) return res.status(404).json({ error: `No claim found with claim_id '${req.params.claimId}'.` });

    // Same guard as a corrected claim: without the payer's own control number
    // the payer reads this as a brand-new claim and denies it as a duplicate.
    if (!original.payerClaimControlNumber) {
      return res.status(400).json({
        error:
          "This claim has no payer claim control number on file yet. Record the payer's remittance before submitting an appeal.",
      });
    }

    const artifact = await repository.getLatestArtifact(original.encounterId, "claim");
    if (!artifact) {
      return res.status(400).json({ error: "No populated claim is on file for this encounter to appeal." });
    }

    // Created before the payload is mapped, for the same reason as the
    // correction path above: the claim's own id has to exist to be sent as
    // CLP01, and a failed submission should leave the appeal on the encounter
    // rather than nothing.
    //
    // The letter is the human-facing record of why this went back. It rides
    // on the claim artifact because there is no appeal stage to put it in.
    // Same rule as the correction path: the appeal is the original's provider's.
    const appealProviderId = original.providerId || resolveProviderId(req);
    const appealArtifact = await repository.createArtifact({
      encounterId: original.encounterId,
      stage: "claim",
      content: { ...artifact.content, appealLetter: letterBody, appealOfClaimId: original.claimId },
      createdBy: "system",
      providerId: appealProviderId,
    });
    const appealClaimRow = await repository.createClaim({
      encounterId: original.encounterId,
      artifactId: appealArtifact.artifactId,
      claimType: "corrected",
      parentClaimId: original.claimId,
      payerName: original.payerName,
      memberId: original.memberId,
      providerId: appealProviderId,
    });
    await recordAudit(repository, {
      providerId: appealProviderId,
      entityType: "claim",
      entityId: appealClaimRow.claimId,
      action: "created",
      detail: `appeal of ${original.claimId}`,
    });

    let stediClaim;
    try {
      stediClaim = buildStediClaim(
        { ...artifact.content, claimId: appealClaimRow.claimId },
        {
          claimFrequencyCode: "7",
          originalReferenceNumber: original.payerClaimControlNumber,
        }
      );
    } catch (err) {
      if (err instanceof StediMappingError) return res.status(400).json({ error: err.message });
      throw err;
    }

    const stediResponse = await sendClaim(original.encounterId, stediClaim, "appeal", appealProviderId);
    await repository.updateClaimStatus(appealClaimRow.claimId, "submitted");
    await recordBilledAmount(appealClaimRow.claimId, billedAmountOf(stediClaim));
    await recordAudit(repository, {
      providerId: appealProviderId,
      entityType: "claim",
      entityId: appealClaimRow.claimId,
      action: "status_changed",
      detail: "status: draft -> submitted",
    });

    res.json({ claim: appealClaimRow, stediClaim, stediResponse });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof StediSubmissionError) {
      console.error("Stedi rejected the appeal:", JSON.stringify(err.details));
      return res.status(502).json({ error: err.message, details: err.details });
    }
    console.error("Submitting the appeal failed:", err);
    res.status(502).json({ error: "Submitting the appeal failed. See server logs for details." });
  }
});

app.listen(PORT, () => {
  console.log(`Ruby Health demo backend listening on http://localhost:${PORT}`);
  console.log(`Claim path model: ${MODEL} | transcript cleanup: ${UTILITY_MODEL}`);
  if (!API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. /api/extract will return an error until it is configured.");
  }
});
