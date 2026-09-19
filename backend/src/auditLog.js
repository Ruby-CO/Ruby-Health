// The one door into the audit log.
//
// Every log write in the app goes through recordAudit, and recordAudit never
// throws. That is the whole contract: the log describes a claim or artifact
// write that has already happened (or already failed), and it must not become
// a second way for that write to fail -- least of all inside persistArtifact,
// which already has one silent-failure problem the audit flagged. A log
// failure is shouted to the console with the entry it lost, and the caller
// carries on. Visibility, not a dependency.

/**
 * @param {import("./repository/Repository.js").Repository|null} repository
 * @param {{ providerId: string, entityType: "claim"|"artifact", entityId?: string,
 *   action: string, detail?: string }} entry
 * @returns {Promise<boolean>} true when a row was written
 */
export async function recordAudit(repository, entry) {
  // No repository configured is the no-persistence dev setup, not an error.
  if (!repository) return false;
  try {
    await repository.createLogEntry(entry);
    return true;
  } catch (err) {
    // Loud on purpose. The entry is printed in full so the trail can be
    // reconstructed by hand from the server log if the store was unreachable.
    console.error("AUDIT LOG WRITE FAILED -- entry lost:", JSON.stringify(entry), err);
    return false;
  }
}
