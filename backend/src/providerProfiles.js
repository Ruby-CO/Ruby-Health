// Provider profile store.
//
// Every claim needs the billing provider's NPI, tax ID, taxonomy code, and
// address (see populateClaim.js / buildStediClaim.js) -- that data belongs to
// the provider, not to any one encounter, so it's captured once and looked up
// per claim instead of re-entered or hardcoded.
//
// Keyed by providerId from day one even though the MVP only has one provider.
// A single-tenant flat file and a multi-tenant DB table hold the exact same
// shape of record -- the only thing that changes later is where get/upsert
// read and write from, not any of the calling code in populateClaim.js or
// server.js. That's the point of keying it now.
//
// Storage: a JSON file on disk. This is an MVP choice, not a production one --
// Render's disk is ephemeral, so a profile saved here will not survive a
// redeploy. The production architecture already calls for AWS RDS; this
// module is the seam where that swap happens without touching call sites.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH =
  process.env.PROVIDER_PROFILES_PATH || path.join(__dirname, "..", "data", "provider-profiles.json");

export const DEFAULT_PROVIDER_ID = "default";

export class ProviderProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderProfileError";
  }
}

function load() {
  if (!existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch (err) {
    console.error(`Failed to read provider profile store at ${STORE_PATH}:`, err);
    return {};
  }
}

function save(store) {
  mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

const REQUIRED_FIELDS = ["name", "npi"];

function validate(profile) {
  for (const field of REQUIRED_FIELDS) {
    if (!profile?.[field] || typeof profile[field] !== "string") {
      throw new ProviderProfileError(`Provider profile requires a non-empty '${field}' field.`);
    }
  }
  if (!/^\d{10}$/.test(profile.npi)) {
    throw new ProviderProfileError("Provider NPI must be exactly 10 digits.");
  }
  // Optional rather than required: profiles saved before `organization` existed
  // carry the billing entity in `name`, and buildStediClaim still reads it from
  // there. Rejecting those on re-save would lock an existing profile out of
  // being edited at all.
  if (profile.organization !== undefined && typeof profile.organization !== "string") {
    throw new ProviderProfileError("Provider organization must be a string.");
  }
  // A tax ID reaches the payer as the employer ID (X12 REF*EI), which is nine
  // digits. A hyphenated "46-2871953" is the shape a human writes it in and the
  // shape the payer rejects, so it is refused here rather than at submission.
  if (profile.ein !== undefined && profile.ein !== "" && !/^\d{9}$/.test(profile.ein)) {
    throw new ProviderProfileError("Provider tax ID must be exactly 9 digits, with no hyphen.");
  }
}

/** @returns {object|null} The profile, or null if none is configured for this ID. */
export function getProviderProfile(providerId = DEFAULT_PROVIDER_ID) {
  const store = load();
  return store[providerId] || null;
}

export function listProviderProfiles() {
  return Object.keys(load());
}

/**
 * Create or replace a provider's profile.
 * @param {string} providerId
 * @param {object} profile  { name, organization?, npi, ein?, ssn?, taxonomyCode?,
 *   phone?, address: { address1, address2?, city, state, postalCode } }
 *
 * `name` is the clinician; `organization` is the billing entity the payer sees.
 * They were one field originally -- see buildStediClaim.js for how a profile
 * predating the split is still read correctly.
 */
export function upsertProviderProfile(providerId, profile) {
  if (!providerId || typeof providerId !== "string") {
    throw new ProviderProfileError("upsertProviderProfile requires a non-empty providerId.");
  }
  validate(profile);

  const store = load();
  store[providerId] = profile;
  save(store);
  return profile;
}
