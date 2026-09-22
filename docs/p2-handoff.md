> **STATUS: DONE (22 Sep 2026).** All four changes shipped — merged extract+code
> (`extractAndCode.js`), the transcript rewrite retired from the claim path
> (cleanup is now the brief-only `generateBrief`), the cached E/M guidance
> prefix, and per-transcript memoization. Measured against a same-model
> (Sonnet 5) baseline: recall held within noise, quote grounding 82.5 → 100,
> necessity recall 54 → ~65, cost down, cache reads non-zero. Kept as the record
> of what P2 was. See `eval/results/README.md` for the scorecards.

# P2 handoff — pipeline rebuild

Verified against `master` at `01da664`, 13 Sep 2026; models, caps and baseline
revised the same day after PR #30. Everything in "Current state"
below was read out of the code, not recalled. If you are picking this up much
later, re-check that section first — the rest of the document depends on it.

---

## What P2 is, in plain language

Making one claim currently takes two separate trips to the model, and each trip
re-sends the same background instructions. P2 makes it one trip, stops paying
repeatedly for the fixed part, and fixes a quieter problem: the quotes shown to a
provider as evidence may not be what the patient actually said.

Four changes. The third one is a correctness fix, not an optimisation, and is the
reason to do this before building UI on top of the pipeline's output.

---

## The baseline

P2's definition of done is "eval score at or above baseline". The baseline is
`eval/results/2026-09-13T23-27-52-451Z.json` — Opus 5, 20 encounters, run on 13
Sep 2026 after the truncation fix below. `eval/results/README.md` says which
file is which; the earlier one in that folder is a bug record, not a baseline.

Headline numbers, so you know what "at or above" means: diagnosis recall 100%,
procedure recall 81.8%, E/M exact 75%, linkage 80%, quote grounding 86.2%,
necessity phrase recall 54.3%, 3 forbidden codes across 2 encounters, 0 upcoded.

**It is one run.** Extraction was not truncated in either run, yet necessity
phrase recall moved 26 points between them — that is model variance, not the
fix. Do a second baseline run before drawing conclusions from a small movement.

The first-ever live run found a real bug: on Opus 5, 7 of 20 coding calls hit
`max_tokens: 1024`, and a truncated tool call came back as *zero suggestions
with no error*. Both stages now cap at 4096 and throw on `stop_reason:
"max_tokens"` (PR #30). Nobody had run the eval after the claim path moved to
Opus, so this shipped to the live site. **Run the eval after any model or
prompt change, not just at phase boundaries.**

```bash
cd backend && npm start &     # needs ANTHROPIC_API_KEY in backend/.env
node eval/run.mjs             # ~$1.50 on Opus 5, two model calls per encounter
```

It writes a timestamped scorecard to `eval/results/`. Commit the ones worth
comparing against and add them to the README there.

Read `eval/README.md` before interpreting it. Two things that matter:

- **Never quote the score as an accuracy figure.** The answer key in
  `eval/encounters/` was written by an AI, not a certified coder. It is a
  regression detector — "did this change help or hurt?" — and nothing more. A
  confidently wrong number is worse than no number.
- **Upcoding is tracked separately from under-coding and must stay that way.**
  Coding too low costs the practice revenue; coding too high draws an audit.
  `emUpcodedCount` counts levels above the key. Do not average them together.

---

## Current state of the code

The automatic claim path is **two model calls**, then deterministic assembly:

| Stage | File | Model call? | Notes |
|---|---|---|---|
| Extract clinical facts | `backend/src/pipeline/extract.js:42` | Yes | `max_tokens: 4096`, forced tool call, throws on truncation |
| Suggest codes | `backend/src/pipeline/suggestCodes.js:46` | Yes | `max_tokens: 4096`, forced tool call, throws on truncation |
| Verify quotes | `verifyQuotes.js` | No | string matching |
| Validate codes | `validateCodes.js` | No | list lookup, warns only |
| Build claim | `populateClaim.js` | No | deterministic |

`cleanupTranscript.js` is a **third** model call, but it is **not** in the
automatic path — it sits behind a manual button on the Context card
(`frontend/index.html:3666`). `STAGE_ON_ENTRY` (`frontend/index.html:3444`) only
runs facts → codes → claim.

Models, as of this writing: claim path `claude-opus-5`, transcript cleanup
`claude-haiku-4-5`. Both declared in four places — `backend/src/server.js:38` and
`:43` (the defaults that actually apply), `render.yaml`, `backend/.env.example`,
and the standing rule in `CLAUDE.md`. Change all four or the next session will
revert you.

Token accounting already exists: `backend/src/usage.js` tracks `cacheReadTokens`
and `cacheWriteTokens` per stage, so P2's cache done-condition is measurable with
what is already there. Any new model call must call `recordUsage(stage, model,
response)` immediately or it escapes accounting.

---

## The four changes

### 1. Merge extraction and coding into one call

**Plain version:** Ask the model for the facts and the codes in one go, instead of
asking twice.

Today the coding stage reads the extractor's *summary* of the visit rather than
the visit itself (`suggestCodes(anthropic, model, facts)` — it never sees the
transcript). Merging lets the model choose codes while it still has the full
reasoning in hand, and halves the round trips.

**Traps:**

- **Watch `max_tokens` on the merged call.** Each stage now has 4096 for one
  output; the merged response carries both. The longest coding response seen in
  a clean run was 1161 tokens and extraction runs ~600, so 4096 has headroom, but
  measure it. A truncated call now throws rather than returning nothing — keep
  that guard on the merged stage.
- Both stages use `tool_choice: { type: "tool", name: ... }` (forced). That is
  fine on Sonnet 5 and Opus 5. It returns a 400 on the Fable/Mythos family, so if
  the model ever moves there, this breaks.
- Keep the merged stage in the existing shape: one async function taking
  `(anthropic, model, …)`, a `SYSTEM_PROMPT`, a single forced tool call, then
  `recordUsage(...)`. Give every field of `toolUse.input` a default —
  `JSON.stringify` drops `undefined` keys, and that caused a real crash before
  the defaults were added.
- `eval/score.mjs` imports from `../backend/src/pipeline/`. Check it still
  resolves after any file move; these cross-folder imports are load-bearing and
  break quietly.

### 2. Retire the transcript rewrite from the claim path

**Plain version:** Stop rewriting the transcript before pulling quotes out of it.
Punctuate the quotes themselves instead, and leave the record alone.

**This is the correctness fix.** `cleanupTranscript.js` rewrites the whole
transcript for readability. If extraction then runs on the rewritten text, the
"grounded quotes" are grounded in a model's paraphrase — not in what was said.
And `verifyQuotes.js` still passes, because it checks quotes against the
rewritten transcript. The guarantee holds mechanically while meaning less than it
appears to. On a medical record that is the wrong kind of quiet.

Current exposure is limited — cleanup is a manual button, not automatic — but the
button sits directly on the Context card, so a provider can put the pipeline into
that state with one click.

**Trap:** the stored stage key is still `transcript`, and so is the `transcript`
field on the API. That is deliberate. The stage is a Notion select option carried
by every artifact already written, so renaming it is a data migration. If you
rename it, migrate the stored rows in the same change, and leave the API field
alone unless you version the endpoint.

### 3. Cached E/M guidance prefix

**Plain version:** Put the visit-level coding rules in a block the API remembers
for an hour, so you pay for those tokens once rather than on every claim.

**The trap that will cost you an afternoon:** the minimum cacheable prefix is
model-dependent, and **below it, caching silently does nothing** — no error, just
`cache_creation_input_tokens: 0`.

| Model | Minimum prefix |
|---|---:|
| Claude Opus 5 (current claim path) | **512 tokens** |
| Claude Sonnet 5 | 1024 tokens |
| Claude Haiku 4.5 | 4096 tokens |

The two existing system prompts are ~380 and ~797 characters — roughly 300 tokens
combined. **That is under Opus 5's minimum on its own.** The cacheable prefix
includes tool definitions as well as system text, so measure it rather than
estimating: use `messages.count_tokens` before concluding the cache is broken.

Other mechanics worth knowing before you write the code:

- Render order is `tools` → `system` → `messages`. Any byte change anywhere in the
  prefix invalidates everything after it, so stable content goes first and
  volatile content (the transcript, per-request IDs) after the last breakpoint.
- `cache_control: {"type": "ephemeral"}` is a 5-minute TTL; `{"type":
  "ephemeral", "ttl": "1h"}` is the hour. Max 4 breakpoints per request.
- **The build plan says one-hour TTL; check that against real usage.** A 1-hour
  write costs 2× base and needs three or more reads to pay off, while a 5-minute
  write costs 1.25× and breaks even at two. If claims are made less than five
  minutes apart, the 5-minute TTL is strictly cheaper — every request refreshes
  it. The hour only earns its price on gaps of 5–60 minutes. The stated
  done-condition ("second claim in an hour") implies the longer gap, so 1h is
  probably right, but it is a measurement, not a given.
- Verify with `usage.cache_read_input_tokens`. Zero across repeated requests means
  a silent invalidator, not a missing feature.

**Load the `claude-api` skill before writing any of this** — never answer from
memory on model names, pricing, or caching. `shared/prompt-caching.md` in that
skill is the reference the numbers above came from.

### 4. Content-hash memoization per stage

**Plain version:** Don't re-run a stage when its input hasn't changed.

The frontend already has this concept — `markDerived` / `fingerprint` in
`frontend/index.html` decide whether a step is stale. P2 puts the equivalent on
the server side. Getting staleness wrong in either place either destroys a
provider's hand edits or shows them output belonging to a transcript they have
already replaced.

---

## Done when

All three are measurable; the first needs the baseline to exist.

- [ ] Eval score at or above baseline
- [ ] Cost per claim is down (read it from `/api/usage`)
- [ ] `cache_read_input_tokens` is non-zero on the second claim within an hour

UI work can start once this lands — merging extraction and coding changes the
shape of what the pipeline emits, so building UI on today's shape means rebuilding
it after.

---

## The model question, and what is still open

`docs/mvp-v1-build-plan.html` says P2 includes **"Move to Opus 5 and tune effort
against the eval suite."** The move happened on 13 Sep 2026 (`50b667d`), and
`CLAUDE.md` now tells sessions not to "fix" the model IDs. The baseline above is
an Opus 5 number.

What has *not* happened is the second half: nobody has scored Sonnet 5 on the
same suite, so "Opus codes better" is still an assumption. If cost per claim
becomes the pressure, **run the suite on Sonnet before switching** — one run,
roughly $0.60 — and compare against the baseline rather than guessing. The
choice interacts with change 3 above: Sonnet doubles the cacheable-prefix
minimum from 512 to 1024, which the current prompts are even further under.

---

## Things not to do

- **Don't make code validation block.** `validateCodes.js` warns and leaves an
  unrecognised code on the claim. That looks like a missing feature and is not —
  the loaded list is the CMS Section 111 list, which omits codes that are
  perfectly valid to bill (`Z23`, encounter for immunization, is absent). Hard
  blocking is P3 and waits on a complete ICD-10-CM release.
- **Don't add a button to run a stage.** Walking into a step is the trigger. If a
  step seems to need a manual kick, its `ready`/`current` pair is wrong.
- **Don't put real patient data anywhere** — not in the app, not in
  `reference/codes/`, not in a test fixture. The compliance layer does not exist.
- **Don't push to `master` without an explicit go-ahead for that specific push.**
  It deploys to the live site once CI passes.

---

## Running the tests

Four suites, no single command:

```bash
cd backend && npm test                  # 186 tests
node --test eval/test/*.test.js         #  19
node --test reference/test/*.test.js    #  21
node eval/run.mjs --mock                # harness check, free, scores 100% by construction
```

CI runs all four plus a boot check, and `test/ui-smoke.mjs` in its own job.
Deploys run from CI after the suite passes — Render's own auto-deploy webhook is
switched off deliberately; see "Deploys" in `CONTRIBUTING.md` before turning it
back on.
