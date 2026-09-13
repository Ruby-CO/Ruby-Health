# Ruby Health — working notes for Claude

## What this is

A prototype claims tool. It takes a recording of a patient visit, pulls out the
clinical facts, suggests ICD-10 and CPT codes, and drafts an insurance claim for
a human to review.

It is **not** the production system. No encryption at rest, no audit logging, no
retention policy, no BAA.

---

## Standing rules

These are the things most likely to get broken by someone trying to be helpful.

**Synthetic encounters only. Never real patient data.** Not in the app, not in
`reference/codes/`, not in a test fixture. The compliance layer does not exist
yet. See `CONTRIBUTING.md`.

**Code validation warns; it never blocks.** `backend/src/pipeline/validateCodes.js`
flags an unrecognised code and leaves it on the claim. This looks like a missing
feature and is not. The loaded code list is the CMS Section 111 list (Medicare
Secondary Payer reporting), which omits codes that are perfectly valid to bill —
`Z23`, encounter for immunization, is absent. Blocking on an incomplete list
would reject correct codes with total confidence. Hard blocking is P3 work and
waits on a complete ICD-10-CM release. See `reference/README.md`.

**Do not quote an accuracy number from the eval suite.** The answer key in
`eval/encounters/` was written by an AI, not a certified coder. It is a
regression detector — "did this change help or hurt?" — not a statement about
real-world accuracy. A confidently wrong key is worse than none, because it
makes a guess look authoritative.

**The model IDs are correct. Do not "fix" them.** `claude-opus-5` (claim path)
and `claude-haiku-4-5` (transcript cleanup) are real, current model IDs,
verified against the SDK's own `Model` union. They look unfamiliar if your
training data predates them. **Load the `claude-api` skill before touching any
Anthropic API code** — never answer from memory on model names, pricing, or
caching.

---

## Where things live

| Folder | What's in it |
|---|---|
| `backend/` | Express server + the pipeline that calls Claude. The only npm package in the repo. |
| `frontend/` | One file, `index.html` — ~1,460 lines, vanilla JS, no build step, no framework. |
| `eval/` | Accuracy test suite: 20 synthetic encounters, a scorer, a runner. |
| `reference/` | Loader for ICD-10/CPT code lists, used for validation. |
| `docs/` | `mvp-v1-build-plan.html` — the P0–P6 build plan. |
| `test/` | `ui-smoke.mjs`, a browser test. Needs Playwright, which is not a project dependency. |

**Watch out:** folders import across each other, and those paths are
load-bearing. `eval/score.mjs` imports from `../backend/src/pipeline/`, and
`backend/src/server.js` imports from `../../reference/loadCodes.mjs`. Moving
files breaks things quietly.

---

## Running and testing

```bash
cd backend && npm install && npm start     # needs ANTHROPIC_API_KEY in backend/.env
```

**There is no single command that runs all the tests.** There are four:

```bash
cd backend && npm test                  # 23 tests
node --test eval/test/*.test.js         # 19 tests
node --test reference/test/*.test.js    # 14 tests
node eval/run.mjs --mock                # harness check, no API calls, free
```

56 tests total. CI (`.github/workflows/ci.yml`) runs all four plus a boot check.

A root `package.json` would unify them, but Render builds the service with
`cd backend && npm install` and reads config from the repo root — not worth
risking a working deploy to save typing.

**A real eval run costs about $1.50** (one model call per encounter):
`node eval/run.mjs`. `--mock` scores 100% by construction; it proves the harness
works, nothing more.

---

## How the pipeline works

Five stages. The split between "asks Claude" and "plain arithmetic" is the main
design line in this project — keep it sharp.

| Stage | File | Calls a model? |
|---|---|---|
| Clean up transcript | `cleanupTranscript.js` | Yes — cheap model. Leaves the claim path in P2. |
| Extract clinical facts | `extract.js` | Yes |
| Suggest codes | `suggestCodes.js` | Yes |
| Check quotes are real | `verifyQuotes.js` | **No** — string matching |
| Validate codes | `validateCodes.js` | **No** — list lookup |
| Build the claim | `populateClaim.js` | **No** — deterministic |

**Adding a stage that calls Claude?** Follow the existing shape: one async
function taking `(anthropic, model, …)`, a `SYSTEM_PROMPT`, a single forced tool
call, then `recordUsage(stage, model, response)` immediately — so no call
escapes token accounting. Then give every field of `toolUse.input` a default.
Never trust raw model output: `JSON.stringify` drops `undefined` keys, and that
caused a real crash before the defaults were added.

---

## House style

- **Comments say why, not what.** If the code is readable, it doesn't need a
  comment. If a decision looks wrong without context, explain the context.
- **Tests use Node's built-in runner** (`node:test`, `node:assert/strict`). No
  Jest, no Mocha, no Vitest. Files are `<module>.test.js` in a sibling `test/`.
- **Branch off `master`, come back through a PR.** Nothing pushed straight to
  master. See `CONTRIBUTING.md`.
- Auto-deploy on commit is a **prototype-only** arrangement. Production needs
  review gates — that distinction is written down in `CONTRIBUTING.md`.

---

## UI structure

`frontend/index.html` has one set of layout primitives, defined once under
"Shared layout primitives" in the `<style>` block. **Use them. Do not invent a
new heading, box, or empty-state class** — if a new section needs something
these can't express, change the primitive rather than adding a sibling.

Three levels, and nothing between them:

| Level | Class | Rule |
|---|---|---|
| Page | `.page-title` / `.page-subtitle` | **Exactly one per visible view.** Says where you are. |
| Section | `.section-title` | Names the group directly below it. Every group gets one. |
| Item | `.card` (+ `.card-head` / `.card-title` / `.card-subtitle`) | One thing in that group. |

Plus: `.empty-state` for "there's nothing here yet" — the only one. `.tabs` /
`.tab` / `.tabpanel` for tabbed content — the only ones; the left sidebar's
`.nav-item` drives `.tabpanel` too.

Two rules that are easy to break by accident:

- **One page title per view.** A History drill-down renders its own
  `.page-title`; that's why the root's title lives inside `#historyRoot` rather
  than above it. Two at once means the top one is lying about where you are.
- **A section title must not be out-sized by its own contents.** `.section-title`
  is a small uppercase label on purpose — it groups without competing with the
  `.card-title`s underneath it.

Spacing above a section title is handled by the stylesheet
(`.card + .section-title`), so no call site sets its own margin.

**Be wary of adjacent-sibling selectors.** `a + b` breaks silently the moment
anything wraps either element — no error, no visual warning, just spacing or a
separator that quietly stops existing. Two have already done this here: the
Facts card's field spacing, and the hairlines between rows in every History
list, which vanished when rows were wrapped in a link to make them clickable
and stayed missing for weeks. Prefer hanging the rule on the **container**
(`.card-rows > * + *`), which does not care what its children turn out to be.
If you must use a sibling selector, check the computed style in a browser
rather than reading the rule and assuming it matches. JS finds
content by `data-` hooks, not by style class, so restyling can't break behavior.

### Adding a section to a History view

History views are built from a **declared skeleton, filled by name** — never by
appending in document order. To add a section, add it to that view's `sections`
list and fill its slot:

```js
const slots = renderDetailView(historyCaseViewEl, {
  title: caseObj.title,
  subtitle: `${caseObj.caseId} · ${patient.name}`,
  sections: [
    { name: "encounters", title: "Encounters" },
    { name: "notes", title: "Case notes" },     // <- new section goes here
  ],
});
fetchHistoryList(slots.encounters, ...);
loadCaseNotes(slots.notes, ...);                 // lands in its own slot
```

The position is decided by the `sections` list, not by which fetch finishes
first. **Do not `appendChild` onto a view container** — that is what put things
in the wrong place before.

Two more rules for these views:

- **`showHistoryView(name)` is the only way to switch views.** It hides every
  sibling. Hiding them by hand is how opening an encounter from the activity
  feed used to leave the whole root list on screen above it.
- **Tabs come from `buildTabbedPanels()`.** It carries the `role="tablist"` /
  `aria-selected` wiring and arrow-key navigation. Don't hand-roll a tab strip.

### Adding a field to the Facts card or Claim form

Same contract on the New Claim side: the shape is a list, and the code fills
slots by name. `FACT_FIELDS` declares the Facts card's fields (`kind` is
`text`, `chips` or `quotes`); `CLAIM_GROUPS` declares the Claim form's
fieldsets, filled through `renderFieldGroups()`. Adding a field or a group is
an entry in that list — not another `appendChild` in the middle of a render
function.

### Definition of done, for a new view

From the UI navigation conventions page. **New views only** — existing views
are not being retrofitted; they are not costing anything.

- [ ] Browser back and forward work from it
- [ ] Every field naming another object links to that object, and is visibly a link
- [ ] It uses an existing layout slot

A PR without these is incomplete, not "phase one". **A follow-up PR to make the
previous one usable means the first one wasn't done.**

**URL state is deliberately out of scope.** The conventions page has a fourth
item — the view's URL fully restoring it, filters and selection included — and
it has been dropped on purpose while this is a prototype. `pushState` passes a
state object and no URL, so back and forward work while the address bar never
changes.

Two reasons, so this does not get re-proposed every few sessions:

- This is a demo shown by the person driving it. Shareable links, bookmarks and
  surviving a refresh buy almost nothing here, and the retrofit touches every
  view that navigates.
- Frontend routing is the layer that will **not** transfer to the real product,
  which will bring its own router. What transfers is the pipeline
  (`extract`, `suggestCodes`, `populateClaim`, `buildStediClaim`), the
  `NotionRepository` seam and the claim-building logic — so that is where
  hardening pays.

Revisit it if the prototype ever has to be handed to someone to explore
unattended, or if a link to one encounter needs sending to a colleague. Neither
is true today.

### Standing UI constraints

- **Separate the irreversible.** Submit, sign and delete never sit adjacent to
  routine controls. Proximity implies relatedness, and a misclick here sends a
  wrong claim to a payer. `.submit-actions` is where these live.
- **One loud action per screen** — the action the screen exists for. The
  exception is a genuine fork: appeal and amend on a denied claim are equally
  primary, and quieting either would push the provider toward the other.
- **Density is fine; unpredictability isn't.** Every field stays in the same
  place across every claim so reviewers glance instead of read. Group into
  labelled sections, separate with type and space rather than boxes and
  borders, and mark anomalous fields rather than hiding ordinary ones.
- **Deviation needs a reason.** A different button size, new spacing, a one-off
  colour — put the rationale in the PR description, or match the existing
  pattern.
### "Context", not "transcript"

The first stage is **Context** everywhere a provider reads it: what they bring
to the encounter, however they brought it — recorded, pasted or typed.

**The stored stage key is still `transcript`**, and so is the `transcript`
field on the API. That is deliberate, not a half-finished rename: the stage is
a Notion select option carried by every artifact already written, so renaming
it is a data migration. If you rename it, migrate the stored rows in the same
change — and leave the API field alone unless you version the endpoint.

Four ways in: record, upload, paste, type. Upload is **plain text only**
(`attachContextUpload` / `readContextFile`, one implementation used by both the
New Claim card and the record view). A PDF or Word file is a container, not
text — reading one as text drops binary into a clinical record rather than
failing, so those are refused by name with a message that says what to do
instead. Supporting them means a parser and somewhere to keep the file; the
schema's Document slot is reserved for that.

An upload **appends** to whatever is already in the field. Never replace: a
dictated conversation is not something to lose to a stray drop.

### Editing, and workspaces

The four editors — facts, codes, claim and the transcript field — take an
explicit **workspace** rather than reaching for the global `state`. A workspace
is whatever is being edited: `claimWorkspace` (the New Claim session state) or
one built from an encounter's stored artifacts in the record view. It carries
the data plus two calls:

- `touched(stage)` — an edit happened; persist however this workspace does
- `rerender(stage)` — redraw that stage's editor

**A handler must capture its workspace at render time.** Reading a global at
click time would edit whichever record happens to be open seconds later.

The record view is editable until the payer has seen the claim — that is,
until any claim on the encounter leaves `draft` (`encounterIsLocked`). After
that it renders the read-only views with a line saying why, because the record
is what was billed. **If the claims lookup fails, the record stays locked**: it
must not unlock something it cannot vouch for.

Edits write a **new artifact version** with `createdBy: "provider_edit"`, never
an overwrite — so the revision list keeps the trail and a submitted claim still
points at the artifact it was built from. Saves are debounced and always show
their state; a silent save on a medical record is worse than a slow one.

Pipeline actions — extract, suggest codes, populate, submit — stay on New
Claim. The record view edits the record; it does not re-run the pipeline.

### Walking into a step runs it

On New Claim, entering a step runs the stage that fills it — the step buttons
and the sidebar both go through `goToTab()`, and `STAGE_ON_ENTRY` says what
each step needs and what fills it.

**Only when the step is not current.** Each stage records a `fingerprint` of
the input it was derived from (`markDerived`), and a stage whose input has
since changed is stale rather than done — so editing the context re-derives
the facts, and entering codes then sees the facts changed and re-derives too.
That is the cascade.

Asking merely "does this step have anything in it" is what broke this before:
facts extracted from one context stayed on screen after the context was
replaced, because the guard saw facts and skipped the run. A step filled from
an earlier input is worse than an empty one — it shows a provider facts
belonging to a transcript they have already replaced.

A hand edit survives as long as the step's input has not changed: editing facts
does not change `fingerprint(transcript)`, so re-entering Facts leaves the edit
alone. Change the context afterwards and the facts are re-derived, which is the
right trade — facts that disagree with the context are worse than a lost edit,
and the status line says it is re-extracting rather than filling.

If you add a stage, give it `ready`, `current` and an entry in `STAGE_INPUT` —
getting `current` wrong either destroys edits or shows stale output.

Entering a step whose prerequisite is missing navigates without running: one
click never cascades three model calls. **Prepare claim** is the deliberate
run-everything path.

**Prepare claim fills the steps and leaves you where you are.** It used to end
on the Claim tab, which skipped the provider past the facts and codes it had
just written — and made it look as though nothing had been filled in. The nav
dots and the status line report what happened; the steps are there to be read
in order. Nothing in the New Claim flow should navigate on the user's behalf.

Each runner reports into its own tab's status line, which is no longer the tab
being looked at — so `goToTab` puts a note on the destination while the stage
runs, and leaves an error there if it fails.

**There is no Extract button, and there should not be one.** Extraction is the
Facts step; a button for it sat on the Context card, so a provider could walk
into Facts and sit there wondering why nothing had happened. Walking in is the
trigger. The same reasoning rules out a "suggest codes" or "populate" button —
if a step needs a manual kick, its `ready`/`current` pair is wrong.

Because nothing else on the page re-runs a step, **a failed stage carries its
own retry**: `goToTab` replaces the working note with an error line and a
**Try again** button bound to `goToTab(tab)`. Without it a failure is a dead
end — the provider is standing on the one screen that would have re-run it.

### Links

**One link treatment, and it is `.rh-link`.** Ruby paired with an underline —
never colour alone, because colourblind users and low-contrast displays lose a
colour-only affordance.

It is reserved for **the name of an object you can open**: a patient, case,
encounter or claim. Nothing else borrows it — not buttons, not a code, not a
status. If a name carries the treatment it must navigate; if it navigates it
must carry the treatment.

- **Inline names** go through `objectLink(text, onClick)`. Don't hand-build one.
- **Whole-row links** put `.rh-link` on the row's title span. The row button is
  the click target — a `<button>` inside a `<button>` is invalid HTML.
- **Payer and provider have no views**, so their names stay plain text until
  those pages exist. Don't style them as links in the meantime.

### Routes

Three places in the rail, and one shared record view:

| Route | What it is |
|---|---|
| **New Claim** | the pipeline: transcript → facts → codes → claim |
| **Patients** | everyone on file, then patient → case → encounter |
| **History** | claims bucketed by what they are waiting on |
| `record` | one patient, case or encounter — **not** a rail destination |

Patients and History both open the record, so it is its own route rather than
living inside either. `recordOrigin` is set before navigating and stamped onto
`historyState`, which decides two things: the first breadcrumb crumb, and which
rail item stays lit. Leaving the record clears that trail. If you add another
way in, set `recordOrigin` first or the breadcrumb will claim the wrong path.

The sidebar is shared, not New Claim's. It sits beside the routes and carries
one `.nav-group` per route — pipeline steps on New Claim, claim buckets on
History — and hides itself where a route has no nav. A vertical nav comes from
`buildTabbedPanels(..., { orientation: "vertical" })`, the same component as the
horizontal tabs, so both keep the same ARIA and keyboard wiring.

History's buckets are `CLAIM_BUCKETS` — a list with a `match` on claim status.
Add a bucket there, not by hand-building another tab strip. The one without a
`match` is All history, which is the activity feed rather than a slice of the
claims.

### Adding a patient

**Patients** is the one place a patient is created outside the New Claim intake
modal. The button is `.btn-primary` because adding one is the only action that
route offers — it is the loud action there, and Submit is somewhere else.

The form reuses `.field-grid` + `<label>`, the same labelled-field primitive as
the Claim form. Don't fall back to bare placeholders: a `type="date"` input
with no label reads as `mm/dd/yyyy`, which does not say *birth*.

Two things it must keep doing, both learned by watching it fail:

- **Clear the search box on success.** A query still in the box filters out the
  row that was just added, so the patient appears not to have been created.
- **Don't navigate.** Creating a patient leaves you on the list with a line
  naming them and an `.rh-link` to open their record — a provider adding
  several in a row should not be thrown into the first one's record.

A birth date in the future is refused client-side. The server takes any date;
this is a typo every time, and cheaper to catch before it reaches a claim.

### Acting on a claim from History

History reads the record; it does not edit it in place. The exception is
acting on a claim, which a provider has to be able to do from where they are
looking at it. `renderClaimActions()` is the one place that decides what a
claim offers, keyed on its status — a `draft` claim gets **Submit**, anything
the payer has seen gets **Amend**, and an appeal appears only where a denial
left money at risk. Add a pathway there, not by hanging another button off a
card, so a card can never offer an action its status cannot support.

Irreversible actions sit in a `.submit-actions` block: set apart behind a
rule, never flush against content someone was only reading. Amend rows default
to **Keep** — dropping a code is an explicit choice, never implied by an empty
field.

**Only a `draft` claim can be deleted.** Once a payer has seen a claim it is
the record of what was billed, and that is not ours to erase — so the option
is not offered on it rather than offered and refused. The rule lives in
`repository.deleteClaim`, not in the route or the button: `DELETE
/api/claims/:claimId` only reports the refusal. A claim another claim was
chained to is kept for the same reason — deleting it orphans the correction
pointing at it.

Deleting is two steps — a quiet **Delete draft claim**, then an explicit
confirm naming the claim — and both live inside the *same* `.submit-actions`
block as Submit, behind one rule rather than two. The confirm's destructive
button is `.btn-destructive` (garnet outline), never `.btn-primary`: ruby is
this app's "go ahead" colour, and nothing here should read as encouraged.
Focus lands on **Keep it**.

On Notion this is the trash, not an erase, so a misclick is still recoverable
from the workspace — but the UI does not promise that, because the provider
has no way to reach it.

### Color

`--gold` is decorative only — dots, rules, borders. It fails WCAG AA as text.
Anything readable uses `--gold-text`. Before using a color for text, check it
against `--surface` at 4.5:1 (3:1 for large bold text).

---

## Working with Kaycee

**Start plans with a plain-language summary**, before any technical detail: what
we're doing, why, and what actually changes.

**Give every step a plain-English description** alongside the technical one. Not
jargon with an explanation appended — the plain version should stand on its own.

**One piece at a time.** Prefer a short response with a single clear next step
over a complete rundown of everything at once. Long responses lose the thread.

**Push finished commits to their feature branch as soon as they're ready** --
don't leave them sitting local-only. This isn't optional busywork: Claude Code
sessions run in ephemeral cloud containers, and a commit that's never pushed can
be lost for good if the container gets recycled before anyone notices.

**Never merge a PR into `master`, or push directly to `master`, without an
explicit go-ahead for that specific merge/push.** Master auto-deploys to the
live Render site on every commit, so that's the boundary that needs a human
green light -- feature-branch pushes don't.

---

## Where things stand

P0 (correctness fixes) and P1 (the eval suite) are done. **P2 is next**: merge
the extraction and coding calls into one, drop the transcript rewrite from the
claim path, and add a cached block of E/M coding guidance.

Full plan: `docs/mvp-v1-build-plan.html`. Running log: the "Ruby Health MVP Demo
— Build Log & Next Steps" page in Notion.

**Two things to know before you start:**

- **There is no baseline eval score yet.** Nobody has run the suite against a
  live server. Until that happens there is nothing to measure P2 against.
- **`reference/codes/` is gitignored**, so a fresh clone has no code list. The
  server handles this — validation reports `unchecked` instead of failing.
