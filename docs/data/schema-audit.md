<!-- audit-meta
{"runAt":"2026-09-22T02:48:48Z","commit":"dcf9707","introspection":"code-only","label":"P2 merge, truncation guard moved","headline":"The P2 extract+code merge closed the merged stage's truncation gap, but populating again after a visit is billed still files a second original claim, and the appeal stage remains the one unguarded call whose output is stored and sent."}
-->

# Ruby Health — data model audit

**Date:** 2026-09-22
**Commit:** `dcf9707`
**Introspection mode:** code-derived (live Notion schema not verified this run).
The doctrine asks for a live-verified run and it was attempted: `backend/.env`
exists and its `NOTION_*_DATA_SOURCE_ID` lines are set, but the dedicated
`notion-fetch` / `notion-search` tools are not present in this session, and a
direct Notion API probe returned **HTTP 401** with no way to supply a valid
token — the API key is deliberately sandbox-blocked (credential
materialization is denied), which is the environment doing exactly what it
should. So the ERD reflects `NotionRepository.js`, not a verified live
database. Where the 2026-09-19 live run recorded something the code does not
declare, it is marked as such rather than restated as fact. The ERD was
verified to parse with `mermaid.parse()`.

**Companion files:** `SCHEMA.md` (what the model is meant to be),
`schema.mermaid` (the picture). This file is the distance between them.

---

## Summary

`NotionRepository.js` is byte-for-byte unchanged since the last audit, so the
**store's shape did not move this cycle** — no new database, no new property, no
new vocabulary. What changed is the pipeline that fills it: P2 merged extraction
and coding into a single model call (`extractAndCode.js`) and retired the
transcript rewrite in favour of a short reviewer brief (`cleanupTranscript.js`).
Two consequences reach this audit. First, the merged extract+code stage now
throws on a truncated response (`extractAndCode.js:209`), which closes the
truncation gap on the busiest call — so the remaining unguarded stage whose
output is *both stored and sent to a payer* is now the appeal draft, alone.
Second, the brief is a new model output with no home in the schema.

The store's own risks are carried forward, because the store did not change.
The sharpest remains that once a visit's original claim is submitted,
populating again files a **second `original` claim** on the same encounter, and
nothing stops that one being submitted too — one visit, two claims to the
payer. This is distinct from the "adopt a stuck corrected draft" bug, which
`pickOriginalDraft` (commit 959d585) does fix and which this audit confirms is
gone. The audit log added last cycle is still unauthenticated (its actor is
whatever the request body said) and still incomplete (four write paths change
the record without logging it).

Thirty-seven findings below: ten high, twenty medium, seven low. One is new
this cycle (M8, the unstored brief). The truncation finding (M2) narrowed but
did not close — it moved from "the stored-and-sent stage is unguarded" to "the
*appeal* stage is the one unguarded stored-and-sent stage." Everything else is
carried forward, verified against the code on this checkout rather than inferred
from commit messages. Read **S1**, **C5** and **M2** first.

Because this run is code-only, the most valuable class of finding — a property
that exists in Notion and not in the code, or the reverse — could not be looked
for. The last live run (2026-09-19) found none, and the code has not touched the
repository since, so the risk of undetected drift this cycle is low but not
zero (a human could have edited a Notion property by hand).

---

## 1. Structural risks

### S1. Populating a claim again after the visit was billed files a second original claim

- **What:** `persistClaimDraft` reuses an existing claim row only when it finds
  an *original draft*. Once the encounter's original claim has been submitted
  there is no draft to find, so the next populate on that same encounter creates
  a brand-new `original` claim row for a visit that has already been billed.
- **Where:** `backend/src/server.js:850-887` (`persistClaimDraft`, the
  create-new branch at `:869-876`) and `backend/src/draftClaim.js:12-15`
  (`pickOriginalDraft`, which matches `status === "draft" && claimType ===
  "original"`), against `server.js:956-1004` (`persistSubmittedClaim`, which
  leaves the original at `submitted`) and `:1006-1053` (`/api/submit-claim`,
  which checks nothing about the encounter).
- **Severity:** high
- **Why it matters:** The New Claim session keeps its `encounterId` after
  submitting, and walking back into the Claim step re-runs populate whenever
  that step's input has changed. So editing the context or the codes after
  submitting — the ordinary thing a provider does when they notice something —
  files a second original claim against the billed encounter, and because that
  row is a `draft`, `pickOriginalDraft` will hand it to the next submission as
  the visit's working claim. Both go out with `claimFrequencyCode: "1"` under
  different `claim_id`s, so the payer sees two original claims for one encounter
  rather than a correction. This is the mirror of the bug 959d585 closed: that
  taught the picker to ignore a `corrected` draft it should not adopt; this is
  the case where there is no draft at all and a new one is minted.
- **Proposed change:** Have `persistClaimDraft` look at every claim on the
  encounter, not just the drafts: if one has left `draft`, either refuse to file
  a second original (the populated claim is still safely stored as an artifact)
  or file it as a `corrected` claim chained to the submitted one, which is what
  it actually is. Add the same check to `/api/submit-claim` so the guard does
  not live only in the draft-filing path. Helper and route changes, no schema
  change, no migration — but existing encounters should be scanned once for more
  than one `original` claim.

### S2. Sequential IDs are minted without atomicity, and reads resolve a collision silently

- **What:** Two overlapping creates in the same database scan the same maximum
  title and mint the same ID; `_findByTitle` then returns whichever row the
  query happens to put first.
- **Where:** `backend/src/repository/NotionRepository.js:850`
  (`_nextSequentialId`) and `:821` (`_findByTitle`, `page_size: 1`).
- **Severity:** high
- **Why it matters:** Every foreign key in this schema is the business ID
  string. Two `E007` rows make every artifact, claim, feedback and log row
  pointing at `E007` ambiguous, and nothing raises — `getEncounter` returns one
  of them and the visit's record silently splits in half. The demo is
  single-user, so this needs two requests in flight at once, which the New Claim
  page does whenever a stage cascade overlaps a manual action. The audit log
  widens the window: one extraction now performs four ID scans (two artifacts,
  two log rows) where it used to perform two.
- **Proposed change:** After creating a row, re-query the title and fail loudly
  if more than one exists, so a collision surfaces instead of persisting. The
  real repair is UUIDs, which `SCHEMA.md` already reserves for production. No
  migration for the check; the UUID switch is a full one. See also the Revisit
  section — the claim id is now an externally-visible reconciliation key, which
  changes what this costs.

### S3. `getClaimChain` dereferences an unchecked lookup and has no cycle guard

- **What:** The chain root can be `undefined`, and a `parent_claim_id` cycle
  makes both the walk up and the walk down loop forever.
- **Where:** `NotionRepository.js:714-717` (root walk) and `:719-727`
  (breadth-first descent, no visited set).
- **Severity:** high
- **Why it matters:** `root = claimsById.get(claimId)` assumes the claim appears
  in its own encounter's list; if the claim's `encounter_id` was ever edited in
  Notion it does not, and the next line throws on `undefined.parentClaimId`.
  Worse, nothing prevents two claims naming each other as parent — `createClaim`
  checks only that the parent exists — and the descent has no visited set, so a
  cycle hangs the request thread rather than erroring.
- **Proposed change:** Return an empty chain when the root lookup misses, and
  carry a `Set` of visited claim IDs through both loops. Repository only; no
  schema change, no migration.

### S4. Four select vocabularies that no repository constant covers

- **What:** Four select properties are written from values the repository does
  not declare and does not validate.
- **Where:** Encounters `status`, unvalidated in `updateEncounterStatus`
  (`NotionRepository.js:406-416`) with the only list living in `server.js:566`;
  Documents `extraction_status` (`NotionRepository.js:800`, only `none` ever
  written); Payer Feedback `claim_status` and `recommended_route`, written
  unvalidated at `:675-676` from `parseRemittance.js` and `analyzeRemittance.js`.
- **Severity:** medium
- **Why it matters:** Notion creates a new select option on write rather than
  rejecting an unknown value, so a typo or a renamed pipeline constant
  permanently adds a bogus option and every later filter on that column silently
  misses those rows. `SCHEMA.md`'s own rule is that a select property gets a
  constant and a write-time check. Encounter status is the sharpest case: the
  server list is now `["draft", "reviewed", "submitted"]` (`server.js:566`) and
  is the *only* check on that column, so any other caller of
  `updateEncounterStatus` writes free text into a select. `SCHEMA.md` is stale
  on this in two places outside Settled decisions: its status table says
  `Encounter.status` has `draft` as the only value written today, but
  `persistSubmittedClaim` writes `submitted` (`server.js:1000`) and the endpoint
  accepts `reviewed`; and its Vocabularies paragraph says two properties lack a
  constant, where the count is four.
- **Proposed change:** Add `ENCOUNTER_STATUSES`, `EXTRACTION_STATUSES`,
  `FEEDBACK_CLAIM_STATUSES` and `RECOMMENDED_ROUTES` as module constants and
  validate on write; correct both `SCHEMA.md` statements. No migration — the
  values the code produces are unchanged, so this guards against future drift
  rather than rewriting anything.

### S5. A correction or appeal that fails at submission leaves a draft row nothing clears

- **What:** Both resubmission paths create the Claim row (and a claim-stage
  artifact) as a `draft` before mapping and submitting, and promote it only
  after Stedi accepts. A mapping error or a rejected submission leaves the
  `corrected` draft and its artifact behind, and nothing deletes them.
- **Where:** `server.js:1112-1127` (corrected) and `:1238-1253` (appeal); the
  failure paths at `:1161-1171` and `:1287-1297` clean up nothing.
- **Severity:** medium
- **Why it matters:** `pickOriginalDraft` (`draftClaim.js:12-15`) keeps the New
  Claim path from adopting one of these, so an abandoned correction can no
  longer turn an ordinary claim into an amendment of an older one. What is left
  is accumulation. Each retry of a rejected correction writes another
  claim-stage artifact version and another `corrected` row chained to the same
  parent, so `getClaimChain` reports three corrections where one was attempted,
  History's buckets count each as a claim in flight, and a provider reading the
  chain cannot tell an attempt from a filing. Nothing is billed twice, because
  they stay `draft`.
- **Proposed change:** Delete the draft row when submission fails —
  `deleteClaim` already permits exactly this case (draft, no children) — or mark
  it. Route changes only; no schema change. Any orphan drafts already in the
  workspace need a one-off look. Worth pairing with C4 and C7: a deletion that
  leaves no trace is how "was a correction attempted?" becomes unanswerable.

### S6. `createClaim` accepts an artifact from another encounter or another stage, while `updateClaimArtifact` refuses both

- **What:** `createClaim` verifies that the encounter exists and that the
  artifact exists, but never that they belong together or that the artifact is a
  claim-stage one. The method added to repoint a claim checks exactly those two
  things.
- **Where:** `NotionRepository.js:479-514` (`createClaim`, artifact lookup at
  `:490-491`) against `:544-583` (`updateClaimArtifact`, checks at `:567` and
  `:572`).
- **Severity:** medium
- **Why it matters:** The artifact pointer is the audit trail — it is what makes
  a submitted claim still resolve to the record it was built from. A claim
  created against another encounter's artifact cites someone else's visit, and
  because `getArtifactHistory` is keyed by encounter, nothing in the UI would
  ever surface the mismatch. The repository holds two rules for the same
  invariant, one enforced and one not, which is the state most likely to be read
  as "already handled".
- **Proposed change:** Lift the encounter-match and stage checks out of
  `updateClaimArtifact` into a shared helper and call it from `createClaim` too.
  Repository only; no migration. A one-off scan for claims whose artifact
  belongs elsewhere is worth running alongside.

### S7. A Claim's `artifact_id` is written and never read back, and the resubmission paths guess instead

- **What:** There is no repository method that resolves an artifact by its id —
  `Repository.js` offers only `getArtifactHistory(encounterId)` and
  `getLatestArtifact(encounterId, stage)`. So the correction and appeal paths
  rebuild from `getLatestArtifact(encounterId, "claim")` rather than from the
  artifact the claim they are correcting actually points at.
- **Where:** `Repository.js:96-117` (no by-id accessor) and the `artifact_id`
  column at `NotionRepository.js:504`; used at `server.js:1085` (corrected) and
  `:1224` (appeal).
- **Severity:** medium
- **Why it matters:** An encounter accumulates claim-stage artifacts — one per
  populate, one per correction, one per appeal. Correcting `CL004` after `CL005`
  was already filed builds the correction from `CL005`'s artifact, so the payer
  receives a replacement for `CL004` whose content was never on `CL004`. The
  column that would prevent this is populated on every row; it is the schema's
  own answer and nothing can ask it. It also makes S6 unverifiable in practice:
  a mispointed `artifact_id` has no reader that would notice. S1 makes it
  likelier still, since it puts more claim rows on one encounter.
- **Proposed change:** Add `getArtifact(artifactId)` to `Repository.js` and
  `NotionRepository` (the `_findByTitle` helper already does the work), and have
  both resubmission paths read `original.artifactId` instead of the encounter's
  latest. Interface addition plus two route changes; no schema change, no
  migration.

### S8. The Context artifact is written only as a side effect of a successful extract+code call

- **What:** On the New Claim path, the provider's own context — the recorded,
  pasted or typed conversation — reaches the store only inside `/api/extract`'s
  success branch, after the merged model call returns.
- **Where:** `server.js:785` (`extractAndCode`) above the three `persistArtifact`
  calls at `:806-810`; the transcript persist is `:807`.
- **Severity:** medium
- **Why it matters:** A truncated response now throws (`extractAndCode.js:209`),
  which is right for the facts and codes and has a side effect nobody chose: an
  extraction that fails stores nothing at all, including the transcript, which
  had nothing to do with the failure. The context exists only in the browser tab
  until a model call succeeds. The UI keeps it on screen and offers a retry, so
  the loss needs a failure plus a closed tab — but the thing lost is the source
  record every other artifact is derived from, and it is the one piece the
  provider cannot regenerate. The P2 merge makes the window slightly larger, not
  smaller: one call now has to succeed for two stages' worth of output before
  the transcript is written.
- **Proposed change:** Persist the transcript artifact before calling the model,
  not after — it does not depend on the result. Route change only; no schema
  change, no migration.

### S9. Every audit-logged write scans the whole Audit Log to mint its id

- **What:** `createLogEntry` mints `log_id` through `_nextSequentialId`, which
  reads every existing row in the database, 100 at a time, before writing.
- **Where:** `NotionRepository.js:744` (`createLogEntry`), `:850-859`
  (`_nextSequentialId`) and `:830-844` (`_queryAll`); called from
  `backend/src/auditLog.js:21`.
- **Severity:** medium
- **Why it matters:** The Audit Log takes a row per artifact write, per claim
  creation and per status change, so it grows faster than any other database
  here — and every new row reads all the previous ones first. One extraction
  writes two artifacts and two log entries and therefore performs four full
  scans, two of them over the fastest-growing table. The failure mode is the
  quiet one: `recordAudit` swallows and shouts by design (`auditLog.js:20-28`,
  and `SCHEMA.md` settles that), so when the scan starts timing out under a few
  thousand rows the first symptom is log entries missing — the log thins out
  exactly as the history it records gets long enough to matter.
- **Proposed change:** Stop scanning for this one table: mint `log_id` from a
  timestamp plus a short random suffix, or query the newest row alone. A
  descending *title* sort will not do it — `LOG9` sorts above `LOG10`
  lexicographically — so a one-query version needs a numeric property to sort
  on. Repository only; no migration, and log ids stop being dense, which nothing
  depends on.

### S10. Artifact content is chunked but the number of chunks is unbounded

- **What:** `content` is split at 2000 characters with no ceiling on how many
  items result.
- **Where:** `NotionRepository.js:54-62` (`chunkedRichText`) and `:445`.
- **Severity:** medium
- **Why it matters:** A Notion rich_text property holds at most ~100 items of
  2000 characters. A long transcript above that is rejected by the API. The
  reporting half of this is handled — `persistArtifact` returns
  `{ saved: false }` and `persistenceFailure` surfaces it, so the provider is
  told (`server.js:806`, `backend/src/persistence.js:18`) — which makes this a
  visible failure rather than silent loss. The write still fails at the API
  rather than at a check that could say why.
- **Proposed change:** Have `createArtifact` refuse over-ceiling content with a
  named error naming the limit, so the message reaching the provider says "this
  transcript is too long to store" rather than a Notion validation error.
  Repository only; no migration.

### S11. Rows outlive the blobs their `storage_ref` points at

- **What:** `storage_ref` on Documents and Payer Feedback is a key into
  `LocalDiskBlobStore`, which writes to a directory on Render's ephemeral disk.
- **Where:** `backend/src/repository/LocalDiskBlobStore.js`;
  `backend/src/pipeline/ingestRemittance.js:107`; `NotionRepository.js:669` and
  `:799`.
- **Severity:** medium
- **Why it matters:** The Notion row survives a redeploy and the file does not,
  so every `storage_ref` written before the last deploy is a pointer to nothing
  and `getBlob` throws. This is not hypothetical for Payer Feedback:
  `ingestRemittance` deliberately keeps the raw 835 so a future parser fix can
  re-read the original (`ingestRemittance.js:98-111`), and that is exactly the
  guarantee the ephemeral disk breaks. The row keeps asserting the document is
  retrievable.
- **Proposed change:** Either mark the reference as unresolvable — a
  `storage_available` flag set at read time, or a `storage_backend` column so a
  reader can tell a live ref from a legacy local one — or keep the raw payer
  document inline alongside `content` while it is small enough, which removes the
  dependency entirely for the 835 case. The flag is additive; moving the payload
  inline is a pipeline change with no migration.

### S12. The shared placeholder Patient is found by matching a free-text name

- **What:** Encounters recorded before a patient is attached all file under one
  `Unidentified Patient` row, located by scanning every patient for that exact
  name string and cached in a module-level variable.
- **Where:** `server.js:234-241` (`getOrCreateUnidentifiedPatient`), used by
  `autoProvisionEncounter` at `:253`.
- **Severity:** medium
- **Why it matters:** Three separate ways this drifts. Rename the row in Notion
  and the next request creates a second placeholder, splitting the unattached
  encounters across two patients. Two concurrent extractions on a cold process
  both miss the cache and both create one. And nothing marks the row as a
  placeholder — it is an ordinary Patient with a DOB of `1900-01-01`, so it
  appears in `listPatients`, in the Patients route, and in any future count of
  patients on file, carrying the cases of many unrelated people under one
  `patient_id`. C2 is what happens when that row also becomes the eval suite's
  landing zone.
- **Proposed change:** Give Patient a boolean or select property marking a
  system-created placeholder and look the row up by that instead of by name; it
  also lets the Patients list filter it out. One additive Notion property plus a
  one-row backfill.

### S13. A patient row can never be corrected: there is no update path

- **What:** The interface has `createPatient` and nothing else. Name, date of
  birth, sex and insurance status are write-once.
- **Where:** `Repository.js:27-45` and `NotionRepository.js:274-312`; no
  `updatePatient` exists anywhere, and none of `updateCase`, `updateDocument` or
  an equivalent for Payer Feedback does either.
- **Severity:** medium
- **Why it matters:** Date of birth reaches the payer as the subscriber's DOB
  (`populateClaim.js:144`, `buildStediClaim.js:131`), and a wrong DOB is a
  rejected claim — so the field most likely to carry a typo is the field the app
  cannot fix. The only repair is editing the row in the Notion UI, which is also
  where S14's first-item-only read truncates formatted text. Insurance status is
  a drift finding on top of that: `SCHEMA.md` describes it as "a snapshot, not a
  history: a change overwrites", and no code path can overwrite it, so the
  documented behaviour does not exist.
- **Proposed change:** Add `updatePatient(patientId, fields)` to `Repository.js`
  and `NotionRepository`, running the same `PATIENT_SEXES` and
  `INSURANCE_STATUSES` checks `createPatient` does, and an edit form on the
  patient record. Interface, adapter and UI; no schema change and no migration.
  Worth deciding at the same time whether an edit to a patient should write an
  audit entry (C4) — for a PHI-bearing field the answer is probably yes.

### S14. Every free-text read returns only the first rich_text item

- **What:** `richText` reads `rich_text[0]` and drops the rest; only
  `richTextAll` rejoins chunks, and it is used for `content` and `detail` alone.
- **Where:** `NotionRepository.js:41-43`, against `:48-50`.
- **Severity:** low
- **Why it matters:** Ruby's own writes are single items, so this is invisible
  until a human edits a row in Notion. Notion splits text into several rich_text
  items when it is formatted — bold a word inside a `case_title` in the Notion UI
  and the read truncates at that word, with no error. The demo is shown from a
  Notion workspace people can open, which is precisely where that edit happens,
  and S13 makes it the *only* way to fix a patient's details.
- **Proposed change:** Use `richTextAll` for every rich_text read and delete
  `richText`. Repository only; no migration.

### S15. `createClaim` queries the Artifacts data source without its configuration guard

- **What:** The artifact lookup uses `this.artifactsDataSourceId` after calling
  only `_requireClaimsDataSource()`.
- **Where:** `NotionRepository.js:480` against the lookup at `:490`;
  `updateClaimArtifact:545-546` calls both guards correctly.
- **Severity:** low
- **Why it matters:** A repository configured with claims but not artifacts
  sends `data_source_id: undefined` to Notion and surfaces a Notion API error
  instead of the clear config message every other method gives. The constructor
  makes these IDs independently optional, so the combination is reachable.
- **Proposed change:** Add `this._requireArtifactsDataSource()` to `createClaim`.
  One line; no migration.

### S16. The log entries for a failed artifact write are the only ones no query can retrieve

- **What:** When a save fails before an artifact id exists, the log row is
  written with an empty `entity_id` and the identifying detail in free text. The
  only read method takes an entity id.
- **Where:** `server.js:169-175` (the failure entry) against
  `NotionRepository.js:761-773` (`getLogForEntity`, filtering
  `entity_id equals`).
- **Severity:** low
- **Why it matters:** These are the entries most worth finding — a visit whose
  record has a hole in it — and they are reachable only by opening the Notion
  database and reading `detail` by eye. "Which encounters lost a save?" is a
  question the log now holds the answer to and cannot be asked. Low because the
  console log carries the same information for as long as the logs are retained.
- **Proposed change:** Add a nullable `encounter_id` rich_text property to the
  log and a `listLogForEncounter` method, so an entry with no entity id still has
  a queryable owner. One additive property plus one method; existing rows keep an
  empty value, which is honest for them.

---

## 2. Naming inconsistencies

### N1. The same enum vocabularies are declared in two files

- **What:** `STAGES` and `CREATED_BY_VALUES` are duplicated verbatim in the
  server as `ENCOUNTER_ARTIFACT_STAGES` and `ARTIFACT_AUTHORS`, and
  `ENCOUNTER_STATUSES` exists only in the server. None of the repository's ten
  vocabulary constants is exported.
- **Where:** `NotionRepository.js:23-35` against `server.js:522`, `:526` and
  `:566`.
- **Severity:** medium
- **Why it matters:** `SCHEMA.md` places vocabularies in the repository,
  validated on write. With two copies, adding a stage in one file gives either an
  endpoint that accepts a value the repository rejects, or a repository that
  accepts a value no endpoint can send — and the failure only appears at runtime
  on the one path using the stale list. Encounter status is worse: the server
  list is the *only* check (see S4), and it now carries `reviewed`, which the
  repository has never heard of. The audit log's `AUDIT_ACTIONS` is the next
  candidate for the same split, since the action strings are written as literals
  at nine call sites in `server.js` and `ingestRemittance.js`.
- **Proposed change:** Export the constants from `NotionRepository.js` and import
  them in `server.js`. No migration.

### N2. `created_at` is read from a property that exists on one database in eight

- **What:** Only Patients carries a real `created_at` created_time property —
  live-verified on 2026-09-19, unchanged in the code since. Every other parser
  falls back to the Notion page's own `created_time`, and `parseCase` is the one
  parser that exposes no `createdAt` at all.
- **Where:** `NotionRepository.js:84`, `:106`, `:119`, `:138`, `:152`, `:175`,
  `:197` against `parseCase` at `:88-97`.
- **Severity:** medium
- **Why it matters:** Two costs, both quiet. The fallback works but is not a
  queryable column, so `listAllClaims`, `listClaimsForEncounter`,
  `getClaimChain`, `listPayerFeedbackForClaim` and `getLogForEntity` all sort in
  memory after fetching every row — the History page's ordering cannot move into
  the query, and will not move into the Postgres implementation either without a
  real column. And a Case has no creation time in the domain object at all, so
  anything ordering cases falls back to `opened_at`, which is written from the
  server clock rather than being the same thing.
- **Proposed change:** Add a `created_at` created_time property to the seven
  databases that lack one and expose `createdAt` from `parseCase`. Additive in
  Notion — a created_time property backfills itself from the page's real creation
  time, so no data migration.

### N3. An empty foreign key reads back as `""` on some entities and `null` on others

- **What:** `parseClaim`, `parseDocument` and `parseAuditEntry` coalesce an empty
  FK to `null`; `parseCase`, `parseEncounter`, `parsePayerFeedback` and
  `parseArtifact` (for `encounter_id`) return the empty string the writer put
  there. `parseArtifact` does both, in adjacent lines.
- **Where:** `NotionRepository.js:129`, `:137`, `:114`, `:149` against `:91`,
  `:102-103`, `:166` and `:191-196`.
- **Severity:** low
- **Why it matters:** Callers have to know which entity they are holding to know
  which emptiness test to use. `if (!x)` covers both today, which is why nothing
  has broken, but the first `x === null` or `x !== undefined` written against the
  wrong entity is a bug nothing type-checks. `SCHEMA.md` already flags the
  inconsistency and invites this note.
- **Proposed change:** Coalesce every empty FK to `null` on read. Repository
  only; no migration, since the stored value does not change.

### N4. Two scripts hold a Notion client outside the repository seam, and the database they write to is in no schema doc

- **What:** `SCHEMA.md` says `NotionRepository.js` is the only file that may
  import a Notion client or know a Notion page ID exists. Three files do:
  `repository/index.js` (by design, inside the seam) and two scripts outside it,
  which write to a "Data Model Audits" database and a Data Model page that no
  schema documentation describes.
- **Where:** `backend/scripts/record-audit-run.js` (the row's nine properties),
  `backend/scripts/publish-data-model.js`; the page id in
  `backend/.env.example:32` and the audits data source id at `:41`.
- **Severity:** low
- **Why it matters:** This already misfired once, in the way the boundary exists
  to prevent: the recorder pointed at the app's own Audit Log database, because
  the env var it read was named for both. That is fixed and the script now fails
  loudly rather than writing into the wrong place — which is why this is low.
  What remains is that the Data Model Audits schema (`Name`, `Run at`, `Commit`,
  `Introspection`, `Findings`, `High`, `Medium`, `Low`, `Headline`) is written
  from a literal object in a script and described nowhere, so a property renamed
  in Notion breaks the run log and nothing in `docs/data/` says which nine names
  to restore.
- **Proposed change:** Either note the tooling databases in `SCHEMA.md` as
  explicit exceptions to the seam, with their property lists, or restate the rule
  as "no application code", which is what it means. Documentation only; the ERD
  deliberately leaves them out as tooling rather than product data.

---

## 3. Compliance-field gaps

*These are gaps a reviewer of a claims system handling clinical records would
expect to find filled. None is a legal finding, and `SCHEMA.md` already records
that this prototype has no encryption at rest, no retention policy, and an audit
log that is not tamper-evident. Listed so the size of the gap is known.*

### C1. The synthetic-only rule has no field behind it

- **What:** No property on any entity records that a record is synthetic.
- **Where:** All eight databases; `CLAUDE.md` and `CONTRIBUTING.md` state the
  rule in prose.
- **Severity:** high
- **Why it matters:** The single hardest rule in the project is enforced only by
  people remembering it. Nothing can answer "is every row in here synthetic?" and
  nothing would flag the row that is not. A prototype that later takes one real
  encounter by accident has no way to find it again, and no way to prove to
  anyone that it did not. `Patient.sex` and `Patient.insurance_status` widen the
  PHI surface the rule is protecting.
- **Proposed change:** Add a required `data_class` select (`synthetic` | `real`)
  to Patient, defaulted to `synthetic` and written on every create, and refuse a
  `real` row until the compliance layer exists. One additive Notion property per
  entity you choose to mark; a one-time backfill of existing rows to `synthetic`.

### C2. An eval run writes encounters into the same store as the product, indistinguishably

- **What:** `eval/run.mjs` posts each of the 20 fixtures to `/api/extract` with
  no `encounterId`. That is the auto-provision path: for every fixture the server
  creates a Case and an Encounter under the shared `Unidentified Patient` row,
  plus a transcript artifact, a facts artifact and a codes artifact. Nothing
  marks any of those rows as test data.
- **Where:** `eval/run.mjs:68-72` (`runPipeline`) against `server.js:798-810` and
  `:250-263` (`autoProvisionEncounter`); `eval/results/` now holds three new run
  files dated 2026-09-22.
- **Severity:** high
- **Why it matters:** A single eval run files 20 cases, 20 encounters and 60
  artifacts (three per fixture now that codes are persisted separately) shaped
  exactly like a provider's work — they show up in the Patients route, in the
  activity feed, and in any count of visits on file, all hanging off the one
  placeholder patient (S12). The three new result files show this has happened
  again this cycle against whatever server those runs pointed at. The store
  cannot tell which encounters a clinician created and which a test harness did,
  which makes "what has this practice actually done" unanswerable, and it inflates
  the scan `_nextSequentialId` performs on every create (S2, S9). This audit
  reads code only, so whether those rows are in the workspace today was not
  checked; the code path that writes them is what is being reported.
- **Proposed change:** Two complementary options. Give the eval runner a header
  or flag that suppresses persistence for the run — the cheapest fix, one
  condition in `/api/extract`. And add the `data_class`-style origin marking of
  C1 with an `eval` value, so anything already written can be found and filtered.
  The suppression is a route change with no migration; the marking is one
  additive property plus a backfill decision.

### C3. The audit log's actor is whatever the request body said

- **What:** Every claim, artifact and log row carries a `provider_id`, and its
  value comes from `req.body.providerId` with no check that the profile exists,
  let alone that the caller is it.
- **Where:** `server.js:186-188` (`resolveProviderId`), used at `:545`, `:805`,
  `:1043`; written at `NotionRepository.js:449`, `:509` and `:749`, with
  `createArtifact`'s comment at `:447-448` stating the non-check deliberately.
- **Severity:** high
- **Why it matters:** There is a trail, and this is what it is worth. Any client
  can post `{"providerId": "someone-else"}` and the log will attribute an
  artifact edit or a claim submission to them; every row written today says
  `default`, so the field records who the request *claimed* to act as. It is also
  not a person: `provider_id` names a billing profile, so two clinicians in one
  practice are the same actor in the log, and a claim is a legal assertion by a
  named provider. `deleteClaim`, `closeCase` and `setPayerClaimControlNumber`
  change the record with no actor at all (C4).
- **Proposed change:** Keep `resolveProviderId` as the seam — it is the right one
  — and have it read a verified identity rather than the body; until there is
  one, reject a `providerId` with no profile behind it in `server.js` (the
  repository must not learn that profiles exist). The person-level actor is worth
  scoping now, so `Repository.js` carries the parameter from the start rather
  than gaining it later on every method.

### C4. Four write paths change the record without a log entry, and three entity kinds cannot be logged at all

- **What:** `deleteClaim`, `setPayerClaimControlNumber` and `closeCase` write no
  log row, and neither does any patient, case or encounter creation —
  `AUDIT_ENTITY_TYPES` is `claim | artifact`, so those three could not be logged
  without widening the vocabulary.
- **Where:** `NotionRepository.js:34` (`AUDIT_ENTITY_TYPES`), `:585-610`
  (`deleteClaim`), `:630-640` (`setPayerClaimControlNumber`), `:354-367`
  (`closeCase`), `:274-302` (`createPatient`); routes at `server.js:755-767`,
  `:311-336`, `:474-513`. `SCHEMA.md:99-102` records the gap in prose.
- **Severity:** high
- **Why it matters:** `SCHEMA.md`'s own settled decision says a write path that
  skips the log *is* a finding, and these are the sharpest four. Deleting a draft
  removes the row, and the claim id is never reused, so the Claims database is
  left with a gap and nothing anywhere says `CL006` existed or who discarded it —
  which is exactly the question a deletion invites, and the reason S5's cleanup
  proposal cannot be adopted as it stands. `setPayerClaimControlNumber` writes the
  value the payer reconciles on and the value a correction cannot be filed
  without. And creating a patient is the one write that introduces PHI into the
  store: no trail, and no vocabulary that could carry one.
- **Proposed change:** Add `patient`, `case` and `encounter` to
  `AUDIT_ENTITY_TYPES` and a `deleted` action to `AUDIT_ACTIONS`, then call
  `recordAudit` from those paths. Two additive select option sets plus a handful
  of call sites; no migration, and existing log rows are unaffected. Pairs with
  C7 — a deletion that logs is most of a soft delete already.

### C5. Nothing records what was actually transmitted to the payer

- **What:** The 837P payload Ruby sends — including the dollar amount it bills —
  is built at submission time, sent, returned to the browser and never stored.
- **Where:** `buildStediClaim.js:109-111` (`claimChargeAmount`, a flat `100.00`
  per line) and `:113-185`; `server.js:1044` returns `stediClaim` in the response
  and persists nothing; the claim-stage artifact holds `populateClaim`'s output,
  which has no charge amounts.
- **Severity:** high
- **Why it matters:** The claim artifact is Ruby's record of what it *drafted*,
  not of what it *sent*, and the two differ — `buildStediClaim` adds the charge
  amounts, the place-of-service code, the frequency code, the filing code, the
  subscriber address and the control number. Ask "what did we bill on CL004, and
  for how much?" and the only honest answer is to re-derive it and hope the code
  has not changed since. The billed total appears in the store for the first time
  when the payer reports it back in the 835, which means Ruby cannot check the
  payer's billed figure against its own. For a corrected claim this compounds:
  `buildCorrectedClaim` produces a new payload and the store keeps only its
  `populateClaim`-shaped part. S1 sharpens it further — if two original claims can
  go out for one encounter, nothing stored distinguishes what each one carried.
  This is the payer-transmission logging follow-on the running log has been
  tracking.
- **Proposed change:** Write the submitted 837P as its own artifact at submission
  time — a new `submission` stage on `STAGES`, so it lands in the existing
  versioned chain and inherits the append-only guarantee — and promote the claim
  charge amount to a typed `billed_amount` number on Claim so it can be summed
  without opening a blob. Additive: one select option, one Notion property, no
  rewrite of existing rows (which simply have no submission artifact).

### C6. No artifact records which model produced it, or that a model was involved at all

- **What:** A derived artifact — `facts`, `codes`, or a claim built from them —
  carries `created_by: "system"` and nothing else about its provenance: not the
  model ID, not the prompt, not the output cap, not the stop reason.
- **Where:** `NotionRepository.js:24` (`CREATED_BY_VALUES`) and `:418-453`
  (`createArtifact`); `server.js:42` and `:47` (both model IDs come from
  `process.env` with a default); `usage.js` meters calls in memory only.
- **Severity:** medium
- **Why it matters:** A response cut off at an old token cap produced a facts or
  codes artifact with empty arrays and no error. The P2 merge now throws on that
  case going forward (`extractAndCode.js:209`), but the rows written before the
  guard are still in the store and are indistinguishable from an encounter that
  genuinely had nothing to extract — there is no field that would let anyone find
  them and re-run them. The model is also not fixed: it is read from
  `ANTHROPIC_MODEL` at boot, and `CLAUDE.md` explicitly parks the claim-path model
  choice pending an eval run, so artifacts written by more than one model will sit
  side by side with nothing to tell them apart. "Which of these records did the
  model we are about to change write?" is the first question a model swap asks,
  and the schema cannot answer it.
- **Proposed change:** Add `model` and `stop_reason` rich_text properties to
  Artifact, written on every system-created artifact and left empty for a
  `provider_edit`. Two additive Notion properties, one change to `createArtifact`'s
  signature and its callers; existing rows stay empty, which is the honest answer
  for them.

### C7. The schema has nowhere to put a retention or deletion decision

- **What:** No `deleted_at`, no retention class, no tombstone on any entity — and
  there is a delete path.
- **Where:** All eight databases; `NotionRepository.js:585-610` (`deleteClaim`,
  which sets `in_trash: true`).
- **Severity:** medium
- **Why it matters:** A deleted draft leaves nothing behind: no row, no timestamp,
  no note that `CL006` ever existed, and the ID is not reused, so the Claims list
  simply has a gap. The guards around it are good — only a draft, never one with
  children — but the deletion itself is unrecorded (C4), and "was a claim ever
  drafted for this encounter and then withdrawn?" is not answerable. S5 makes this
  sharper: the cleanest fix there is to delete an abandoned correction, which under
  the current scheme would erase the fact that a correction was attempted.
  Separately, nothing in the model expresses how long any record should be kept.
- **Proposed change:** Replace the trash operation with a soft delete: a
  `deleted_at` date plus a `deleted_by` actor (see C3), with every list method
  filtering them out. Additive properties; the behaviour change touches
  `deleteClaim` and every `list*` method, and existing trashed rows stay trashed.

### C8. The claim still asserts three subscriber facts no row substantiates

- **What:** The 837P states the subscriber's member ID and street address and the
  payer's name and ID. None of them has a home in the schema.
- **Where:** `populateClaim.js:12-17` (`PLACEHOLDER_PATIENT`) and `:190-193`
  (hardcoded payer); `buildStediClaim.js:125-138` (subscriber block, address
  literal at `:132-137`).
- **Severity:** medium
- **Why it matters:** Name, date of birth and sex now come from the Patient row,
  and `placeholderFields` (`populateClaim.js:139-148`) marks exactly what was
  invented, which is the right mechanism. What is left cannot be fixed on the
  Patient row at all, because there is no Coverage or Payer entity — so a claim
  can never be more than most-of-the-way real no matter how complete the patient
  record is, and `insurance_status` is a select saying whether the patient is
  insured with nowhere to record *by whom*.
- **Proposed change:** Add a Coverage entity (patient, payer name, payer ID,
  member ID, plan, effective dates) and an address on Patient. This is the largest
  schema addition on the list — a new Notion database, new repository methods, new
  UI — and it is the one that decides whether Ruby can ever produce a submittable
  claim rather than a demonstrable one. Worth scoping deliberately, not slipping
  in.

### C9. A provider SSN slot is documented, read by nothing, and would be stored in plaintext

- **What:** The provider profile shape documents an optional `ssn`; no code
  writes it, reads it, or validates it.
- **Where:** `backend/src/providerProfiles.js:90` (JSDoc) against `:53-75`
  (`validate`, which checks `name`, `npi`, `organization` and `ein` only);
  `buildStediClaim.js` never reads it.
- **Severity:** low
- **Why it matters:** A documented field invites someone to fill it. If they do,
  it lands in an unencrypted JSON file on ephemeral disk alongside the NPI — the
  most sensitive value in the project, stored in the least protected place, for no
  functional gain, since nothing sends it. A sole proprietor billing under an SSN
  instead of an EIN is the real use case, and it needs the opposite of a quiet
  optional key.
- **Proposed change:** Delete `ssn` from the documented shape until there is
  somewhere safe to put it. One comment line; no migration.

---

## 4. Schema ↔ pipeline mismatches

### M1. `payer_name` and `member_id` are typed columns permanently holding literals

- **What:** Every Claim row is written with `payerName` and `memberId` read off
  the populated claim, where both are constants: `"Sample Payer Insurance"` and
  `"SAMPLE-0001"`.
- **Where:** `server.js:873-874` (`persistClaimDraft`) and `:977-978`
  (`persistSubmittedClaim`), reading `populateClaim.js:16` and `:191`.
- **Severity:** high
- **Why it matters:** These are the two columns the Claims database has for
  coverage, and they are the only two fields on a Claim row that are *supposed* to
  vary per claim and never do. Nothing is broken today because every value is the
  same; the failure arrives the moment one claim carries a real payer, at which
  point a column that has held one literal since the beginning starts mixing real
  and placeholder values with nothing to tell them apart. The corrected and appeal
  paths copy `original.payerName` and `original.memberId` forward
  (`server.js:1124-1125`, `:1250-1251`), so a placeholder propagates down a whole
  chain. This is also what makes the `|| "Unknown payer"` fallbacks unreachable
  dead ends rather than safety nets.
- **Proposed change:** Short term, write these from the encounter's Coverage once
  C8 exists, and until then write nothing rather than a literal — an empty column
  says "not known", a plausible fake does not. `createClaim` requires them
  non-empty today, so that check would relax. No migration, though existing rows
  would keep the literal unless backfilled.

### M2. The appeal draft is now the one model stage whose output is stored and sent yet has no truncation guard

- **What:** The P2 merge added a `stop_reason === "max_tokens"` throw to the
  combined extract+code call, so the busiest stage is now guarded. Of the three
  remaining model calls, `draftAppeal.js` still has no such check, and it is the
  only unguarded stage whose output both reaches the store and reaches a payer.
  `cleanupTranscript.js`/`generateBrief` is also unguarded, but its output is a
  reading aid persisted nowhere (see M8).
- **Where:** `extractAndCode.js:209-211` (now guarded) against `draftAppeal.js:136`
  (`max_tokens: 8000`) and its return at `:181-194` (no stop-reason check before
  it); `cleanupTranscript.js:34` (`max_tokens: 1024`, unguarded).
- **Severity:** high
- **Why it matters:** A response cut off mid-structure still carries a `tool_use`
  block, and every field in `draftAppeal` is defaulted — so a truncated draft
  returns a short `letterBody`, a partial `supportingQuotes` array and a partial
  `suggestedCodeChanges` array, with no error anywhere. Two concrete failures
  follow. The letter is written verbatim into a claim-stage artifact and filed as
  an appeal (`server.js:1238-1244`), so the store's record of why a denial was
  challenged is a fragment. And `buildCorrectedClaim` applies whatever changes
  survived the cut, then throws only on changes that match nothing — a silently
  *shorter* list passes every check, and the corrected claim goes to the payer
  missing edits the reviewer never saw. `needsReviewBeforeSending` is computed over
  the quotes that survived, so it reports clean.
- **Proposed change:** Apply the same `stop_reason` throw to `draftAppeal.js`;
  `generateBrief` can take it too, though its output is never persisted. Pipeline
  only; no schema change, no migration. Worth pairing with C6, which is what would
  let anyone find an artifact already written from a truncated response.

### M3. `provider_id` is a foreign key to a file that is rewritten on every boot

- **What:** Claim, Artifact and Audit Log rows record which provider they were
  created for. The thing they point at is a JSON file on ephemeral disk, re-seeded
  from a hardcoded demo profile whenever it is missing.
- **Where:** `backend/src/providerProfiles.js:24-25` (`STORE_PATH`);
  `server.js:62-65` (boot seeding from `DEMO_PROVIDER_PROFILE`);
  `buildStediClaim.js:142-158`; the FK columns at `NotionRepository.js:449` and
  `:509`.
- **Severity:** medium
- **Why it matters:** The rows name a provider, which is what was missing. What
  replaces it is subtler. The profile is not versioned and `upsertProviderProfile`
  overwrites in place (`providerProfiles.js:97-107`), so `default` always resolves
  to *something* — and a claim submitted last month and one submitted today both
  say `default` while the NPI, EIN and address behind that key may have changed,
  with nothing recording which values went out. That is worse than a dangling
  pointer, because it resolves confidently to the wrong answer. The NPI is the
  claim's assertion of who provided care.
- **Proposed change:** Make ProviderProfile a real entity — the module is keyed for
  it and says so in its own header — and either version it or copy the values that
  were actually used onto the submission artifact proposed in C5. One new database
  plus repository methods; existing rows keep `default`, which stays correct.

### M4. An appeal is stored as a corrected claim with its letter smuggled into a claim artifact

- **What:** There is no `appeal` claim type and no `appeal` artifact stage, so
  appeals are written as `corrected` claims and the letter rides along as extra
  keys on a claim-stage artifact.
- **Where:** `server.js:1238-1253`; vocabularies at `NotionRepository.js:23` and
  `:25`. The code says so in its own comment at `server.js:1180-1185`.
- **Severity:** medium
- **Why it matters:** "How many denials did we appeal, and how many were
  overturned" cannot be answered by a query, because the Claims database cannot
  tell an appeal from a correction. The claim-stage artifact now has two possible
  shapes — `populateClaim`'s output, or that output plus `appealLetter` and
  `appealOfClaimId` — so anything reading a claim artifact has to handle both, and
  S7's "which artifact was this claim built from" gets harder for the same reason.
- **Proposed change:** Add `appeal` to `CLAIM_TYPES` and an `appeal` stage to
  `STAGES`. Both are Notion select options, so the schema change is additive and
  existing rows are unaffected; History's bucket logic and `renderClaimActions`
  would need to recognise the new type, and existing appeal rows stay mislabelled
  as `corrected` unless backfilled.

### M5. The appeal draft's judgement is computed, shown once, and discarded

- **What:** `draftAppeal` returns nine fields. Only `letterBody` ever reaches the
  store, and only if the provider goes on to submit. `denialAssessment`,
  `worthAppealing`, `recommendedAction`, `supportingQuotes`, `quoteGrounding`,
  `suggestedCodeChanges`, `needsReviewBeforeSending` and `unsupportedQuoteCount`
  are returned to the browser and dropped.
- **Where:** `draftAppeal.js:181-194` against `server.js:657-664`, which responds
  with `{ draft }` and persists nothing; the only stored fragment is
  `appealLetter` at `:1241`.
- **Severity:** medium
- **Why it matters:** This is the one model call in the denial loop, and it is the
  only stage in the whole app whose output is not written as an artifact. Two
  things are lost. When the draft says `worthAppealing: false` — the intended,
  correct outcome for a denial that cannot be argued with — the practice's decision
  not to appeal leaves no record at all, so "why did we let CL004 go?" has no
  answer and reopening it costs another paid call that may answer differently. And
  `suggestedCodeChanges` is the input `/api/claims/:claimId/resubmit` acts on: the
  correction that gets filed is derived from a list nothing kept.
- **Proposed change:** Persist the draft as an artifact on the `appeal` stage
  proposed in M4, `createdBy: "system"`, at the moment it is generated rather than
  at submission. Needs M4's select option; no other schema change and no migration.

### M6. The denial loop's money and deadlines exist only inside a JSON blob

- **What:** Payer Feedback promotes exactly one number to a typed column;
  everything else `analyzeRemittance` computes lives inside `content`.
- **Where:** `NotionRepository.js:663-677` writes `amount_at_risk` and nothing
  else numeric; `analyzeRemittance.js:188-214` returns `money.billed`,
  `money.paid`, `patientResponsibility`, `contractualWriteOff`, both deadlines and
  the days-remaining for each.
- **Severity:** medium
- **Why it matters:** "Which claims have an appeal deadline inside two weeks" is
  the question this loop exists to answer, and it needs every Payer Feedback row
  fetched and every JSON blob parsed to answer it. The deadlines carry an
  `isDefault: true` flag saying they are not this payer's real contract terms
  (`analyzeRemittance.js:205-213`), and that flag is buried in the same blob — so
  nothing can find the rows whose deadlines are guesses either.
- **Proposed change:** Promote `billed`, `paid`, `patient_responsibility`,
  `appeal_deadline` and `filing_deadline` to typed Notion properties, keeping
  `content` as the full record. Additive properties; existing rows backfill from
  their own `content`, which is a one-off script rather than a real migration.

### M7. Validation and grounding verdicts are unreachable by query

- **What:** The two review signals the pipeline computes — whether a suggested code
  is recognised, and whether a medical-necessity quote is really in the transcript
  — are written inside artifact JSON and nowhere else. The facts artifact also
  carries a key the extract+code tool schema does not declare.
- **Where:** `server.js:792` (`annotateValidation`) persisted at `:809`;
  `server.js:790` sets `facts.medicalNecessityGrounding` from
  `verifyQuotes.js:83`, persisted at `:808`; the `record_facts_and_codes` tool in
  `extractAndCode.js:14-82` declares the facts fields and not that added key.
- **Severity:** medium
- **Why it matters:** "Show me every claim submitted with an unrecognised code"
  and "show me every claim resting on a quote that was not in the transcript" are
  the two questions a reviewer of this system would ask first, and neither can be
  answered without reading every artifact. The unrecognised list is written to the
  server console (`server.js:795`) and then discarded. Separately, the facts
  artifact's true shape is the tool schema plus a server-added key, so anything
  validating a facts artifact against `extractAndCode.js` finds a field that should
  not be there.
- **Proposed change:** Promote two counts to typed Claim properties —
  `unrecognised_code_count` and `ungrounded_quote_count` — set when the claim row
  is written, so a filter finds the claims worth reviewing without opening a blob.
  Document `medicalNecessityGrounding` as part of the facts artifact shape.
  Additive; existing rows backfill from `content`.

### M8. The reviewer brief is a model output with no home in the schema

- **What:** P2 replaced the transcript rewrite with a short reviewer brief. The
  brief is generated by a model call, returned to the browser, and stored nowhere
  — there is no artifact stage for it.
- **Where:** `cleanupTranscript.js:33-52` (`generateBrief`); `server.js:819-841`
  (`/api/cleanup-transcript`, which responds with `{ summary }` and persists
  nothing); `STAGES` at `NotionRepository.js:23` has no `brief` entry.
- **Severity:** low
- **Why it matters:** Before P2, the cleanup stage rewrote the transcript and that
  rewrite became what was stored and extracted against — which the P2 change
  rightly ended, because grounding a quote in a paraphrase is worse than not
  cleaning up at all. But the replacement swings to the other extreme: the brief is
  shown to the reviewer as a reading aid and then lost, so re-opening the encounter
  in History cannot show the brief the provider saw while drafting, and there is no
  record that a summary was ever generated or what it said. Low because the brief
  is explicitly *not* the record — the transcript is — so nothing downstream
  depends on it. But a model output a human reads and acts on, kept nowhere, is the
  same shape of gap as M5.
- **Proposed change:** Decide deliberately: either add a `brief` stage to `STAGES`
  and persist it as an artifact when generated (additive select option, one persist
  call, no migration), or leave it ephemeral and document in `SCHEMA.md` that the
  brief is a view-time aid with no stored form, so its absence is a choice rather
  than an oversight. The first is the smaller surprise for anyone who later asks
  "where did that summary go?"

---

## 5. Revisit

One settled decision remains overtaken by a change made since it was settled.
Carried forward unchanged, because nothing this cycle touched it.

**Sequential, human-readable IDs.** `SCHEMA.md` settles this on the grounds that
`P001` is enumerable and unsafe for production, and that a demo where you can read
the IDs aloud is worth more than one where you cannot. That reasoning held while
the IDs were internal. It no longer is: the Claim row's `claim_id` is sent to the
payer as CLP01 on every submission path — original, corrected and appeal — and
`ingestRemittance` matches an incoming 835 back to a claim on exactly that value
(`buildStediClaim.js:162`, `ingestRemittance.js:81`). The ID stopped being a
display convenience and became a reconciliation key on an external wire protocol.

What changed, concretely: `CL004` is unique within one Notion workspace and
nowhere else. A local development server and the deployed Render service both mint
`CL004` and both submit it to Stedi's Test Payer, so a remittance fetched by one
can legitimately match a claim belonging to the other. The matching logic has no
way to detect that — it compares two identical strings and files the verdict. This
is S2's collision problem with a second party now holding the key, and S1 adds a
local version of it: two `original` claims on one encounter are two different
control numbers for one visit.

The decision itself may well still be right for the demo. What has expired is the
assumption behind it, so the recommendation is narrow rather than a rewrite: keep
the readable ID as the display name, and send a namespaced control number —
`<deployment>-CL004`, or the ID plus a per-workspace prefix — so the value
crossing the wire is unique even where the readable one is not. That is a change to
`buildStediClaim` and to the match in `ingestRemittance`, with no schema change;
claims already submitted under a bare ID keep matching on the fallback path that is
already there for them.

---

*No schema changes were made. Everything above is a proposal awaiting a decision,
per the agent's contract in `.claude/agents/data-model.md`.*
