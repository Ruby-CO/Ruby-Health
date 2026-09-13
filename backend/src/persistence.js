// Whether to tell the provider their record didn't save.
//
// Its own module because server.js starts listening on import, so nothing in
// it can be unit tested -- and this is the function that decides whether a
// failed write is surfaced or stays silent. Getting it wrong in either
// direction is bad in a way that is hard to notice: warn when persistence was
// simply never attempted and every claim cries wolf; stay quiet on a real
// failure and the visit's record has a hole nothing mentions.

/**
 * @param {...(null|{stage: string, saved: boolean})} results One per attempted
 *   write. `null` means the write was never attempted -- no repository
 *   configured, or no encounter yet -- which is not a failure.
 * @returns {{saved: false, stages: string[], message: string}|undefined}
 *   undefined when nothing failed. JSON.stringify drops undefined keys, so the
 *   field is absent from the response rather than present and meaningless.
 */
export function persistenceFailure(...results) {
  const failed = results.filter((r) => r && !r.saved).map((r) => r.stage);
  if (failed.length === 0) return undefined;
  return {
    saved: false,
    stages: failed,
    message:
      `This step ran, but the ${failed.join(" and ")} could not be saved to the visit's record. ` +
      `Nothing was written. Check the server logs and run it again before relying on it.`,
  };
}
