# Ruby Health — data model audit

**Date:** 2026-09-19
**Commit:** `3e3fa3e`
**Introspection mode:** live-verified — the seven Notion databases under the
"Ruby App Data (Chunk 1 — synthetic only)" page were fetched and their property
schemas read. Property names, types and select option lists in
`schema.mermaid` are the live schema, not an inference from the code.
The ERD was verified to parse with `mermaid.parse()`.

**Companion files:** `SCHEMA.md` (what the model is meant to be),
`schema.mermaid` (the picture). This file is the distance between them.

---

## Summary

The store and the code still agree on shape, exactly as they did six days ago.
All seven live databases are unchanged, every property is both written and
parsed by `NotionRepository.js`, and `NotionRepository.js` itself has not been
touched since the last audit — so there is no drift between the database and
the application to report this run.

The movement is all in the claim paths, and it cuts both ways. PR #29 closed the
two high findings it was aimed at: a correction and an appeal now create their
Claim row before the payload is mapped, so they go to the payer carrying a real
claim id, and a remittance is now matched on CLP01 instead of being filed against
whichever claim happened to come first in the document. But creating that row
earlier means a submission that fails now leaves a `corrected` draft behind on
the encounter, and the original claim path adopts the newest draft it finds
without checking what kind it is — so a rejected correction can quietly turn the
next ordinary claim into an amendment of an older one. PR #30 fixed a real
truncation bug in two of the four stages that call a model; the stage it did not
fix is the one whose output is written to an artifact and sent to a payer.

Thirty findings below: nine high, seventeen medium, four low. Seven are new
(S1, S5, S6, C2, C5, M2, M5), twenty-three are carried forward unchanged, and
two from the last run are closed — verified in the code, not inferred from a
commit message. Read S1, C2 and M2 first.

---

## 1. Structural risks

### S1. A correction or appeal that fails at submission leaves a draft row the original claim path adopts

- **What:** Both resubmission paths now create the Claim row as a `draft` before
  mapping and submitting, and promote it to `submitted` only after Stedi
  accepts. A mapping error or a rejected submission leaves a `corrected` draft
  on the encounter — and `findDraftClaim` and `persistSubmittedClaim` both take
  the newest draft on an encounter without checking its `claim_type` or its
  `parent_claim_id`.
- **Where:** `backend/src/server.js:1053-1077` (corrected) and `:1161-1185`
  (appeal), against `:186-195` (`findDraftClaim`), `:820-849`
  (`persistClaimDraft`) and `:916-942` (`persistSubmittedClaim`).
- **Severity:** high
- **Why it matters:** Three concrete failures, all silent. `/api/submit-claim`
  attaches the newest draft's id to an ordinary claim (`:963-966`), so a fresh
  original claim goes out to the payer under the abandoned correction's
  `claim_id`, and the payer's 835 then matches that row instead. `persistClaimDraft`
  repoints the abandoned correction at the new claim-stage artifact (`:835`), so
  a `corrected` row chained by `parent_claim_id` to an older claim now cites an
  artifact for an unrelated draft. `persistSubmittedClaim` then marks it
  `submitted` (`:922`). The encounter ends up billed once and recorded as an
  amendment of something else. Repeated failures compound it: each retry calls
  `createClaim` again, so a second and third orphan draft accumulate with no
  dedup.
- **Proposed change:** Have `findDraftClaim` and `persistSubmittedClaim` match
  on `claimType === "original"` and an empty `parentClaimId`, and have the two
  resubmission paths clean up after themselves — delete the draft row (the
  existing `deleteClaim` already permits it: draft, no children) when submission
  fails. Route and helper changes only; no schema change, no migration. Existing
  orphan drafts, if any, would need a one-off look.

### S2. Sequential IDs are minted without atomicity, and reads resolve a collision silently

- **What:** Two overlapping creates in the same database scan the same maximum
  title and mint the same ID; `_findByTitle` then returns whichever row the
  query happens to put first.
- **Where:** `backend/src/repository/NotionRepository.js:754`
  (`_nextSequentialId`) and `:725` (`_findByTitle`, `page_size: 1`).
- **Severity:** high
- **Why it matters:** Every foreign key in this schema is the business ID
  string. Two `E007` rows make every artifact, claim and feedback row pointing
  at `E007` ambiguous, and nothing raises — `getEncounter` returns one of them
  and the visit's record silently splits in half. The demo is single-user, so
  this needs two requests in flight at once, which the New Claim page does
  whenever a stage cascade overlaps a manual action.
- **Proposed change:** After creating a row, re-query the title and fail loudly
  if more than one exists, so a collision surfaces instead of persisting. The
  real repair is UUIDs, which `SCHEMA.md` already reserves for production. No
  migration for the check; the UUID switch is a full one. See also the Revisit
  section — the claim id is now an externally-visible reconciliation key, which
  changes what this costs.

### S3. `getClaimChain` dereferences an unchecked lookup and has no cycle guard

- **What:** The chain root can be `undefined`, and a `parent_claim_id` cycle
  makes both the walk up and the walk down loop forever.
- **Where:** `NotionRepository.js:662-665` (root walk) and `:667-675`
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

### S4. `createClaim` accepts an artifact from another encounter or another stage, while `updateClaimArtifact` refuses both

- **What:** `createClaim` verifies that the encounter exists and that the
  artifact exists, but never that they belong together or that the artifact is a
  claim-stage one. The method added to repoint a claim checks exactly those two
  things.
- **Where:** `NotionRepository.js:428-462` (`createClaim`, artifact lookup at
  `:439-440`) against `:492-531` (`updateClaimArtifact`, checks at `:515` and
  `:520`).
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
  Repository only; no migration. Existing rows would not be re-checked, so a
  one-off scan for claims whose artifact belongs elsewhere is worth running
  alongside.

### S5. A Claim's `artifact_id` is written and never read back, and the resubmission paths guess instead

- **What:** There is no repository method that resolves an artifact by its id —
  `Repository.js` offers only `getArtifactHistory(encounterId)` and
  `getLatestArtifact(encounterId, stage)`. So the correction and appeal paths
  rebuild from `getLatestArtifact(encounterId, "claim")` rather than from the
  artifact the claim they are correcting actually points at.
- **Where:** `Repository.js:94-112` (no by-id accessor) and the `artifact_id`
  column at `NotionRepository.js:453`; used at `server.js:1023` (corrected) and
  `:1143` (appeal).
- **Severity:** medium
- **Why it matters:** An encounter accumulates claim-stage artifacts — one per
  populate, one per correction, one per appeal. Correcting `CL004` after
  `CL005` was already filed builds the correction from `CL005`'s artifact, so
  the payer receives a replacement for `CL004` whose content was never on
  `CL004`. The column that would prevent this is populated on every row and
  documented in Notion as "the claim-stage artifact this was built from"; it is
  the schema's own answer and nothing can ask it. It also makes S4 unverifiable
  in practice: a mispointed `artifact_id` has no reader that would notice.
- **Proposed change:** Add `getArtifact(artifactId)` to `Repository.js` and
  `NotionRepository` (the `_findByTitle` helper already does the work), and have
  both resubmission paths read `original.artifactId` instead of the encounter's
  latest. Interface addition plus two route changes; no schema change, no
  migration.

### S6. The Context artifact is written only as a side effect of a successful extraction

- **What:** On the New Claim path, the provider's own context — the recorded,
  pasted or typed conversation — reaches the store only inside `/api/extract`'s
  success branch, after the model call returns.
- **Where:** `backend/src/server.js:734-751`; the two `persistArtifact` calls at
  `:749-750` sit below `extractClinicalFacts` at `:735`.
- **Severity:** medium
- **Why it matters:** PR #30 made a truncated response throw
  (`extract.js:63-65`) where it previously returned empty facts. That is right
  for the facts, and it has a side effect nobody chose: an extraction that
  fails now stores nothing at all, including the transcript, which had nothing
  to do with the failure. The context exists only in the browser tab until a
  model call succeeds. The UI keeps it on screen and offers a retry, so the
  loss needs a failure plus a closed tab — but the thing lost is the source
  record every other artifact is derived from, and it is the one piece the
  provider cannot regenerate.
- **Proposed change:** Persist the transcript artifact before calling the model,
  not after — it does not depend on the result. Route change only; no schema
  change, no migration.

### S7. Artifact content is chunked but the number of chunks is unbounded

- **What:** `content` is split at 2000 characters with no ceiling on how many
  items result.
- **Where:** `NotionRepository.js:47` (`chunkedRichText`) and `:397`.
- **Severity:** medium
- **Why it matters:** A Notion rich_text property holds at most ~100 items of
  2000 characters. A long transcript above that is rejected by the API. The
  reporting half of this is handled — `persistArtifact` returns
  `{ saved: false }` and `persistenceFailure` surfaces it, so the provider is
  told (`server.js:150`, `backend/src/persistence.js:18`) — which makes this a
  visible failure rather than silent loss. The write still fails at the API
  rather than at a check that could say why.
- **Proposed change:** Have `createArtifact` refuse over-ceiling content with a
  named error naming the limit, so the message reaching the provider says "this
  transcript is too long to store" rather than a Notion validation error.
  Repository only; no migration.

### S8. Four live select vocabularies that no repository constant covers

- **What:** Four live select properties have option sets the repository does not
  declare or validate on write.
- **Where:** Encounters `status` (live: `draft | reviewed | submitted`) with no
  constant and no validation in `updateEncounterStatus`
  (`NotionRepository.js:358-368`); Documents `extraction_status` (live:
  `none | pending | complete`, only `none` ever written, `:704`); Payer Feedback
  `claim_status` (9 live options) and `recommended_route` (8 live options),
  written unvalidated at `:623-624`.
- **Severity:** medium
- **Why it matters:** Notion creates a new select option on write rather than
  rejecting an unknown value, so a typo or a renamed pipeline constant
  permanently adds a bogus option and every later filter on that column silently
  misses those rows. `claim_status` and `recommended_route` come straight from
  `parseRemittance.js:32-43` and `analyzeRemittance.js:20-36`; the live option
  lists match those modules exactly today, and nothing keeps them matching.
  `SCHEMA.md`'s own rule is that a select property gets a constant and a
  write-time check. Encounter status is the sharpest case: the only check on it
  lives in `server.js:518`, so any other caller of `updateEncounterStatus`
  writes free text into a select. `SCHEMA.md` is also stale on this in two
  places, both outside Settled decisions: its status table says
  `Encounter.status` has `draft` as the only value written today, but
  `persistSubmittedClaim` has written `submitted` since PR #27
  (`server.js:938`); and its Vocabularies paragraph says two properties lack a
  constant, where the live count is four.
- **Proposed change:** Add `ENCOUNTER_STATUSES`, `EXTRACTION_STATUSES`,
  `FEEDBACK_CLAIM_STATUSES` and `RECOMMENDED_ROUTES` as module constants and
  validate on write; correct both `SCHEMA.md` statements. No migration — the
  live option sets already match the values the code produces, so this guards
  against future drift rather than rewriting anything.

### S9. Rows outlive the blobs their `storage_ref` points at

- **What:** `storage_ref` on Documents and Payer Feedback is a key into
  `LocalDiskBlobStore`, which writes to a directory on Render's ephemeral disk.
- **Where:** `backend/src/repository/LocalDiskBlobStore.js:1-13`;
  `backend/src/pipeline/ingestRemittance.js:106`; `NotionRepository.js:617` and
  `:703`.
- **Severity:** medium
- **Why it matters:** The Notion row survives a redeploy and the file does not,
  so every `storage_ref` written before the last deploy is a pointer to nothing
  and `getBlob` throws `No blob found`. This is not hypothetical for Payer
  Feedback: `ingestRemittance` deliberately keeps the raw 835 so a future parser
  fix can re-read the original, and that is exactly the guarantee the ephemeral
  disk breaks. The row keeps asserting the document is retrievable.
- **Proposed change:** Either mark the reference as unresolvable — a
  `storage_available` flag set at read time, or a `storage_backend` column so a
  reader can tell a live ref from a legacy local one — or keep the raw payer
  document inline alongside `content` while it is small enough, which removes the
  dependency entirely for the 835 case. The flag is additive; moving the payload
  inline is a pipeline change with no migration, since old rows simply keep a
  ref that resolves to nothing.

### S10. The shared placeholder Patient is found by matching a free-text name

- **What:** Encounters recorded before a patient is attached all file under one
  `Unidentified Patient` row, located by scanning every patient for that exact
  name string and cached in a module-level variable.
- **Where:** `server.js:202-213` (`getOrCreateUnidentifiedPatient`), used by
  `autoProvisionEncounter` at `:225`.
- **Severity:** medium
- **Why it matters:** Three separate ways this drifts. Rename the row in Notion
  and the next request creates a second placeholder, splitting the unattached
  encounters across two patients. Two concurrent extractions on a cold process
  both miss the cache and both create one. And nothing marks the row as a
  placeholder — it is an ordinary Patient with a DOB of `1900-01-01`, so it
  appears in `listPatients`, in the Patients route, and in any future count of
  patients on file, carrying the cases of many unrelated people under one
  `patient_id`. C2 below is what happens when that row also becomes the eval
  suite's landing zone.
- **Proposed change:** Give Patient a boolean or select property marking a
  system-created placeholder and look the row up by that instead of by name;
  it also lets the Patients list filter it out. One additive Notion property
  plus a one-row backfill.

### S11. Every free-text read returns only the first rich_text item

- **What:** `richText` reads `rich_text[0]` and drops the rest; only
  `richTextAll` rejoins chunks, and it is used for `content` alone.
- **Where:** `NotionRepository.js:34-36`, against `:41-43`.
- **Severity:** low
- **Why it matters:** Ruby's own writes are single items, so this is invisible
  until a human edits a row in Notion. Notion splits text into several rich_text
  items when it is formatted — bold a word inside a `case_title` in the Notion
  UI and the read truncates at that word, with no error. The demo is shown from
  a Notion workspace people can open, which is precisely where that edit happens.
- **Proposed change:** Use `richTextAll` for every rich_text read and delete
  `richText`. Repository only; no migration.

### S12. `createClaim` queries the Artifacts data source without its configuration guard

- **What:** The artifact lookup uses `this.artifactsDataSourceId` after calling
  only `_requireClaimsDataSource()`.
- **Where:** `NotionRepository.js:429` against the lookup at `:439`;
  `updateClaimArtifact:493-494` calls both guards correctly.
- **Severity:** low
- **Why it matters:** A repository configured with claims but not artifacts
  sends `data_source_id: undefined` to Notion and surfaces a Notion API error
  instead of the clear config message every other method gives. The constructor
  makes these IDs independently optional, so the combination is reachable.
- **Proposed change:** Add `this._requireArtifactsDataSource()` to
  `createClaim`. One line; no migration.

---

## 2. Naming inconsistencies

### N1. The same enum vocabularies are declared in two files

- **What:** `STAGES` and `CREATED_BY_VALUES` are duplicated verbatim in the
  server as `ENCOUNTER_ARTIFACT_STAGES` and `ARTIFACT_AUTHORS`, and
  `ENCOUNTER_STATUSES` exists only in the server.
- **Where:** `NotionRepository.js:23-24` against `server.js:484`, `:488` and
  `:518`.
- **Severity:** medium
- **Why it matters:** `SCHEMA.md` places vocabularies in the repository,
  validated on write. With two copies, adding a stage in one file gives either an
  endpoint that accepts a value the repository rejects, or a repository that
  accepts a value no endpoint can send — and the failure only appears at runtime
  on the one path using the stale list. Encounter status is worse: the server
  list is the *only* check (see S8).
- **Proposed change:** Export the constants from `NotionRepository.js` and
  import them in `server.js`. No migration.

### N2. `created_at` is read from a property that exists on one database in seven

- **What:** Only Patients carries a real `created_at` created_time property —
  confirmed live again this run. Every other parser falls back to the Notion
  page's own `created_time`, and `parseCase` is the one parser that exposes no
  `createdAt` at all.
- **Where:** `NotionRepository.js:75`, `:97`, `:110`, `:127`, `:150`, `:171`
  against `parseCase` at `:79-88`; live schemas for all seven databases.
- **Severity:** medium
- **Why it matters:** Two costs, both quiet. The fallback works but is not a
  queryable column, so `listAllClaims`, `listClaimsForEncounter`,
  `getClaimChain` and `listPayerFeedbackForClaim` all sort in memory after
  fetching every row — the History page's ordering cannot move into the query,
  and will not move into the Postgres implementation either without a real
  column. And a Case has no creation time in the domain object at all, so
  anything ordering cases falls back to `opened_at`, which is written from the
  server clock rather than being the same thing.
- **Proposed change:** Add a `created_at` created_time property to the six
  databases that lack one and expose `createdAt` from `parseCase`. Additive in
  Notion — a created_time property backfills itself from the page's real
  creation time, so no data migration.

### N3. An empty foreign key reads back as `""` on some entities and `null` on others

- **What:** `parseClaim` and `parseDocument` coalesce an empty FK to `null`;
  `parseCase`, `parseEncounter`, `parseArtifact` and `parsePayerFeedback` return
  the empty string the writer put there.
- **Where:** `NotionRepository.js:120` and `:105` against `:82`, `:93-94`,
  `:166` and `:141`.
- **Severity:** low
- **Why it matters:** Callers have to know which entity they are holding to know
  which emptiness test to use. `if (!x)` covers both today, which is why nothing
  has broken, but the first `x === null` or `x !== undefined` written against
  the wrong entity is a bug nothing type-checks. `SCHEMA.md` already flags the
  inconsistency and invites this note.
- **Proposed change:** Coalesce every empty FK to `null` on read. Repository
  only; no migration, since the stored value does not change.

---

## 3. Compliance-field gaps

*These are gaps a reviewer of a claims system handling clinical records would
expect to find filled. None is a legal finding, and `SCHEMA.md` already records
that this prototype has no encryption at rest, no audit log and no retention
policy. Listed so the size of the gap is known.*

### C1. The synthetic-only rule has no field behind it

- **What:** No property on any entity records that a record is synthetic.
- **Where:** All seven live databases; `CLAUDE.md` and `CONTRIBUTING.md` state
  the rule in prose.
- **Severity:** high
- **Why it matters:** The single hardest rule in the project is enforced only by
  people remembering it. Nothing can answer "is every row in here synthetic?"
  and nothing would flag the row that is not. A prototype that later takes one
  real encounter by accident has no way to find it again, and no way to prove to
  anyone that it did not.
- **Proposed change:** Add a required `data_class` select (`synthetic` |
  `real`) to Patient, defaulted to `synthetic` and written on every create, and
  refuse a `real` row until the compliance layer exists. One additive Notion
  property per entity you choose to mark; a one-time backfill of existing rows
  to `synthetic`.

### C2. An eval run writes encounters into the same store as the product, indistinguishably

- **What:** `eval/run.mjs` posts each of the 20 fixtures to `/api/extract` with
  no `encounterId`. That is the auto-provision path: for every fixture the
  server creates a Case and an Encounter under the shared `Unidentified Patient`
  row, plus a transcript artifact and a facts artifact. Nothing marks any of
  those rows as test data.
- **Where:** `eval/run.mjs:69-70` against `server.js:743-751` and `:222-235`
  (`autoProvisionEncounter`); `eval/results/README.md` records two live runs on
  2026-09-13.
- **Severity:** high
- **Why it matters:** A single eval run files 20 cases, 20 encounters and 40
  artifacts that are shaped exactly like a provider's work — they show up in the
  Patients route, in the activity feed, and in any count of visits on file, all
  hanging off the one placeholder patient (S10). Two baseline runs are recorded
  in the repository, so this has already happened twice against whatever server
  those runs pointed at. The store cannot tell which encounters a clinician
  created and which a test harness did, which makes "what has this practice
  actually done" unanswerable, and it inflates the scan `_nextSequentialId`
  performs on every create. This audit reads schema only, so whether those rows
  are in the workspace today was not checked — the code path that writes them is
  what is being reported.
- **Proposed change:** Two options, and they are complementary. Give the eval
  runner a header or flag that suppresses persistence for the run — the cheapest
  fix, one condition in `/api/extract`. And add the `data_class`-style origin
  marking of C1 with an `eval` value, so anything already written can be found
  and filtered. The suppression is a route change with no migration; the marking
  is one additive property plus a backfill decision about existing rows.

### C3. No actor identity on any write

- **What:** `Artifact.created_by` distinguishes `system` from `provider_edit`
  and nothing else. No entity records *which* person acted, and there is no user
  or account entity in the model.
- **Where:** `NotionRepository.js:24`; every `create*` and `update*` method;
  `Repository.js` has no user concept.
- **Severity:** high
- **Why it matters:** A claim is a legal assertion by a named provider. Nothing
  in this store says who drafted it, who edited the facts it rests on, who
  submitted it, or who deleted a draft. `updateClaimStatus`,
  `setPayerClaimControlNumber`, `closeCase` and `deleteClaim` all change the
  record with no trace of who asked. The append-only artifact chain preserves
  *what* changed and loses *who* — which is the half an audit actually asks for.
- **Proposed change:** Add an actor field to every write path, sourced from
  whatever authentication the product brings, and widen `CREATED_BY_VALUES`
  beyond the two machine values. This is a real piece of work — it needs an
  identity to record before it can record one — and is worth scoping now so the
  interface in `Repository.js` carries the parameter from the start rather than
  gaining it later on every method.

### C4. Nothing records what was actually transmitted to the payer

- **What:** The 837P payload Ruby sends — including the dollar amount it bills —
  is built at submission time, sent, returned to the browser and never stored.
- **Where:** `buildStediClaim.js:109-111` (`claimChargeAmount`, a flat
  `100.00` per line) and `:113-185`; `server.js:979-990` returns `stediClaim` in
  the response and persists nothing; the claim-stage artifact holds
  `populateClaim`'s output, which has no charge amounts.
- **Severity:** high
- **Why it matters:** The claim artifact is Ruby's record of what it *drafted*,
  not of what it *sent*, and the two differ — `buildStediClaim` adds the charge
  amounts, the place-of-service code, the frequency code, the filing code, the
  subscriber address and the control number. Ask "what did we bill on CL004,
  and for how much?" and the only honest answer is to re-derive it and hope the
  code has not changed since. The billed total appears in the store for the
  first time when the payer reports it back in the 835, which means Ruby cannot
  check the payer's billed figure against its own. For a corrected claim this
  compounds: `buildCorrectedClaim` produces a new payload and the store keeps
  only its `populateClaim`-shaped part.
- **Proposed change:** Write the submitted 837P as its own artifact at
  submission time — a new `submission` stage on `STAGES`, so it lands in the
  existing versioned chain and inherits the append-only guarantee — and promote
  the claim charge amount to a typed `billed_amount` number on Claim so it can
  be summed without opening a blob. Additive: one select option, one Notion
  property, no rewrite of existing rows (which simply have no submission
  artifact).

### C5. No artifact records which model produced it, or that a model was involved at all

- **What:** A derived artifact — `facts`, `codes`, or a claim built from them —
  carries `created_by: "system"` and nothing else about its provenance: not the
  model ID, not the prompt, not the output cap, not the stop reason.
- **Where:** `NotionRepository.js:24` (`CREATED_BY_VALUES`) and `:370-402`
  (`createArtifact`); `server.js:41` and `:46` (both model IDs come from
  `process.env` with a default); `usage.js` meters calls in memory only.
- **Severity:** medium
- **Why it matters:** PR #30 is the case in point. Before it, a response cut off
  at the old 1024-token cap produced a facts or codes artifact with empty arrays
  and no error, on roughly a third of encounters. Those rows are in the store
  and are indistinguishable from an encounter that genuinely had nothing to
  extract — there is no field that would let anyone find them and re-run them.
  The model is also not fixed: it is read from `ANTHROPIC_MODEL` at boot, and
  the recorded P2 baseline was produced on a different model from the committed
  default (`eval/results/README.md`), so artifacts written by at least two
  models now sit side by side with nothing to tell them apart. "Which of these
  records did the model we are about to change write?" is the first question a
  model swap asks, and the schema cannot answer it.
- **Proposed change:** Add `model` and `stop_reason` rich_text properties to
  Artifact, written on every system-created artifact and left empty for a
  `provider_edit`. Two additive Notion properties, one change to
  `createArtifact`'s signature and its callers; existing rows stay empty, which
  is itself the honest answer for them.

### C6. The schema has nowhere to put a retention or deletion decision

- **What:** No `deleted_at`, no retention class, no tombstone on any entity —
  and there is a delete path.
- **Where:** All seven live databases; `NotionRepository.js:533-558`
  (`deleteClaim`, which sets `in_trash: true`).
- **Severity:** medium
- **Why it matters:** A deleted draft leaves nothing behind: no row, no
  timestamp, no note that `CL006` ever existed, and the ID is not reused, so the
  Claims list simply has a gap. The guards around it are good — only a draft,
  never one with children — but the deletion itself is unrecorded, and "was a
  claim ever drafted for this encounter and then withdrawn?" is not answerable.
  S1 makes this sharper: the cleanest fix there is to delete an abandoned
  correction, which under the current scheme would erase the fact that a
  correction was attempted. Separately, nothing in the model expresses how long
  any record should be kept, which is the first question a retention policy asks.
- **Proposed change:** Replace the trash operation with a soft delete: a
  `deleted_at` date plus a `deleted_by` actor (see C3), with every list method
  filtering them out. Additive properties; the behaviour change touches
  `deleteClaim` and every `list*` method, and existing trashed rows stay
  trashed.

### C7. The claim asserts subscriber facts no row substantiates

- **What:** The 837P states the subscriber's sex, member ID and address, and the
  payer's name and ID. None of the five has a home in the schema.
- **Where:** `populateClaim.js:12-17` (`PLACEHOLDER_PATIENT`) and `:178-181`
  (hardcoded payer); `buildStediClaim.js:125-138` (subscriber block, address
  literal at `:132-137`).
- **Severity:** medium
- **Why it matters:** Name and date of birth now come from the Patient row, and
  the code is explicit that the rest stay canned because "the schema carries no
  coverage". That is the finding: there is no Coverage or Payer entity, so a
  claim can never be more than two-fifths real no matter how complete the
  patient record is. `populateClaim` deliberately does not warn on these, on the
  sound reasoning that a warning true of every claim is decoration — which means
  the gap is now marked only at the fields in the claim form.
- **Proposed change:** Add a Coverage entity (patient, payer name, payer ID,
  member ID, plan, effective dates) and a patient `sex` and address on Patient.
  This is the largest schema addition on the list — two new Notion databases'
  worth of properties, new repository methods, new UI — and it is the one that
  decides whether Ruby can ever produce a submittable claim rather than a
  demonstrable one. Worth scoping deliberately, not slipping in.

### C8. A provider SSN slot is documented, read by nothing, and would be stored in plaintext

- **What:** The provider profile shape documents an optional `ssn`; no code
  writes it, reads it, or validates it.
- **Where:** `backend/src/providerProfiles.js:90` (JSDoc) against `:53-75`
  (`validate`, which checks `name`, `npi`, `organization` and `ein` only);
  `buildStediClaim.js` never reads it.
- **Severity:** low
- **Why it matters:** A documented field invites someone to fill it. If they do,
  it lands in an unencrypted JSON file on ephemeral disk alongside the NPI —
  the most sensitive value in the project, stored in the least protected place,
  for no functional gain, since nothing sends it. A sole proprietor billing
  under an SSN instead of an EIN is the real use case, and it needs the opposite
  of a quiet optional key.
- **Proposed change:** Delete `ssn` from the documented shape until there is
  somewhere safe to put it. One comment line; no migration.

---

## 4. Schema ↔ pipeline mismatches

### M1. `payer_name` and `member_id` are typed columns permanently holding literals

- **What:** Every Claim row is written with `payerName` and `memberId` read off
  the populated claim, where both are constants: `"Sample Payer Insurance"` and
  `"SAMPLE-0001"`.
- **Where:** `server.js:843-844` (`persistClaimDraft`) and `:930-931`
  (`persistSubmittedClaim`), reading `populateClaim.js:16` and `:180`.
- **Severity:** high
- **Why it matters:** These are the two columns the Claims database has for
  coverage, and they are the only two fields on a Claim row that are *supposed*
  to vary per claim and never do. Nothing is broken today because every value is
  the same; the failure arrives the moment one claim carries a real payer, at
  which point a column that has held one literal since the beginning starts
  mixing real and placeholder values with nothing to tell them apart. The
  corrected and appeal paths copy `original.payerName` and `original.memberId`
  forward (`server.js:1058-1059`, `:1166-1167`), so a placeholder propagates
  down a whole chain. This is also what makes the `|| "Unknown payer"` fallbacks
  unreachable dead ends rather than safety nets.
- **Proposed change:** Short term, write these from the encounter's Coverage
  once C7 exists, and until then write nothing rather than a literal — an empty
  column says "not known", a plausible fake does not. `createClaim` requires
  them non-empty today, so that check would relax. No migration, though existing
  rows would keep the literal unless backfilled.

### M2. Two of the four model-calling stages have no truncation guard, and one of them is the stage whose output is stored and sent

- **What:** PR #30 added a `stop_reason === "max_tokens"` check to `extract.js`
  and `suggestCodes.js`. `draftAppeal.js` and `cleanupTranscript.js` still have
  none.
- **Where:** `extract.js:63-65` and `suggestCodes.js:67-69` (guarded) against
  `draftAppeal.js:136` (`max_tokens: 8000`, no check before the return at
  `:181-194`) and `cleanupTranscript.js:30`.
- **Severity:** high
- **Why it matters:** `draftAppeal` is the only unguarded stage whose output
  both reaches the store and reaches a payer. A response cut off mid-structure
  still carries a `tool_use` block, and every field is defaulted — so a truncated
  draft returns a short `letterBody`, a partial `supportingQuotes` array and a
  partial `suggestedCodeChanges` array, with no error anywhere. Two concrete
  failures follow. The letter is written verbatim into a claim-stage artifact and
  filed as an appeal (`server.js:1155-1158`), so the store's record of why a
  denial was challenged is a fragment. And `buildCorrectedClaim` applies whatever
  changes survived the cut, then throws only on changes that match nothing — a
  silently *shorter* list passes every check, and the corrected claim goes to the
  payer missing edits the reviewer never saw, because they were never rendered.
  `needsReviewBeforeSending` is computed over the quotes that survived, so it
  reports clean.
- **Proposed change:** Apply the same `stop_reason` throw to `draftAppeal.js`;
  `cleanupTranscript.js` can take it too, though its output is never persisted.
  Pipeline only; no schema change, no migration. Worth pairing with C5, which is
  what would let anyone find an artifact already written from a truncated
  response.

### M3. Every claim carries provider identity that no row references

- **What:** The billing provider's NPI, employer ID, taxonomy and address go out
  on every claim from a JSON file on ephemeral disk, and no Claim row records
  which provider profile was used.
- **Where:** `backend/src/providerProfiles.js:24-25` (`STORE_PATH`);
  `server.js:852` reads `providerId` from the request body and `:862` uses it
  without storing it anywhere; `buildStediClaim.js:139-159`.
- **Severity:** medium
- **Why it matters:** The NPI is the claim's assertion of who provided care.
  After a redeploy the file is gone, so the profile that produced an already-
  submitted claim is unrecoverable — and because `providerId` is passed per
  request and never persisted, even knowing which profile it was is impossible.
  `populateClaim` then falls back to Stedi's test NPI, so a claim built after a
  redeploy silently bills under a different provider than the one before it,
  distinguishable only by the warning in the artifact JSON.
- **Proposed change:** Add `provider_id` as a rich_text FK on Claim, and make
  ProviderProfile a real entity — the module is already keyed for it and says so
  in its own header comment. One additive Notion property plus an eighth
  database; existing claims backfill to `default`.

### M4. An appeal is stored as a corrected claim with its letter smuggled into a claim artifact

- **What:** There is no `appeal` claim type and no `appeal` artifact stage, so
  appeals are written as `corrected` claims and the letter rides along as extra
  keys on a claim-stage artifact.
- **Where:** `server.js:1155-1168`; vocabularies at `NotionRepository.js:23` and
  `:25`. The code says so in its own comment at `server.js:1099-1104`.
- **Severity:** medium
- **Why it matters:** "How many denials did we appeal, and how many were
  overturned" cannot be answered by a query, because the Claims database cannot
  tell an appeal from a correction. The claim-stage artifact now has two
  possible shapes — `populateClaim`'s output, or that output plus `appealLetter`
  and `appealOfClaimId` — so anything reading a claim artifact has to handle
  both, and S5's "which artifact was this claim built from" gets harder for the
  same reason.
- **Proposed change:** Add `appeal` to `CLAIM_TYPES` and an `appeal` stage to
  `STAGES`. Both are Notion select options, so the schema change is additive and
  existing rows are unaffected; History's bucket logic and `renderClaimActions`
  would need to recognise the new type, and existing appeal rows stay
  mislabelled as `corrected` unless backfilled.

### M5. The appeal draft's judgement is computed, shown once, and discarded

- **What:** `draftAppeal` returns eight fields. Only `letterBody` ever reaches
  the store, and only if the provider goes on to submit. `denialAssessment`,
  `worthAppealing`, `recommendedAction`, `supportingQuotes`, `quoteGrounding`,
  `suggestedCodeChanges` and `unsupportedQuoteCount` are returned to the browser
  and dropped.
- **Where:** `draftAppeal.js:181-194` against `server.js:609-616`, which
  responds with `{ draft }` and persists nothing; the only stored fragment is
  `appealLetter` at `:1158`.
- **Severity:** medium
- **Why it matters:** This is the one model call in the denial loop, and it is
  the only stage in the whole app whose output is not written as an artifact.
  Two things are lost. When the draft says `worthAppealing: false` — the
  intended, correct outcome for a denial that cannot be argued with — the
  practice's decision not to appeal leaves no record at all, so "why did we let
  CL004 go?" has no answer and reopening it costs another paid call that may
  answer differently. And `suggestedCodeChanges` is the input
  `/api/claims/:claimId/resubmit` acts on: the correction that gets filed is
  derived from a list nothing kept, so the stored corrected claim cannot be
  traced back to the reasoning that produced it.
- **Proposed change:** Persist the draft as an artifact on the `appeal` stage
  proposed in M4, `createdBy: "system"`, at the moment it is generated rather
  than at submission. Needs M4's select option; no other schema change and no
  migration.

### M6. The denial loop's money and deadlines exist only inside a JSON blob

- **What:** Payer Feedback promotes exactly one number to a typed column;
  everything else `analyzeRemittance` computes lives inside `content`.
- **Where:** `NotionRepository.js:611-625` writes `amount_at_risk` and nothing
  else numeric; `analyzeRemittance.js:188-214` returns `money.billed`,
  `money.paid`, `patientResponsibility`, `contractualWriteOff`, both deadlines
  and `daysRemaining` for each.
- **Severity:** medium
- **Why it matters:** "Which claims have an appeal deadline inside two weeks"
  is the question this loop exists to answer, and it needs every Payer Feedback
  row fetched and every JSON blob parsed to answer it. The deadlines carry an
  `isDefault: true` flag saying they are not this payer's real contract terms,
  and that flag is buried in the same blob — so nothing can find the rows whose
  deadlines are guesses either.
- **Proposed change:** Promote `billed`, `paid`, `patient_responsibility`,
  `appeal_deadline` and `filing_deadline` to typed Notion properties, keeping
  `content` as the full record. Additive properties; existing rows backfill from
  their own `content`, which is a one-off script rather than a real migration.

### M7. Validation and grounding verdicts are unreachable by query

- **What:** The two review signals the pipeline computes — whether a suggested
  code is recognised, and whether a medical-necessity quote is really in the
  transcript — are written inside artifact JSON and nowhere else. The facts
  artifact also carries a key `extract.js` does not declare.
- **Where:** `server.js:797` (`annotateValidation`) persisted at `:804`;
  `server.js:739` sets `facts.medicalNecessityGrounding` from
  `verifyQuotes.js:83`, persisted at `:750`; `extract.js:7-37` declares five
  fields and not that sixth one.
- **Severity:** medium
- **Why it matters:** "Show me every claim submitted with an unrecognised code"
  and "show me every claim resting on a quote that was not in the transcript"
  are the two questions a reviewer of this system would ask first, and neither
  can be answered without reading every artifact. The unrecognised list is
  written to the server console (`:801`) and then discarded. Separately, the
  facts artifact's true shape is the tool schema plus a server-added key, so
  anything validating a facts artifact against `extract.js` finds a field that
  should not be there.
- **Proposed change:** Promote two counts to typed Claim properties —
  `unrecognised_code_count` and `ungrounded_quote_count` — set when the claim
  row is written, so a filter finds the claims worth reviewing without opening a
  blob. Document `medicalNecessityGrounding` as part of the facts artifact
  shape. Additive; existing rows backfill from `content`.

---

## 5. Revisit

One settled decision has been overtaken by a change made since it was settled.

**Sequential, human-readable IDs.** `SCHEMA.md` settles this on the grounds that
`P001` is enumerable and unsafe for production, and that a demo where you can
read the IDs aloud is worth more than one where you cannot. That reasoning held
while the IDs were internal. It no longer is: since PR #27 and PR #29, the Claim
row's `claim_id` is sent to the payer as CLP01 on every submission path —
original, corrected and appeal — and `ingestRemittance` now matches an incoming
835 back to a claim on exactly that value (`buildStediClaim.js:162`,
`ingestRemittance.js:80`). The ID stopped being a display convenience and became
a reconciliation key on an external wire protocol.

What changed, concretely: `CL004` is unique within one Notion workspace and
nowhere else. A local development server and the deployed Render service both
mint `CL004` and both submit it to Stedi's Test Payer, so a remittance fetched
by one can legitimately match a claim belonging to the other. The matching logic
has no way to detect that — it compares two identical strings and files the
verdict. This is S2's collision problem with a second party now holding the key.

The decision itself may well still be right for the demo. What has expired is the
assumption behind it, so the recommendation is narrow rather than a rewrite:
keep the readable ID as the display name, and send a namespaced control number —
`<deployment>-CL004`, or the ID plus a per-workspace prefix — so the value
crossing the wire is unique even where the readable one is not. That is a change
to `buildStediClaim` and to the match in `ingestRemittance`, with no schema
change; claims already submitted under a bare ID keep matching on the fallback
path that is already there for them.

---

*No schema changes were made. Everything above is a proposal awaiting a
decision, per the agent's contract in `.claude/agents/data-model.md`.*
