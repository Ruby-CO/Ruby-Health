// Maps Ruby's internal claim object (the output of populateClaim.js) to the
// JSON body Stedi's Professional Claims (837P) endpoint expects.
//
// Deterministic. No model call, no network call -- pure data reshaping, so
// it's cheap to test and cheap to re-run if the mapping needs a tweak.
//
// Scope note: this fills what a synthetic/demo claim needs to round-trip
// through Stedi's sandbox and the Test Payer. It intentionally does not cover
// every optional field the 837P schema supports (COB, ambulance, DME, etc.)
// -- those are real payer scenarios this MVP doesn't need yet.

// Stedi's built-in Test Payer. Any sandbox claim sent here gets a real
// 277CA acknowledgment and a mock 835 back, with no payer enrollment step.
export const STEDI_TEST_PAYER_ID = "STEDI";

export class StediMappingError extends Error {
  constructor(message) {
    super(message);
    this.name = "StediMappingError";
  }
}

// Stedi wants ICD-10 codes without the decimal point (e.g. "J029" not "J02.9").
function stripDecimal(code) {
  return String(code ?? "").replace(".", "");
}

// Stedi's postal code wants digits only, no separators.
function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

// Stedi rejects SV1-01-07 (service line description) over 80 characters --
// an AI-suggested code description can run longer than that.
function truncate(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

// Stedi validates that a service line's date isn't later than its own
// internal transaction date -- computed in a timezone we don't control, so a
// service date of "today" in UTC can read as "tomorrow" to Stedi near UTC
// midnight. Capping at yesterday (UTC) sidesteps the ambiguity entirely:
// real-world UTC offsets span at most UTC-12 to UTC+14 (26 hours), so a date
// one full UTC day in the past is never later than "today" in any timezone.
function safeServiceDate(dateOfService) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const candidate = /^\d{4}-\d{2}-\d{2}/.test(dateOfService ?? "") ? dateOfService.slice(0, 10) : yesterday;
  return digitsOnly(candidate < yesterday ? candidate : yesterday);
}

/**
 * @param {object} claim   Output of populateClaim(facts, codes).
 * @param {object} [config] Overrides for the sandbox demo submitter/receiver.
 *   Falls back to values that work against Stedi's Test Payer out of the box.
 */
export function buildStediClaim(claim, config = {}) {
  if (!claim || !Array.isArray(claim.diagnoses) || !Array.isArray(claim.serviceLines)) {
    throw new StediMappingError("buildStediClaim requires a populated claim object with diagnoses and serviceLines.");
  }
  if (claim.diagnoses.length === 0) {
    throw new StediMappingError("Claim has no diagnoses -- Stedi requires at least one ABK (principal) diagnosis.");
  }
  if (claim.serviceLines.length === 0) {
    throw new StediMappingError("Claim has no service lines -- nothing to bill.");
  }

  const tradingPartnerServiceId = config.tradingPartnerServiceId || STEDI_TEST_PAYER_ID;

  // Diagnosis pointers on populateClaim's output are letters (A, B, C...).
  // Stedi's compositeDiagnosisCodePointers wants 1-based integers into the
  // healthCareCodeInformation array, in the same order this function builds it.
  const pointerLetterToIndex = new Map(claim.diagnoses.map((d, i) => [d.pointer, String(i + 1)]));

  const healthCareCodeInformation = claim.diagnoses.map((d, i) => ({
    diagnosisTypeCode: i === 0 ? "ABK" : "ABF", // first diagnosis is always the principal
    diagnosisCode: stripDecimal(d.code),
  }));

  const serviceLines = claim.serviceLines.map((line) => {
    const pointers = line.diagnosisPointers
      .split("")
      .map((letter) => pointerLetterToIndex.get(letter))
      .filter(Boolean);

    // populateClaim already flags an unlinked line as a warning; Stedi will
    // reject it outright since compositeDiagnosisCodePointers is required.
    // Fall back to the principal diagnosis so a demo claim still submits,
    // and let the existing warning stand as the signal a reviewer should fix.
    const diagnosisCodePointers = pointers.length > 0 ? pointers : ["1"];

    return {
      professionalService: {
        procedureIdentifier: "HC", // HCPCS/CPT
        procedureCode: line.code,
        lineItemChargeAmount: config.chargeAmountPerLine ?? "100.00",
        measurementUnit: "UN",
        serviceUnitCount: String(line.units ?? 1),
        compositeDiagnosisCodePointers: { diagnosisCodePointers },
        description: truncate(line.description, 80),
      },
      // Required by Stedi -- every line needs its own service date, even
      // though every line in this MVP happens on the same encounter date.
      // A sibling of professionalService, not a field inside it -- Stedi's
      // schema rejects it in the wrong spot with an "unknown field" error.
      serviceDate: safeServiceDate(claim.dateOfService),
    };
  });

  const claimChargeAmount = (
    serviceLines.length * Number(config.chargeAmountPerLine ?? 100)
  ).toFixed(2);

  return {
    tradingPartnerServiceId,
    submitter: {
      organizationName: config.submitterName || "Ruby Health Demo",
      contactInformation: {
        name: config.submitterName || "Ruby Health Demo",
        phoneNumber: digitsOnly(config.submitterPhone) || "5555550100",
      },
    },
    receiver: {
      organizationName: config.receiverName || "Stedi Test Payer",
    },
    subscriber: {
      memberId: claim.patient?.memberId || "SAMPLE0001",
      paymentResponsibilityLevelCode: "P", // primary payer
      firstName: (claim.patient?.name || "Sample Patient").split(" ")[0],
      lastName: (claim.patient?.name || "Sample Patient").split(" ").slice(1).join(" ") || "Patient",
      gender: claim.patient?.sex === "M" || claim.patient?.sex === "F" ? claim.patient.sex : "U",
      dateOfBirth: digitsOnly(claim.patient?.dob) || "19900101",
      address: {
        address1: "123 Main St",
        city: "Sample City",
        state: "CA",
        postalCode: "900010000",
      },
    },
    providers: [
      {
        providerType: "BillingProvider",
        npi: digitsOnly(claim.provider?.npi) || "1999999984", // Stedi's published test NPI
        // The billing provider the payer sees is the practice, not the clinician.
        // `organization` carries it; a profile saved before that field existed
        // put the practice name in `name`, so that is the fallback rather than
        // a placeholder.
        organizationName: claim.provider?.organization || claim.provider?.name || "Ruby Health Demo Practice",
        employerId: claim.provider?.ein || config.billingProviderEin || "123456789",
        taxonomyCode: claim.provider?.taxonomyCode,
        // A real provider profile carries a structured address; the pre-profile
        // placeholder carries a single string. Fall back to sample values only
        // when nothing usable is present -- same "never silently fake it further
        // than the warning already flagged" posture as populateClaim.js.
        address:
          claim.provider?.address && typeof claim.provider.address === "object"
            ? claim.provider.address
            : { address1: "123 Main St", city: "Sample City", state: "CA", postalCode: "900010000" },
      },
    ],
    claimInformation: {
      claimFilingCode: config.claimFilingCode || "CI", // Commercial Insurance
      patientControlNumber: (claim.claimId || `ruby-${Date.now()}`).slice(0, 17),
      claimChargeAmount,
      placeOfServiceCode: config.placeOfServiceCode || "11", // Office
      // 1 = original claim, 7 = replacement/corrected claim (X12 CLM05-3).
      claimFrequencyCode: config.claimFrequencyCode || "1",
      // Required alongside frequency code 7 -- without it the payer reads a
      // correction as a brand-new claim and denies it as a duplicate. Stedi
      // carries the original Payer Claim Control Number (X12 REF*F8) as
      // claimSupplementalInformation.claimControlNumber, not a top-level
      // field; sending it flat returns HTTP 400 "unknown field". Verified
      // against Stedi's OpenAPI schema and a live sandbox resubmission.
      ...(config.originalReferenceNumber
        ? { claimSupplementalInformation: { claimControlNumber: config.originalReferenceNumber } }
        : {}),
      planParticipationCode: "A", // assigned
      benefitsAssignmentCertificationIndicator: "Y",
      releaseInformationCode: "Y",
      signatureIndicator: "Y", // provider signature on file -- standard for an encounter that already happened
      healthCareCodeInformation,
      serviceLines,
    },
    // Demo/sandbox marker -- makes it obvious in logs this never touched a real payer.
    usageIndicator: "T",
  };
}
