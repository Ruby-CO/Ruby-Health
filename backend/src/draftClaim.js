// Picking a visit's working draft claim.
//
// One encounter can hold several claim rows: the original, plus any corrected
// or appeal claims a denial produced. A corrected/appeal claim is filed as a
// draft before it goes to Stedi, so a failed resubmission leaves a `corrected`
// draft on the encounter. The New Claim path (populate, submit) must never
// adopt that as the visit's working claim -- repointing it at a fresh original
// artifact, or promoting it to submitted, would give a correction an original's
// data while it still points at its parent.
//
// So the working draft is the most recent *original* draft, and nothing else.
export function pickOriginalDraft(claims) {
  if (!Array.isArray(claims)) return null;
  return [...claims].reverse().find((c) => c.status === "draft" && c.claimType === "original") || null;
}

// True when the encounter already carries an original claim that has left draft
// -- i.e. it has been billed. Once that is so, populating the claim again must
// not file a *second* original on the same visit: that would put two claims for
// one encounter in front of the payer. (This is the mirror of pickOriginalDraft:
// that one stops a corrected draft being adopted; this one stops a second
// original being minted after the first was submitted.)
export function hasBilledOriginal(claims) {
  if (!Array.isArray(claims)) return false;
  return claims.some((c) => c && c.claimType === "original" && c.status !== "draft");
}
