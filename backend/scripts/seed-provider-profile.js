// One-time seed for a single hardcoded provider profile, so the pipeline has
// a real NPI to submit with today -- without building the provider account
// system (login, per-user profile UI) that's the real next step.
//
// Run with: node scripts/seed-provider-profile.js
//
// Uses Stedi's own published test NPI (it appears in their official 837P raw
// X12 example) rather than a made-up number. Stedi's sandbox still validates
// the NPI checksum, so a random 10-digit string can get rejected before the
// claim ever reaches the Test Payer -- a known-good test NPI avoids that.

import { upsertProviderProfile, DEFAULT_PROVIDER_ID } from "../src/providerProfiles.js";

// Exported so other scripts (e.g. smoke-stedi.js) can seed the same demo
// profile on demand without duplicating it or re-running this file's CLI output.
export const DEMO_PROVIDER_PROFILE = {
  // The clinician, and separately the practice that bills. Only `organization`
  // reaches the payer (as the billing provider's organizationName); `name` is
  // for the humans reading the profile screen. Both synthetic.
  name: "Dana Whitfield, MD",
  organization: "Ruby Health Demo Practice",
  npi: "1999999984", // Stedi's published test NPI
  // Enrolled with the Stedi Test Payer for 835 Claim payment (see
  // reference/../docs -- providers-test-claims-workflow) under this exact
  // tax ID. A claim must carry the tax ID it was enrolled with to generate
  // a test 835 ERA; the old "123456789" placeholder was never enrolled with
  // anything and is exactly the kind of value likely to collide with other
  // Stedi accounts' test data anyway.
  ein: "462871953",
  taxonomyCode: "207Q00000X", // Family Medicine
  address: {
    address1: "500 Health Way",
    city: "Springfield",
    state: "IL",
    postalCode: "627010000",
  },
};

// Guarded so importing DEMO_PROVIDER_PROFILE elsewhere doesn't also reseed
// and print -- only running this file directly does.
if (import.meta.url === `file://${process.argv[1]}`) {
  const saved = upsertProviderProfile(DEFAULT_PROVIDER_ID, DEMO_PROVIDER_PROFILE);
  console.log(`Seeded provider profile for '${DEFAULT_PROVIDER_ID}':`);
  console.log(JSON.stringify(saved, null, 2));
}
