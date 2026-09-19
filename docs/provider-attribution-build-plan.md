# Provider attribution & patient data — build plan

Built from the Notion handoff "Provider Attribution & Patient Data MVP —
Handoff for Claude Code" (13 Sep 2026) and verified against `master` at
`3e3fa3e` on 18 Sep 2026. Everything in "Current state" was read out of the
code, not recalled. If you pick this up later, re-check that section first.

Read `docs/data/SCHEMA.md` before touching anything. Its Settled decisions
list is binding; nothing here relitigates it.

---

## What this is, in plain language

Today the app cannot answer two questions a real claim needs answered:

1. **Who did this?** A claim is a legal assertion by a named provider, but no
   row anywhere says which provider created, edited or submitted it. The only
   trace is `Artifact.created_by`, which says `system` or `provider_edit` —
   a *kind* of actor, not an actor.
2. **Who is the patient, beyond a name and birthday?** A claim needs the
   patient's sex and whether they are insured. Both are canned placeholders in
   `populateClaim.js` because the Patient row has nowhere to hold them.

This plan adds the cheapest honest version of both: two fields on Patient, a
`provider_id` stamped on every Claim and Artifact at creation, and a small
append-only log that records who did what to which claim or artifact, when.

It is **additive only**. Nothing existing changes shape, no row is rewritten,
and the three open audit findings the handoff names (hardcoded patient block,
silent artifact-write failures, claim↔remittance key) stay open and untouched.

---

## Current state (read from the code)

**Patient** — `parsePatient` (`NotionRepository.js:70`) reads `patient_id`,
`name`, `date_of_birth`, `created_at`. `createPatient` (`:240`) requires name
and DOB and writes nothing else. `POST /api/patients` (`server.js:283-297`)
accepts `{ name, dateOfBirth }`. The frontend posts exactly that from the
Patients route (`index.html:1345`) and reads patients in the intake modal
(`:4975`).

**Claim placeholders** — `PLACEHOLDER_PATIENT` (`populateClaim.js:12-17`)
carries `sex: "U"` and `memberId: "SAMPLE-0001"`. `buildClaimContext`
(`server.js:166-180`) already passes real `name` and `dateOfBirth` from the
Patient row when there is an encounter; sex is never passed. `buildStediClaim.js:130`
maps `claim.patient.sex` to X12 `gender`, accepting only `M`, `F`, else `U`.

**Provider identity** — `PROVIDER_PROFILE` is `backend/src/providerProfiles.js`,
a JSON file keyed by `providerId`, `DEFAULT_PROVIDER_ID = "default"`. The
populate route already accepts an optional `providerId` in the body
(`server.js:862`) and falls back to the default. No repository method takes a
provider.

**Where Claim rows are created** (all in `server.js`):
`persistClaimDraft` (`:820-846`), `persistSubmittedClaim` fallback (`:926`),
the correction route (`:1053`), the appeal route (`:1161`).

**Where `Claim.status` is mutated:** `persistSubmittedClaim` (`:922`, `:933`),
correction (`:1077`), appeal (`:1185`), and — outside `server.js` —
`ingestRemittance.js:132`, which moves a claim to
`accepted | rejected | denied | pending` from an 835.

**Where Artifact rows are created:** `persistArtifact` (`server.js:150`)
from the extract, suggest-codes and populate routes; and the re-attach route
(`:490-515`) for provider edits.

**Vocabulary constants** live at `NotionRepository.js:23-28`: `STAGES`,
`CREATED_BY_VALUES`, `CLAIM_TYPES`, `CLAIM_STATUSES`, `DOCUMENT_SOURCES`,
`FEEDBACK_TYPES`. Each `select` write checks its constant. `updateClaimStatus`
(`:470`) is the pattern to copy.

**Optional data source pattern** — `NOTION_PAYER_FEEDBACK_DATA_SOURCE_ID`
(`repository/index.js:24-27`) is the precedent for adding a data source
without taking persistence down on a deploy that lacks it: not in the
`missing` list, and the methods that need it throw a clear config error.

**Tests** — `backend/test/NotionRepository.test.js` runs against
`fakeNotionClient()`, an in-memory stand-in with one `Map` per data source.
A new data source needs a new store and a `storeFor` branch there.

### Where the handoff's line references have drifted

- `persistArtifact` is at `server.js:150`, not `:143`.
- `populateClaim.js:135` "hardcoded date" — the date of service now comes from
  `context.dateOfService` (`:120`); the handoff's instruction still holds:
  do not touch it.
- `populateClaim.js:111` "hardcoded patient block" is `PLACEHOLDER_PATIENT` at
  `:12-17`. Step 1 reads *around* it (adds sex to the context); it does not
  restructure it.

---

## Decisions to settle before starting

The handoff says to stop and ask rather than guess on three things. Two of
them come up in step 1, so settle them now. My recommendation is first.

**1. What are the `sex` values?**
Recommended: `male | female | unknown`, lowercase words like every other
select in the store (`self_pay`, `provider_edit`). `populateClaim` maps them
to `M | F | U` for the claim, which is what `buildStediClaim` already expects.
Storing `M | F | U` directly would also work but breaks the naming convention.

**2. Is `insurance_status` exactly `self_pay | insured | pending`?**
Recommended: yes, ship these three. The handoff predicts payer-specific
statuses will come up fast; when they do, that is a new constant value plus a
`SCHEMA.md` row, not a redesign. Don't pre-add values nothing writes.

**3. What does the log say for a *failed* artifact write?**
There is no `artifact_id` when the write failed. Recommended: `entity_type:
"artifact"`, `entity_id: ""`, `action: "created"`, and `detail` naming the
encounter, stage and error — `"persist failed · encounter E001 · stage facts ·
<err.message>"`. That keeps the vocabulary at two entity types as the handoff
specifies. The alternative — adding `encounter` as an entity type — is cleaner
but widens the schema, and the handoff says not to.

The fourth flag — *should artifact-write failures now hard-fail?* — is a
behaviour change beyond scope. The plan below logs them and continues,
exactly as today. Raise it in the PR description, don't act on it.

---

## Build order

Five steps, in the handoff's order. Each is independently shippable and each
leaves the store and code in agreement. **Three PRs**, not one: step 1 alone,
step 2 alone, steps 3–5 together. A reviewer can hold the whole of each in
their head, and an additive change that goes wrong is easy to revert when it
travels alone.

Every step ends the same way: run the four test commands, boot the server,
and confirm a row written *before* the change still reads back without error.

### Step 0 — Notion and environment prep (manual, no code)

*Plain English: make room in the database before the code tries to write
there.*

In Notion, by hand:

- **Patients** database: add `sex` (select) and `insurance_status` (select).
  Pre-create the options from decisions 1 and 2 above so the first write
  matches an existing option rather than minting one.
- **Claims** database: add `provider_id` (text).
- **Artifacts** database: add `provider_id` (text).
- New **Audit Log** database with: `log_id` (title), `provider_id` (text),
  `entity_type` (select: `claim`, `artifact`), `entity_id` (text), `action`
  (select: `created`, `edited`, `status_changed`, `submitted`, `approved`),
  `detail` (text), `created_at` (created time).

Then copy the Audit Log data source ID into `backend/.env` as
`NOTION_AUDIT_LOG_DATA_SOURCE_ID` and add it to `backend/.env.example` with a
comment. Do **not** set it on Render until step 3 has shipped — an env var
pointing at a database no code reads is harmless, but setting it later means
the deploy that gains the code and the deploy that gains the config are
separate, and each can be checked on its own.

### Step 1 — `sex` and `insurance_status` on Patient (PR 1)

*Plain English: let a patient record say what sex they are and whether they
have insurance, and let the claim use it instead of a placeholder.*

Order of work — vocabulary first, on purpose:

1. `NotionRepository.js:23-28` — add `PATIENT_SEXES` and
   `INSURANCE_STATUSES` constants next to the others.
2. `parsePatient` (`:70`) — read both with `selectValue`; absent → `null`.
3. `createPatient` (`:240`) — accept optional `sex` and `insuranceStatus`.
   If a value is present and not in its constant, throw
   `NotionRepositoryError`; if absent, **omit the property** (the store's
   convention for "not applicable" — see SCHEMA.md "Absent values"). Never
   write a placeholder.
4. `Repository.js:31` — widen the `createPatient` JSDoc to name the two new
   optional inputs. There is no `updatePatient`; don't add one in this step.
5. `POST /api/patients` (`server.js:283`) — pass `sex` and `insuranceStatus`
   through from the body. A bad value surfaces as the repository's 400, same
   as today's validation errors.
6. `buildClaimContext` (`server.js:166`) — add `sex: patient.sex` to the
   `patient` object it returns.
7. `populateClaim.js` — where the context patient overrides the placeholder,
   map `male → M`, `female → F`, anything else → `U`. Leave
   `PLACEHOLDER_PATIENT` itself alone; the claim's own warning about invented
   fields should stop mentioning sex only when a real value was supplied.
8. Frontend — two labelled `<select>`s in the Add patient form on the Patients
   route and in the intake modal's new-patient path. Both optional, both use
   `.field-grid` + `<label>`, first option blank. Show them in the patient
   record subtitle after the DOB (`index.html:1794`) so the value is visible
   somewhere once entered.
9. `docs/data/SCHEMA.md` — Patient row in the entities table ("Name and date
   of birth only" is no longer true); two rows in Status vocabularies; note
   both as PHI.

Tests (`NotionRepository.test.js`): creates with both fields and reads them
back; creates with neither and reads `null` for both; rejects an unknown sex
with `NotionRepositoryError`; a page with no `sex` property at all parses to
`null` (this is the "rows written before this change" case).
`pipeline.test.js`: `populateClaim` with `context.patient.sex = "female"`
yields `F`; with no sex yields `U`.

### Step 2 — `provider_id` on Claim and Artifact (PR 2)

*Plain English: stamp every claim and every pipeline output with which
provider it belongs to, so there is something for the log to point at.*

1. `parseClaim` (`:114`) and `parseArtifact` (`:154`) — read `provider_id`
   with `richText`; `""` parses to `null`, matching the other soft FKs.
2. `createClaim` (`:428`) and `createArtifact` (`:370`) — accept optional
   `providerId`, write it as `rich_text` (`""` when absent). **No validation
   against `PROVIDER_PROFILE`** — the repository must not import
   `providerProfiles.js`; it is a soft FK like every other.
3. `Repository.js` — add the field to both create signatures' docs.
4. Every creation call site in `server.js` passes `providerId`. Source it once:
   a small `resolveProviderId(req)` that returns `req.body?.providerId ||
   DEFAULT_PROVIDER_ID`. `persistArtifact` and `persistClaimDraft` gain a
   `providerId` parameter rather than reading it themselves — they are called
   from routes that already have the request. The re-attach route (`:490`)
   is a provider edit and passes the same thing.
5. `SCHEMA.md` — `provider_id` on Claim and Artifact in the connections
   section, with a sentence that it is the seam where multi-tenant attaches
   and that today every row carries `default`.

**Do not** go near `getClaimChain` (`Repository.js:200`) or `parent_claim_id`.
A new column on Claim is safe; logic near the chain traversal is out of scope.

Tests: create a claim with and without `providerId`, read both back; a claim
page lacking the property parses to `null`; the same pair for artifacts.

### Step 3 — `AUDIT_LOG` data source and repository methods (PR 3, part 1)

*Plain English: build the notebook, but don't write in it yet.*

1. `repository/index.js` — read `NOTION_AUDIT_LOG_DATA_SOURCE_ID`, optional,
   with the same comment shape as payer feedback (`:24-27`). Pass it to the
   constructor. Add `_requireAuditLogDataSource()` beside
   `_requireArtifactsDataSource`.
2. Constants: `AUDIT_ENTITY_TYPES = ["claim", "artifact"]`,
   `AUDIT_ACTIONS = ["created", "edited", "status_changed", "submitted",
   "approved"]`.
3. `parseAuditEntry(page)` → `{ logId, providerId, entityType, entityId,
   action, detail, createdAt }`.
4. `createLogEntry({ providerId, entityType, entityId, action, detail })` —
   validate the two selects against their constants, mint `LOG001` with
   `_nextSequentialId`, write. `detail` through `chunkedRichText` so a long
   error message cannot fail the write.
5. `getLogForEntity(entityType, entityId)` — query filtered on both, return
   parsed entries oldest first.
6. `Repository.js` — both methods on the interface, throwing
   `NotImplemented` like the rest.
7. `SCHEMA.md` — an eighth entity row (`LOG001`), its connections, the two
   vocabularies, and **rewrite the settled decision "No encryption at rest,
   no audit log, no retention policy"**: there is now a log, it is not
   tamper-evident, and that is the known limitation. `CLAUDE.md`'s first
   paragraph says "no audit logging" — change that in the same PR.

Tests: fake client gains `ds_audit_log`; create an entry and read it back by
entity; two entries for one entity come back in order; unknown action throws;
methods throw the config error when the data source ID is missing.

### Step 4 — Write log entries at the named points (PR 3, part 2)

*Plain English: start writing in the notebook — at exactly six places, one at
a time, checking each produces a real row before moving on.*

First, one helper so a log failure can never become a second silent failure:

```
backend/src/auditLog.js
  export async function recordAudit(repository, entry)
```

It calls `repository.createLogEntry(entry)` inside `try/catch`. On failure it
`console.error`s **loudly, with the entry** and returns `false`. It never
throws, never blocks and never rolls back the write it describes — visibility,
not a dependency. When `repository` is null it returns `false` without
logging; that is the "no repository configured" case and is not an error.

Then wire it, in this order, verifying a row lands in the Audit Log database
after each before touching the next:

| # | Where | `entity_type` | `action` | `detail` |
|---|---|---|---|---|
| 1 | `persistClaimDraft` after `createClaim` (`server.js:839`) | claim | created | `"draft from <artifactId>"` |
| 2 | `persistSubmittedClaim` after each `updateClaimStatus` (`:922`, `:933`) | claim | status_changed | `"status: draft -> submitted"` |
| 3 | Correction route after `createClaim` and after `updateClaimStatus` (`:1053`, `:1077`) | claim | created / status_changed | `"corrected claim of <parentClaimId>"` |
| 4 | Appeal route, same pair (`:1161`, `:1185`) | claim | created / status_changed | `"appeal of <parentClaimId>"` |
| 5 | `ingestRemittance.js:132` after `updateClaimStatus` | claim | status_changed | `"status: <old> -> <new> (835)"` |
| 6 | `persistArtifact` (`server.js:150`) — success **and** failure | artifact | created | success: `"<stage> v<version>"`; failure: per decision 3 |

Notes on the table:

- `providerId` for rows 1–4 and 6 is the same value step 2 stamped on the row.
  For row 5 the remittance route has no provider in the request; use the
  claim's own `providerId` (read it back from the row), falling back to
  `DEFAULT_PROVIDER_ID`. That is the one place the log's actor is "whoever
  owns the claim" rather than "whoever made the request" — say so in a
  comment.
- Row 5 needs the old status for the detail string; `ingestRemittance`
  already has the claim in hand before it updates.
- Row 6's success case needs the artifact the repository returned;
  `persistArtifact` currently discards it — keep the return value.
- The re-attach route (`:490`) is a provider edit; log it as `artifact /
  edited`. It is not in the handoff's list, but it is the one place a
  *person* changes an artifact, and skipping the human edit while logging the
  machine writes would invert the point of the log. Flag it in the PR as the
  one addition.
- `deleteClaim`, `closeCase`, `setPayerClaimControlNumber` are **not** logged.
  The handoff scopes the log to the listed points; the audit's C2 finding
  names these and they stay open.

Tests: `persistence.test.js` (or a new `auditLog.test.js`) — `recordAudit`
returns `false` and does not throw when `createLogEntry` rejects; returns
`false` with no repository; passes the entry through unchanged on success.
For the call sites, a fake repository that records calls and asserts each
route makes the expected `createLogEntry` call with the expected shape.

### Step 5 — Nothing more

*Plain English: stop here. No page, no tab, no button.*

`getLogForEntity` exists and is callable. There is deliberately no UI in this
MVP. If the record view wants to show the trail later, that is a new section
in `renderDetailView`'s `sections` list, filled by name, per `CLAUDE.md` — a
separate PR with its own definition-of-done checklist.

---

## Guardrails, made concrete

These are the handoff's guardrails restated as checks you can run.

- **Every new field is optional.** Test: parse a page object with none of
  `sex`, `insurance_status`, `provider_id` present and get `null`s, not a
  throw. Test: `createPatient({ name, dateOfBirth })` with nothing else still
  succeeds. No write path rejects a row for lacking these.
- **Vocabulary locked before the first write.** In each PR, the constant lands
  in the same commit as (or an earlier commit than) the write path. The
  schema audit's S6 finding is the failure mode; do not add a fifth example.
- **`getClaimChain` untouched.** `git diff master -- backend/src/repository/`
  shows no hunk inside `getClaimChain` or `parseClaim`'s `parentClaimId` line.
- **The log never blocks or rolls back.** `recordAudit` is the only caller of
  `createLogEntry` outside tests; it has a `try/catch`; nothing awaits it in
  a position where a rejection would skip the underlying write. Check by
  making the fake `createLogEntry` reject and asserting the claim still
  saves.
- **The three open findings are untouched.** `git diff master --stat` shows
  `populateClaim.js` changed only in the sex mapping, and no change to
  `buildStediClaim.js:158` or `parseRemittance.js:172`.

---

## Before merging PR 3

1. All four test commands pass, plus `node eval/run.mjs --mock`.
2. Boot the server against the Notion workspace with the new env var set and
   walk one encounter end to end: new patient with sex and insurance → extract
   → codes → populate → submit. Then open the Audit Log database and confirm
   rows 1, 2 and 6 from the table above are there, with `provider_id =
   default`.
3. Open a patient, claim and artifact created **before** any of this shipped
   in the record view and confirm nothing errors.
4. Ask for the `data-model` agent to be run against the branch. It is
   explicit-request-only and costs money, so it is a request to Kaycee, not a
   step to take. The bar: the audit still reports full store/code agreement,
   C2 ("no actor identity") is reported as *narrowed*, not closed, and there
   is no new "no repository constant" finding.
5. PR description states the known limitation: the log lives in the same
   Notion store as everything else, is editable by anyone with page access,
   and is not tamper-evident. Same exposure the PHI/HIPAA Compliance Model
   doc already flags.
6. Only then set `NOTION_AUDIT_LOG_DATA_SOURCE_ID` on Render, and only after
   the merge has been given an explicit go-ahead — master auto-deploys.

---

## Out of scope, restated so it doesn't creep back in

- Multi-tenant providers and any provider-picker UI. `resolveProviderId` is
  the seam; it returns `default` today.
- Tamper-evident storage for the log.
- Eligibility checks (270/271) or an `ELIGIBILITY_CHECK` entity.
  `insurance_status` is a snapshot; changing it overwrites.
- An `updatePatient` method. Nothing in this plan edits a patient after
  creation; if that is wanted it is its own small PR.
- An audit-log page or tab.
- Fixing the hardcoded member ID, the claim↔remittance key, or hard-failing
  on artifact-write errors.
