// Turns a payer's 835 remittance advice into Ruby's own adjudication shape.
//
// Deterministic. No model call, no lookups, no judgement -- this only restates
// what the payer sent in a shape the rest of the app can work with. Explaining
// the reason codes is analyzeRemittance.js's job, and what to *do* about them
// is a decision that comes after that.
//
// The input is a raw X12 835 document (a string), not JSON. That was
// confirmed against Stedi's real sandbox on 2026-09-08: their "835 ERAs"
// view hands back the actual EDI text, not a vendor-shaped JSON payload --
// which is better ground to build on than a guess would have been, since
// X12 835 is a fixed national standard (HIPAA 005010X221A1) rather than one
// company's schema that could change under us. The segment/element
// positions below are read directly off a real Stedi Test Payer remittance
// for a fully-paid claim; a real *denial* has never been seen (Stedi's test
// payer only ever pays in full or sends nothing at all -- see
// docs/mvp-v1-build-plan.html's sibling denial-loop notes), so the CAS
// (adjustment) and LQ (remark code) parsing below follows the published
// 835 spec rather than a confirmed real denied example. If a real denial
// payload ever turns up looking different, this is the one file to fix.

export class RemittanceParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemittanceParseError";
  }
}

// CLP02. The payer's own verdict on the claim, which beats anything we could
// infer from the amounts. Code "1" is confirmed against a real Stedi
// response (rendered in their UI as "Processed as primary").
const CLAIM_STATUS_CODES = {
  1: "paid", // processed as primary
  2: "paid", // processed as secondary
  3: "paid", // processed as tertiary
  4: "denied",
  19: "forwarded", // processed as primary, forwarded to additional payer
  20: "forwarded",
  21: "forwarded",
  22: "reversed", // reversal of a previous payment
  23: "not_our_claim",
  25: "predetermination",
};

// 835 amounts arrive as plain decimal strings. Rounding to cents on the way
// in keeps float drift out of every later comparison -- "paid < billed"
// deciding a claim was underpaid by 0.000000001 would be a silly way to open
// an appeal.
export function money(value) {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function formatX12Date(raw) {
  const s = String(raw ?? "");
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

// The ISA segment is the one place X12 declares its own punctuation, so a
// document is self-describing rather than assumed to use "*"/"~" -- Stedi's
// own remittances use "`" as the component separator, not the ":" seen in
// most textbook examples, which is exactly why this reads it off the
// document instead of hardcoding a guess.
function detectDelimiters(text) {
  if (text.slice(0, 3) !== "ISA") {
    throw new RemittanceParseError("Not an X12 document -- expected it to start with an ISA segment.");
  }
  const elementSep = text[3];
  // ISA01-ISA15 are 15 elements; splitting what follows "ISA<sep>" by that
  // separator leaves ISA16 (always exactly one character: the component
  // separator) fused to the segment terminator and everything after it.
  const parts = text.slice(4).split(elementSep);
  if (parts.length < 16) {
    throw new RemittanceParseError("Malformed ISA segment -- expected 16 elements.");
  }
  const isa16Plus = parts[15];
  return { elementSep, componentSep: isa16Plus[0], segmentTerm: isa16Plus[1] };
}

function splitSegments(text, elementSep, segmentTerm) {
  return text
    .split(segmentTerm)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(elementSep));
}

// One CAS segment carries a group code, then up to six (reason, amount,
// quantity) triples -- quantity is optional and unused here.
function parseCasTriples(els) {
  const groupCode = els[0] || "";
  const adjustments = [];
  for (let i = 1; i + 1 < els.length; i += 3) {
    const reasonCode = els[i];
    if (!reasonCode) break;
    adjustments.push({ groupCode, reasonCode, amount: money(els[i + 1]) });
  }
  return adjustments;
}

// The payer's own status code wins when we have one. Inferring from amounts
// is the fallback, and it is genuinely ambiguous: a claim paid at zero
// because the whole charge went to the deductible is not "denied", even
// though the provider received nothing.
function resolveStatus(statusCode, totals, adjustments) {
  const mapped = CLAIM_STATUS_CODES[Number(statusCode)];
  if (mapped) return mapped;

  if (totals.paid > 0) return totals.paid < totals.billed ? "partially_paid" : "paid";
  const allPatientResponsibility = adjustments.length > 0 && adjustments.every((a) => a.groupCode === "PR");
  if (allPatientResponsibility) return "patient_responsibility";
  return adjustments.length > 0 ? "denied" : "unknown";
}

/**
 * @param {string|{x12: string}} remittance  A raw X12 835 document, or an
 *   object carrying one under an `x12` property (the shape Stedi's own 837P
 *   submission responses already use, in case an 835-retrieval API turns out
 *   to wrap the document the same way).
 * @returns {object[]} one adjudication per CLP (claim) loop in the document,
 *   in document order.
 */
export function parseRemittance(remittance) {
  const text = typeof remittance === "string" ? remittance : remittance?.x12;
  if (!text || typeof text !== "string" || !text.trim()) {
    throw new RemittanceParseError("A remittance document must be a raw X12 835 string (or an object with an 'x12' property).");
  }

  const { elementSep, segmentTerm } = detectDelimiters(text.trim());
  const segments = splitSegments(text.trim(), elementSep, segmentTerm);

  if (!segments.some((s) => s[0] === "ST" && s[1] === "835")) {
    throw new RemittanceParseError("Not an 835 remittance advice -- no ST*835 transaction set header found.");
  }

  let payerName = null;
  let remittanceDate = null;
  let traceNumber = null;
  let n1Context = null;

  const claims = [];
  let current = null;
  let currentLine = null;

  const closeLine = () => {
    if (currentLine) current.lines.push(currentLine);
    currentLine = null;
  };
  const closeClaim = () => {
    closeLine();
    if (current) claims.push(current);
    current = null;
  };

  for (const [id, ...els] of segments) {
    switch (id) {
      case "TRN":
        // TRN02 -- reassociation trace number, present once at the document level.
        traceNumber = traceNumber || els[1] || null;
        break;
      case "DTM":
        if (els[0] === "405") remittanceDate = formatX12Date(els[1]);
        break;
      case "N1":
        n1Context = els[0];
        if (els[0] === "PR") payerName = els[1] || payerName;
        break;
      case "CLP":
        closeClaim();
        current = {
          patientControlNumber: els[0] || "",
          claimStatusCode: els[1] || null,
          totals: { billed: money(els[2]), paid: money(els[3]), patientResponsibility: money(els[4]) },
          payerClaimControlNumber: els[6] || null,
          claimAdjustments: [],
          lines: [],
          remarkCodes: [],
        };
        break;
      case "CAS": {
        if (!current) break; // a CAS outside any claim loop isn't one this app tracks
        const adjustments = parseCasTriples(els);
        if (currentLine) currentLine.adjustments.push(...adjustments);
        else current.claimAdjustments.push(...adjustments);
        break;
      }
      case "SVC": {
        if (!current) break;
        closeLine();
        const [qualifier, procCode] = splitComposite(els[0]);
        currentLine = {
          procedureCode: procCode || qualifier || "",
          modifiers: [],
          units: Number(els[4]) || 1,
          billed: money(els[1]),
          paid: money(els[2]),
          adjustments: [],
          remarkCodes: [],
        };
        break;
      }
      case "LQ":
        // LQ*HE*<remark code> -- a Health Care Remark Code, attached to
        // whichever loop (claim or the service line just closed/open) it
        // trails.
        if (els[0] === "HE" && els[1]) (currentLine || current)?.remarkCodes.push(els[1]);
        break;
      default:
        break;
    }
  }
  closeClaim();

  return claims.map((c) => {
    const everyAdjustment = [...c.claimAdjustments, ...c.lines.flatMap((l) => l.adjustments)];
    return {
      // CLP01 -- the claim control number Ruby sent on the 837P, echoed back.
      // It is what identifies which claim this remittance answers; dropping it
      // here is why filing an 835 needed a human to name the claim.
      patientControlNumber: c.patientControlNumber,
      payerClaimControlNumber: c.payerClaimControlNumber,
      claimStatusCode: c.claimStatusCode,
      status: resolveStatus(c.claimStatusCode, c.totals, everyAdjustment),
      payerName,
      remittanceDate,
      traceNumber,
      totals: c.totals,
      claimAdjustments: c.claimAdjustments,
      lines: c.lines,
      remarkCodes: c.remarkCodes,
    };
  });
}

// SVC01 is a composite element: a qualifier ("HC" for HCPCS/CPT) joined to
// the actual code by the document's component separator. detectDelimiters()
// already read that separator once; re-deriving it per composite field
// would be redundant, so this just splits on the one character X12 permits
// here (":" in the textbook examples, "`" on Stedi's own documents) by
// trying both -- a composite element never legitimately contains either.
function splitComposite(value) {
  const raw = String(value ?? "");
  for (const sep of [":", "`"]) {
    if (raw.includes(sep)) {
      const [qualifier, code] = raw.split(sep);
      return [qualifier, code];
    }
  }
  return [null, raw];
}
