# Working on Ruby Health

## Branching

`master` is the trunk. It should always hold a commit that could be deployed.

Work happens on a branch off `master` and comes back through a pull request:

```
git checkout master
git pull origin master
git checkout -b <short-description>
# ...work, commit...
git push -u origin <short-description>
# open a PR into master
```

Nothing is pushed directly to `master`. CI runs the backend test suite and a
boot check on every pull request; a red suite means the branch is not ready,
not that the check is inconvenient.

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

Deploying only on a green suite is the stronger arrangement regardless — a
broken commit leaves the live site on the last good version instead of taking
it down — but it is still not what production needs.

**Before real patient data is involved**, the following stop being optional:

- Branch protection on `master`, with CI required to pass before a merge. The
  suite already gates the *deploy*; nothing yet gates the *merge*.
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
build has no encryption at rest, no audit logging, no retention policy, and no
signed BAA. Synthetic encounters only.
