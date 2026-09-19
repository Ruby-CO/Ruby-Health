// Entry point for the persistence layer. Application code should import
// from here (or receive a Repository instance some other way) -- never
// import NotionRepository or @notionhq/client directly outside this
// directory. See Repository.js for why that boundary matters.

import { Client } from "@notionhq/client";
import { NotionRepository } from "./NotionRepository.js";
import { LocalDiskBlobStore } from "./LocalDiskBlobStore.js";

export { Repository, BlobStore, NotImplementedError } from "./Repository.js";
export { NotionRepository, NotionRepositoryError } from "./NotionRepository.js";
export { LocalDiskBlobStore, BlobStoreError } from "./LocalDiskBlobStore.js";

/** Builds a NotionRepository from the standard backend/.env variables. */
export function createNotionRepositoryFromEnv(env = process.env) {
  const apiKey = env.NOTION_API_KEY;
  const patientsDataSourceId = env.NOTION_PATIENTS_DATA_SOURCE_ID;
  const casesDataSourceId = env.NOTION_CASES_DATA_SOURCE_ID;
  const encountersDataSourceId = env.NOTION_ENCOUNTERS_DATA_SOURCE_ID;
  const artifactsDataSourceId = env.NOTION_ARTIFACTS_DATA_SOURCE_ID;
  const claimsDataSourceId = env.NOTION_CLAIMS_DATA_SOURCE_ID;
  const documentsDataSourceId = env.NOTION_DOCUMENTS_DATA_SOURCE_ID;
  // Deliberately not in the required list below. It arrived with the denial
  // loop, after the other six were already configured everywhere -- making it
  // mandatory would take persistence down entirely on any deploy that hasn't
  // added it yet. Payer-feedback methods throw a clear config error instead.
  const payerFeedbackDataSourceId = env.NOTION_PAYER_FEEDBACK_DATA_SOURCE_ID;
  // Optional for the same reason. Without it, log writes are skipped with a
  // console warning (see auditLog.js) and nothing else changes.
  const auditLogDataSourceId = env.NOTION_AUDIT_LOG_DATA_SOURCE_ID;

  const missing = [
    !apiKey && "NOTION_API_KEY",
    !patientsDataSourceId && "NOTION_PATIENTS_DATA_SOURCE_ID",
    !casesDataSourceId && "NOTION_CASES_DATA_SOURCE_ID",
    !encountersDataSourceId && "NOTION_ENCOUNTERS_DATA_SOURCE_ID",
    !artifactsDataSourceId && "NOTION_ARTIFACTS_DATA_SOURCE_ID",
    !claimsDataSourceId && "NOTION_CLAIMS_DATA_SOURCE_ID",
    !documentsDataSourceId && "NOTION_DOCUMENTS_DATA_SOURCE_ID",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing Notion repository config: ${missing.join(", ")}. Set these in backend/.env.`);
  }

  return new NotionRepository({
    client: new Client({ auth: apiKey }),
    patientsDataSourceId,
    casesDataSourceId,
    encountersDataSourceId,
    artifactsDataSourceId,
    claimsDataSourceId,
    documentsDataSourceId,
    payerFeedbackDataSourceId,
    auditLogDataSourceId,
  });
}

/** Builds the demo BlobStore. Swap for an Aptible-backed one in production. */
export function createBlobStoreFromEnv(env = process.env) {
  return new LocalDiskBlobStore(env.BLOB_STORE_DIR ? { baseDir: env.BLOB_STORE_DIR } : {});
}
