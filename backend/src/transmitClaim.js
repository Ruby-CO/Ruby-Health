// Every 837P Ruby sends goes through here, so a copy of exactly what left the
// building is kept whatever happened to it. The claim artifact is what Ruby
// *drafted*; buildStediClaim adds the charges, frequency code, control number
// and the rest on the way out, so the draft alone cannot answer "what did we
// bill, and for how much?" (audit C5, tracked as C3 in Notion).
//
// A refused or undelivered send is kept too. "We tried to send this and it was
// refused" is part of the claim's history, and before this it left no trace
// but a console line.

import { StediSubmissionError } from "./pipeline/submitToStedi.js";

// What happened to the send, from Ruby's side of the wire. "sent" means Stedi
// took it -- not that the payer has accepted anything; that arrives later.
export const TRANSMISSION_OUTCOMES = ["sent", "rejected", "error"];

// The total the 837P bills, as a number. Stedi takes it as a string.
export function billedAmountOf(stediClaim) {
  return Number(stediClaim?.claimInformation?.claimChargeAmount) || 0;
}

// The audit line for one send: enough to read the trail without opening the
// artifact, and the artifact id to open when that is not enough. A send whose
// record failed to save says so rather than pointing nowhere.
export function describeTransmission(record, artifactId) {
  const what = { sent: "837P sent", rejected: "837P refused by Stedi", error: "837P send failed" }[record.outcome] || "837P";
  const where = artifactId ? `as ${artifactId}` : "record not saved";
  const amount = `$${Number(record.billedAmount || 0).toFixed(2)}`;
  return `${what} · ${where} · ${amount} · ${record.kind} (frequency ${record.frequencyCode || "?"})`;
}

/**
 * Sends a mapped claim and records the transmission, then behaves exactly like
 * `submit`: resolves with Stedi's response or rethrows its error.
 *
 * @param {object} args
 * @param {object} args.stediClaim  Output of buildStediClaim().
 * @param {string} args.kind        "original" | "corrected" | "appeal"
 * @param {(stediClaim: object, idempotencyKey: string) => Promise<object>} args.submit
 * @param {(content: object) => Promise<unknown>} args.persist  Files the
 *   record; best-effort like every other persist, so it must not throw.
 * @param {() => Date} [args.now]
 */
export async function transmitClaim({ stediClaim, kind, submit, persist, now = () => new Date() }) {
  const claimInformation = stediClaim?.claimInformation || {};
  // Minted here rather than inside submit so the record names the same key
  // Stedi saw -- the handle for asking Stedi about this send later.
  const idempotencyKey = `ruby-${now().getTime()}-${Math.random().toString(36).slice(2, 10)}`;
  const record = {
    // The id the payer will echo back as CLP01, read off the payload itself:
    // this is what was sent, not what the claim row thinks it is.
    claimId: claimInformation.patientControlNumber || "",
    kind,
    frequencyCode: claimInformation.claimFrequencyCode || "",
    billedAmount: billedAmountOf(stediClaim),
    sentAt: now().toISOString(),
    idempotencyKey,
    payload: stediClaim,
  };

  try {
    const response = await submit(stediClaim, idempotencyKey);
    await persist({ ...record, outcome: "sent", response: response ?? null, error: null });
    return response;
  } catch (err) {
    const rejected = err instanceof StediSubmissionError;
    await persist({
      ...record,
      outcome: rejected ? "rejected" : "error",
      response: null,
      error: { message: err.message, details: rejected ? err.details ?? null : null },
    });
    throw err;
  }
}
