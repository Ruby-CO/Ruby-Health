# Ruby Health — data model audit

**Date:** 2026-09-13
**Commit:** `3753de0` (branch `claude/beautiful-brown-hnku5k`)
**Introspection mode:** **live-verified** — the seven Notion databases under the
"Ruby App Data (Chunk 1 — synthetic only)" page were fetched and their property
schemas read (names, types and select option lists only; no records). The ERD in
`schema.mermaid` reflects both `NotionRepository.js` and the live databases, and
was checked with Mermaid's own `parse()` before being written.
**Doctrine:** `docs/data/SCHEMA.md` as of this commit. Everything in its Settled
decisions section is excluded below; where the code has drifted from a settled
decision, the drift is reported and the decision is not.

## Summary

The stored schema and the live Notion databases agree on every property name and
type — there is no orphan column in either direction, which is better than most
schemas this age manage. The disagreement is between the database and the
pipeline: the claim the pipeline builds does not read the patient, the date of
service or the provider from the rows that hold them, so a submitted claim
carries a hardcoded placeholder patient, today's date, and a provider record
that lives on a disk Render wipes. Separately, the two structural hazards worth
a decision this week are that artifact writes can fail silently and be reported
as success, and that the denial loop's money and deadlines are reachable only by
parsing a JSON blob.

---

## 1. Structural risks

### S1. Sequential IDs are minted without atomicity, and reads resolve a collision silently

- **What:** Two overlapping creates in the same database scan the same maximum
  and mint the same business ID; nothing detects the duplicate afterwards.
- **Where:** `backend/src/repository/NotionRepository.js:680` (`_nextSequentialId`),
  read back by `_findByTitle` at `:651` with `page_size: 1`.
- **Severity:** high
- **Why it matters:** Notion has no unique constraint on a title. Once two rows
  share `CL014`, `getClaim("CL014")` returns whichever Notion sorts first, and
  every downstream hop follows it — the artifact the claim points at, the chain
  traversal, and which claim a remittance gets filed against. Two browser tabs,
  or the New Claim on-entry cascade firing twice, is enough to produce it.
- **Proposed change:** Keep sequential IDs (settled). Make the read defensive:
  `_findByTitle` requests `page_size: 2` and throws `NotionRepositoryError` when
  two rows carry the same title, so a collision fails loudly instead of
  resolving to the wrong record. Repository-only, no migration, no API change.
  A mint-and-verify retry in `_nextSequentialId` is the fuller fix and is also
  repository-only.

### S2. An artifact write can exceed Notion's limit, fail, and be reported to the provider as success

- **What:** `content` is chunked at 2000 characters but the number of chunks is
  unbounded, and the caller swallows the resulting API error.
- **Where:** `NotionRepository.js:47` (`chunkedRichText`) and `:397`;
  `backend/src/server.js:143` (`persistArtifact`).
- **Severity:** high
- **Why it matters:** A Notion rich_text property holds at most ~100 items of
  2000 characters. A long transcript or a large claim JSON above that ceiling is
  rejected by the API; `persistArtifact` catches the error, writes it to the
  server console and returns normally. The provider sees the stage complete, the
  next stage reads an artifact that was never written, and the medical record
  for that visit has a hole in it that nothing in the UI mentions.
- **Proposed change:** Have `createArtifact` refuse over-ceiling content with a
  named error, and have `persistArtifact` return a persistence warning that the
  route includes in its response so the status line can say the record was not
  saved. Repository plus one response field; no migration.

### S3. `getClaimChain` dereferences an unchecked lookup and has no cycle guard

- **What:** The chain root can be `undefined`, and a `parent_claim_id` cycle
  makes both traversals loop forever.
- **Where:** `NotionRepository.js:588-601`.
- **Severity:** high
- **Why it matters:** `root = claimsById.get(claimId)` is undefined whenever the
  claim's `encounter_id` does not match any claim returned for that encounter —
  a soft FK, which SCHEMA.md notes nothing re-checks after write. The next line
  reads `root.parentClaimId` and throws a TypeError out of the repository, which
  History reports as a 502 on a claim that exists. And `createClaim` only checks
  that a parent exists, never that it is not a descendant, so A→B→A hangs the
  request in the `while` loop or the BFS queue with no timeout.
- **Proposed change:** Return `[claim]` when the claim is absent from its own
  encounter's list, and carry a `seen` Set through both traversals.
  Repository-only, no migration.

### S4. Every populate writes another draft Claim row for the same visit

- **What:** `persistClaimDraft` creates a new Claim row on every
  `/api/populate-claim` call rather than reusing the encounter's existing draft.
- **Where:** `server.js:757` (`persistClaimDraft`), called at `:788`; consumed by
  `persistSubmittedClaim` at `:838`.
- **Severity:** high
- **Why it matters:** Walking into the Claim step re-runs populate whenever the
  fingerprint changed, so one encounter accumulates several `draft` Claim rows
  for one visit. History lists each of them as a separate claim.
  `persistSubmittedClaim` promotes only the newest draft, so the stale siblings
  stay `draft` forever on an encounter that has already been billed — and the
  record-locking rule ("any claim past draft locks the encounter") then reads an
  encounter holding both a submitted claim and live-looking drafts.
- **Proposed change:** Have `persistClaimDraft` find the encounter's existing
  draft row and point it at the new artifact instead of creating a sibling.
  Server-only change; the duplicate rows already in the Claims database would
  need a one-off cleanup pass, which is a script someone runs and watches.

### S5. A claim can be built from an artifact belonging to a different encounter, or from the wrong stage

- **What:** `createClaim` verifies that the encounter and the artifact each
  exist, but never that the artifact belongs to that encounter or is a
  `claim`-stage artifact.
- **Where:** `NotionRepository.js:436-440`.
- **Severity:** high
- **Why it matters:** The artifact pointer is the audit trail — SCHEMA.md calls
  it the thing that makes a submitted claim still resolve to the record it came
  from. An artifact ID from another encounter satisfies both existence checks,
  and so does a `facts` artifact, producing a claim whose stated provenance
  points at another patient's record or at content that is not a claim.
- **Proposed change:** Parse the fetched artifact and reject a mismatched
  `encounter_id` or a non-`claim` stage. Repository-only. Worth running a
  read-only check over existing Claim rows first, since the new check would
  start failing writes that reference an already-wrong pairing.

### S6. Live select vocabularies that no repository constant covers

- **What:** Four live select properties have option sets the repository does not
  declare or validate on write.
- **Where:** Encounters `status` (live: `draft | reviewed | submitted`) with no
  constant and no validation in `updateEncounterStatus`
  (`NotionRepository.js:358`); Documents `extraction_status` (live:
  `none | pending | complete`, only `none` ever written, `:630`); Payer Feedback
  `claim_status` (9 live options) and `recommended_route` (8 live options),
  written unvalidated at `:549-550`.
- **Severity:** medium
- **Why it matters:** Notion creates a new select option on write rather than
  rejecting an unknown value, so a typo or a renamed pipeline constant
  permanently adds a bogus option to the database and every later filter on that
  column silently misses those rows. `claim_status` and `recommended_route` come
  straight from `parseRemittance.js` and `analyzeRemittance.js`; the live option
  lists happen to match those modules exactly today, and nothing keeps them
  matching. SCHEMA.md's own rule is that a select property gets a constant and a
  write-time check.
- **Proposed change:** Add `ENCOUNTER_STATUSES`, `EXTRACTION_STATUSES`,
  `FEEDBACK_CLAIM_STATUSES` and `RECOMMENDED_ROUTES` as module constants and
  validate on write. No migration — the live option sets already match the
  values the code produces, so this is a guard against future drift, not a
  rewrite.

### S7. Every free-text read returns only the first rich_text item

- **What:** `richText` reads `rich_text[0]` and drops the rest; writers emit a
  single unchunked item that Notion rejects over 2000 characters.
- **Where:** `NotionRepository.js:34`, used for `case_title`, `name`,
  `payer_name`, `member_id`, `storage_ref` and every foreign key; writers at
  `:249`, `:285`, `:456`.
- **Severity:** medium
- **Why it matters:** `case_title` is generated from the model's extracted chief
  complaint (`server.js:172`), which has no length bound — over 2000 characters
  the case create call fails outright. And any value that arrives as more than
  one rich_text item (edited in the Notion UI, pasted with mixed formatting) is
  read back truncated to its first fragment with no error anywhere.
- **Proposed change:** Use `richTextAll` for the free-text fields (it already
  exists), and cap generated titles at write time. The read change is backward
  compatible; no migration.

### S8. `createClaim` queries the Artifacts data source without the configuration guard

- **What:** The artifact lookup uses `this.artifactsDataSourceId` with no
  `_requireArtifactsDataSource()` call, unlike every sibling path.
- **Where:** `NotionRepository.js:439` (contrast the guard at `:429`).
- **Severity:** low
- **Why it matters:** On a deploy configured with Claims but not Artifacts —
  possible, since `index.js` treats them as separate env vars — this sends
  `data_source_id: undefined` to Notion and surfaces as an opaque Notion API
  error instead of the clear config error every other method gives.
- **Proposed change:** Add the guard. One line, no migration.

---

## 2. Naming inconsistencies

### N1. The same enum vocabularies are declared in two files

- **What:** `STAGES` and `CREATED_BY_VALUES` are duplicated verbatim in the
  server as `ENCOUNTER_ARTIFACT_STAGES` and `ARTIFACT_AUTHORS`, and
  `ENCOUNTER_STATUSES` exists only in the server.
- **Where:** `NotionRepository.js:23-24` vs `server.js:438`, `:442`, `:470`.
- **Severity:** medium
- **Why it matters:** SCHEMA.md places vocabularies in the repository, validated
  on write. With two copies, adding a stage in one file gives either an endpoint
  that accepts a value the repository rejects, or a repository that accepts a
  value no endpoint can send — and the failure only shows up at runtime on the
  one path that uses the stale list. Encounter status is worse: the server list
  is the *only* check, so any other caller of `updateEncounterStatus` writes
  free text into a select.
- **Proposed change:** Export the constants from `NotionRepository.js` and
  import them in `server.js`; add `ENCOUNTER_STATUSES` to the repository and
  validate it in `updateEncounterStatus`. No migration.

### N2. `created_at` is read from a property that exists on one database out of seven

- **What:** Only Patients carries a real `created_at` created_time property; the
  other six fall through to the Notion page's own `created_time`. `parseCase`
  does not expose `createdAt` at all.
- **Where:** Live schema (Patients has `created_at`; Cases, Encounters,
  Artifacts, Claims, Documents, Payer Feedback do not);
  `NotionRepository.js:75, 97, 110, 127, 150, 171` for the lookup, `:79-88` for
  the omission in `parseCase`.
- **Severity:** medium
- **Why it matters:** Ordering is load-bearing —
  `listClaimsForEncounter`, `listAllClaims`, `listPayerFeedbackForClaim` and
  `getClaimChain` all sort on `createdAt`, and today they are all sorting on the
  page timestamp via a fallback. Add a `created_at` property to one of those
  databases later and that one database's ordering semantics change under
  unchanged code. Separately, a Case object with no `createdAt` means the
  activity feed cannot date a case without walking its encounters.
- **Proposed change:** Pick one and apply it everywhere — either add the
  `created_at` property to the other six databases (additive, no row rewrite,
  but seven schema edits) or delete the property lookup and read
  `page.created_time` directly (one file, no schema change). Either way, add
  `createdAt` to `parseCase`.

### N3. An empty foreign key reads back as `""` on two entities and `null` on two others

- **What:** `parseClaim` and `parseDocument` coalesce an empty FK to `null`;
  `parseCase` and `parseEncounter` leave it as `""`.
- **Where:** `NotionRepository.js:120` and `:105` vs `:82` and `:93-94`.
- **Severity:** low
- **Why it matters:** SCHEMA.md already flags the write-side inconsistency
  (select omitted, rich_text `""`). The read side adds a third variant, so
  `if (claim.parentClaimId)` and `if (encounter.caseId)` are not the same test,
  and the frontend receives both shapes across the API for the same concept.
- **Proposed change:** Coalesce every FK to `null` on read. Read-side only, no
  migration; the frontend already handles `null` for the two that do it.

---

## 3. Compliance-field gaps

These are fields a reviewer of a system handling clinical records would expect
to find. Their absence is a gap in what the schema can evidence — not a legal
finding, and SCHEMA.md already settles that the prototype has no encryption,
audit log or retention policy.

### C1. The synthetic-only rule has no field behind it

- **What:** No property on any entity records that a record is synthetic.
- **Where:** All seven live databases. The only markers anywhere are
  `usageIndicator: "T"` inside the outbound Stedi payload
  (`buildStediClaim.js:179`) and the word "synthetic" inside a hardcoded patient
  name string (`populateClaim.js:112`) — neither is a column.
- **Severity:** high
- **Why it matters:** The project's hardest standing rule is synthetic data
  only, and it is currently enforced by convention and by people remembering.
  "Is every row in Patients synthetic?" cannot be answered without reading the
  rows, which is precisely the thing you do not want to have to do. A single
  real record pasted in during a demo would be indistinguishable from the rest.
- **Proposed change:** Add `is_synthetic` (checkbox) to Patients and Claims,
  written `true` on create and never by a caller. Additive schema change;
  existing rows need a one-time backfill script.

### C2. No provenance on any state change

- **What:** Claim status transitions, payer control-number writes, case closure
  and encounter status changes all overwrite in place with no record of who
  changed them or when.
- **Where:** `NotionRepository.js:470` (`updateClaimStatus`), `:504`
  (`setPayerClaimControlNumber`), `:306` (`closeCase`), `:358`
  (`updateEncounterStatus`). Only Artifacts carry authorship, and only as
  `system | provider_edit` with no identity behind it.
- **Severity:** high
- **Why it matters:** "Who moved CL014 from draft to submitted, and when?" is
  the first question anyone reviewing a billing system asks, and the row can
  only answer "it is submitted" plus a date the code itself wrote. Artifacts are
  append-only precisely because someone already decided a record needs a trail;
  the claim lifecycle has none.
- **Proposed change:** An append-only status-event slot rather than more columns
  — either a new `ClaimEvent` entity or a reserved artifact stage. Additive, no
  rewrite of existing rows; it does touch the API, since History would read it.

### C3. Fields the claim asserts that the database cannot substantiate

- **What:** The 837P payload states facts about the patient, the service and the
  patient's consent that no row in the schema carries.
- **Where:** `buildStediClaim.js:126-137` (subscriber gender, DOB, address,
  member ID — all hardcoded) and `:171-174`
  (`releaseInformationCode`, `benefitsAssignmentCertificationIndicator`,
  `signatureIndicator`, all constant `"Y"`). Patients carries only
  `name` + `date_of_birth`; Encounters carries no place of service or rendering
  provider; Claims carries no charge amount, prior-auth number or
  accept-assignment.
- **Severity:** medium
- **Why it matters:** Every submitted claim attests that the patient authorised
  release of information and assigned benefits, and that a signature is on file.
  Nothing in the schema records that any such authorisation was ever given, so
  the attestation cannot be supported if it is ever questioned. The same is true
  in a smaller way for subscriber demographics: the claim states a sex, an
  address and a member ID that the Patient row does not hold.
- **Proposed change:** Take the consent fields first — three dated fields on
  Patient (or a small `Consent` slot) is a narrow, additive change and is the
  one a reviewer names. The demographic and coverage fields belong with the
  Coverage entity implied by M2 below, and are a larger piece of work.

### C4. The schema has nowhere to put a retention or deletion decision

- **What:** No `deleted_at`, no retention class, no tombstone on any entity.
- **Where:** All seven live databases; `closeCase`
  (`NotionRepository.js:306`) closes a case without touching its encounters,
  artifacts or claims.
- **Severity:** medium
- **Why it matters:** CLAUDE.md already says there is no retention policy. The
  part worth naming is structural: because there is no field for it, adding
  retention later is a migration touching every entity rather than a policy
  change. A request to remove one patient's record today has no mechanism at
  all, since artifacts are deliberately append-only.
- **Proposed change:** Do not add a field to a prototype for this. Record it in
  SCHEMA.md as a named requirement of the production schema, so the Postgres
  implementation starts with it rather than retrofitting it.

### C5. A provider SSN slot is documented, read by nothing, and stored in plaintext

- **What:** The provider profile shape documents an optional `ssn`; no code
  reads it, `validate()` does not check it, and `buildStediClaim` uses `ein`
  only.
- **Where:** `backend/src/providerProfiles.js:77` (JSDoc); store written
  unencrypted at `:46-49` on Render's ephemeral disk.
- **Severity:** medium
- **Why it matters:** A documented field invites someone to fill it in. If one
  ever is, the app gains a plaintext SSN on disk that nothing in the product
  needs and no path ever reads back — cost with no corresponding function.
- **Proposed change:** Remove `ssn` from the documented shape until an 837P path
  actually requires it (the sole tax identifier in use is `employerId`/EIN).
  JSDoc and SCHEMA.md only; if any stored profile already carries one, that file
  needs clearing separately.

---

## 4. Schema ↔ pipeline mismatches

### M1. The date of service is invented at populate time while the encounter holds the real date

- **What:** `populateClaim` sets `dateOfService` from the server clock; the
  visit's actual date is already stored on the Encounter row.
- **Where:** `backend/src/pipeline/populateClaim.js:135`
  (`new Date().toISOString().slice(0, 10)`); the stored value is Encounters
  `occurred_at` (written at `NotionRepository.js:336`). Consumed at
  `buildStediClaim.js:45` and `:105`.
- **Severity:** high
- **Why it matters:** `populateClaim` is never handed the encounter, so a claim
  drafted today for a visit three weeks ago is billed with today's date — then
  rounded back to yesterday UTC by `safeServiceDate`. A wrong date of service is
  a denial, and against a real payer it is a misstatement of when care was
  given. It also detaches the filing-deadline clock in `analyzeRemittance`,
  which takes `dateOfService` from a separate caller-supplied argument
  (`server.js:499`) that may or may not agree.
- **Proposed change:** Pass the encounter's `occurredAt` into `populateClaim`
  and use it, falling back to today only when there is no encounter. Touches the
  pipeline function signature and `/api/populate-claim`; no migration, though
  already-stored claim artifacts keep the wrong date.

### M2. The claim's patient block is a hardcoded placeholder even when a Patient row exists

- **What:** Every populated claim carries the same synthetic patient name, DOB,
  sex and member ID, and that placeholder member ID is then written onto the
  Claim row.
- **Where:** `populateClaim.js:111-116`; consumed at `buildStediClaim.js:126-131`;
  stored as Claims `member_id` at `server.js:767` and `:853`.
- **Severity:** high
- **Why it matters:** The Claims database's `member_id` column holds the same
  literal on every row while the Patient row for that encounter holds a
  different name and date of birth — the database disagrees with itself about
  who was treated, and the payer-facing document follows the placeholder. It
  also means the Patient entity's fields are never exercised by the claim path
  at all, so a bug in them would not show up until the day they are wired in.
- **Proposed change:** Resolve encounter → case → patient inside the populate
  route and fill the patient block from the row, keeping the placeholder only
  for an encounter with no patient attached. Touches the pipeline signature and
  the route; existing Claim rows keep the placeholder `member_id` unless
  backfilled. The coverage fields the claim also needs (sex, address, payer,
  member ID) have no home yet — see C3.

### M3. The identifier that ties a claim to its remittance is thrown away at both ends

- **What:** The patient control number sent to the payer is a timestamp, and the
  one the payer returns is parsed and then dropped from the parser's output.
- **Where:** `buildStediClaim.js:158` — `claim.claimId` is not a field
  `populateClaim` emits, so this is always `ruby-<epoch ms>`;
  `parseRemittance.js:172` reads CLP01 into `patientControlNumber`, and the
  returned object at `:215-226` omits it. No Claims column stores either value.
- **Severity:** high
- **Why it matters:** CLP01 is how an 835 says which of your claims it is
  answering. Ruby sends a value it never stores and reads back a value it
  discards, so filing a remittance depends entirely on a human calling
  `/api/claims/:claimId/remittance` with the correct claim ID. `ingestRemittance`
  already counts the other claims in a multi-claim 835 (`:115`) and has no way
  to route any of them.
- **Proposed change:** Set `patientControlNumber` from the Claim row's
  `claim_id`, add `patientControlNumber` to `parseRemittance`'s output, and match
  on it during ingest. No new column is strictly needed. It does reorder the
  submit path — the Claim row has to exist before the payload is built, which
  `persistClaimDraft` already makes true for the normal flow.

### M4. An appeal is stored as a corrected claim with its letter smuggled into a claim artifact

- **What:** There is no `appeal` claim type and no `appeal` artifact stage, so
  appeals are written as `corrected` claims and the letter rides along as extra
  keys on a claim-stage artifact.
- **Where:** `server.js:1060-1075`; vocabularies at `NotionRepository.js:23` and
  `:25`. The code says so in its own comment at `server.js:996`.
- **Severity:** medium
- **Why it matters:** "How many denials did we appeal, and how many were
  overturned" cannot be answered by a query, because the Claims database cannot
  tell an appeal from a correction. And the claim-stage artifact now has two
  possible shapes — `populateClaim`'s output, or that output plus
  `appealLetter` and `appealOfClaimId` — so anything reading a claim artifact
  has to handle both.
- **Proposed change:** Add `appeal` to `CLAIM_TYPES` and an `appeal` stage to
  `STAGES`. Both are Notion select options, so the schema change is additive and
  existing rows are unaffected; History's bucket logic and `renderClaimActions`
  would need to recognise the new type, and existing appeal rows would stay
  mislabelled as `corrected` unless backfilled.

### M5. The denial loop's money and deadlines exist only inside a JSON blob

- **What:** Payer Feedback promotes exactly one number to a typed column;
  everything else the analysis produces lives in `content`.
- **Where:** typed column `amount_at_risk` (`NotionRepository.js:551`); inside
  the blob: `billed`, `paid`, `patientResponsibility`, `contractualWriteOff`,
  `filingDeadline`, `appealDeadline`, `unadjudicatedLines`
  (`analyzeRemittance.js:188-214`, stored at `ingestRemittance.js:102`).
  Claims has no charge-amount column at all; the billed figure is computed from
  a hardcoded $100 per line at `buildStediClaim.js:109`.
- **Severity:** medium
- **Why it matters:** "Which claims have an appeal deadline inside seven days"
  and "what did we write off last month" are the two questions the denial loop
  exists to answer, and neither can be a query — every caller must fetch every
  feedback row and `JSON.parse` it. `amount_at_risk` is also a number with no
  stored denominator, since nothing records what the claim was billed for.
- **Proposed change:** Promote `paid`, `patient_responsibility`,
  `contractual_write_off` and `appeal_deadline` to typed columns on Payer
  Feedback, and add `charge_amount` to Claim. Additive columns; backfilling the
  existing rows means reading each `content` blob and rewriting it, which is a
  script someone runs and watches.

### M6. Validation and grounding verdicts are unreachable by query

- **What:** The two review signals the pipeline computes — whether a code is
  recognised, and whether a medical-necessity quote is actually in the
  transcript — are written inside artifact JSON.
- **Where:** `validateCodes.js:44` writes `validation.status` onto each
  suggestion, persisted at `server.js:741`; `verifyQuotes`' result is attached as
  `facts.medicalNecessityGrounding` at `server.js:678`, persisted at `:688`.
- **Severity:** medium
- **Why it matters:** "Show me every claim carrying an unrecognised code" and
  "every claim whose necessity quote was unsupported" are exactly the review
  queues this pipeline is built to feed. Neither can be built without reading and
  parsing every artifact in the database. The `unsupported` verdict matters most:
  it means the claim asserts a justification the transcript does not carry, and
  today that fact is visible only to whoever happens to open that one claim.
- **Proposed change:** Derive two flags onto the Claim row when the draft is
  written — `has_unrecognised_code` and `has_unsupported_necessity_quote`.
  Additive columns plus a write in the populate route; existing rows simply stay
  empty, and nothing needs migrating.

### M7. Every claim carries provider identity that no row references

- **What:** The billing provider's NPI and employer ID go out on every claim,
  but no Claim column names which provider profile they came from.
- **Where:** `backend/src/providerProfiles.js` (a JSON file on ephemeral disk),
  read at `server.js:785`, carried into the claim at `populateClaim.js:123` and
  onto the wire at `buildStediClaim.js:139-154`. Claims has no provider column.
- **Severity:** medium
- **Why it matters:** Render wipes that disk on redeploy. After one, the profile
  is gone, `getProviderProfile` returns null, and the next claim silently falls
  back to the published Stedi test NPI with a `NO_PROVIDER_PROFILE` warning that
  is itself only stored inside the claim artifact JSON. Which provider a
  submitted claim actually billed under survives only in that blob.
- **Proposed change:** Add `provider_id` to Claim as a soft text FK, following
  the existing convention, even before a Providers database exists — so the row
  records which profile was used. Additive column, write-side only; old rows
  stay empty. (Moving the profile store itself off ephemeral disk is a separate
  decision and is not a schema change.)

---

## 5. Revisit

Nothing found this run. Every Settled decision in `SCHEMA.md` still holds as
written; the drifts reported above (S6 on Encounter status, N1 on duplicated
vocabularies) are the code moving away from the doctrine, not the doctrine being
wrong.

One correction to the doctrine's own status table, for the next editor rather
than as a finding: `Encounter.status` is documented as "`draft` (only value
written today)", but `server.js:860` writes `submitted` on every successful
submission and `/api/encounters/:id/status` accepts `reviewed` as well. All three
options exist in the live database.

---

*No schema changes were made. Everything above is a proposal awaiting a decision.*
