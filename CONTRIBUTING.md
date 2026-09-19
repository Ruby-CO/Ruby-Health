# Working on Ruby Health

## Branching

`master` is the trunk. It should always hold a commit that could be deployed.

One person works on this repository, so work is committed straight to `master`
and pushed:

```
git checkout master
git pull origin master
# ...work, run the tests, commit...
git push origin master
```

Branches are for parking, not review: use one when a change has to sit
half-done for a while, and merge it back yourself when it is ready. Nothing
requires a pull request. Pull requests from earlier in the project were the
review gate when the workflow was being set up; the gate now is CI. It runs the
full suite and the boot check on every push to `master`, and the deploy waits
on a green run -- so a red push changes nothing on the live site, and a green
one goes live without anyone in between. Check that the run went green after
pushing.

This is a **prototype arrangement**. The moment a second person commits, or
real patient data is in scope, go back to branches and pull requests with
branch protection -- see "Before real patient data is involved" below.

## Deploys

**Right now (prototype):** a commit on `master` deploys itself once the tests
pass. `.github/workflows/ci.yml` runs the four suites and the boot check in one
job and the browser smoke test in another; its `deploy` job waits on both, then
calls a Render deploy hook. That URL is the repository secret
`RENDER_DEPLOY_HOOK_URL`; when it is absent the deploy job skips rather than
fails, so a clone without the secret still gets a green run.

This is deliberately **not** Render's own auto-deploy, which does not work for
this service despite being switched on in its dashboard. GitHub delivers the
push event — the CI run on the same commit is the proof — and Render does not
act on it. Every deploy before this arrangement was started by hand or through
Render's API, and reconnecting the repository in the dashboard did not change
that. If that webhook is ever repaired, switch auto-deploy off in Render
rather than leaving both paths live, or a commit deploys twice: once on the
push and once on green.

**This has already been tried once.** On 13 Sep 2026, within an hour of the
paragraph above being written, the webhook was re-added in GitHub to get
automatic deploys back — not knowing the CI hook already provided them. Render's
auto-deploy was switched off again the same day and the arrangement left as
described here.

Worth knowing before switching it on a third time, because the reasoning is
not obvious from the dashboard: a disabled auto-deploy setting looks like
something nobody got round to, and turning it on *feels* like a fix. Deploys
are already automatic. What the setting would add is a second deploy that
fires on the push, before the tests finish — so a commit that breaks the suite
would reach the live site, which is exactly what the CI hook exists to prevent.

Deploying only on a green suite is the stronger arrangement regardless — a
broken commit leaves the live site on the last good version instead of taking
it down — but it is still not what production needs.

**Before real patient data is involved**, the following stop being optional:

- Branches and pull requests again, with branch protection on `master` and CI
  required to pass before a merge. The suite already gates the *deploy*;
  nothing gates what reaches `master`.
- The accuracy evaluation suite gating deploys alongside the unit tests, so a
  change that quietly degrades coding accuracy cannot ship.
- A staging environment that receives the deploy first, with promotion to
  production as a separate deliberate step.
- Tagged releases and a rehearsed rollback, so "go back to the last good
  version" is one action rather than an improvisation.
- Deploy records tying a running version to its commit and to whoever approved
  it. Once PHI is in scope this is an audit requirement, not hygiene.

## Tests

```
cd backend
npm test            # unit tests: claim assembly, pointer linkage, quote grounding
```

The browser smoke test needs a running server and Playwright available on the
machine (it is deliberately not a project dependency):

```
cd backend && PORT=3115 node src/server.js &
node test/ui-smoke.mjs
```

It checks what unit tests cannot — that a grounding verdict reaches the screen,
that an edited quote drops its stale verdict, and that claim warnings surface
above the form rather than being buried in it.

It also runs in CI as its own job, installing Playwright there rather than
adding it to the project. The deploy waits on that job, so a failure in it
keeps the change off the live site.

## A standing rule about this codebase

No real patient data, ever, until the compliance phase is genuinely done. This
build has no encryption at rest, no retention policy, no signed BAA, and an
audit log that anyone with Notion access can edit. Synthetic encounters only.
