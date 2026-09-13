# Ruby-Health
Where I am building my medical claims management tool :)

## MVP demo app

A working prototype of Ruby's core mechanism: transcript → clinical fact extraction → ICD-10/CPT code suggestions → claim template → editable review. This is a demo/prototype, **not** the HIPAA-compliant production system — no compliance infrastructure, and only synthetic/sample encounters, never real patient data.

Build plan: see the "Ruby Health — MVP Demo App: Build Plan" Notion page.

### Running locally

```bash
cd backend
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npm install
npm start
```

Then open http://localhost:3000 — four tabs (Transcript, Facts, Codes, Claim & Review) share one underlying data model, so you can jump to any tab directly. Every action button (Extract, Suggest codes, Populate claim) only does its own step and never navigates you anywhere — it runs against whatever is currently in the shared data (whether that got there via Claude or by hand-editing) and stays put so you stay in control of where you are. Everything (transcript, facts, codes, claim, review state) is saved to the browser's `sessionStorage` as you go, so a page reload picks up right where you left off — closing the tab clears it.

On the Transcript tab, the mic button is a single push-to-talk/lock control (Wispr Flow-style): tap once to start talking, tap again quickly (within ~400ms) to lock into hands-free continuous listening, tap once more to stop. Requires Chrome or Edge (Web Speech API support); other browsers fall back to paste-only. Voice audio goes through the browser vendor's speech-recognition backend, not Anthropic's API.

### Deploying (shareable link)

The repo includes a Render blueprint (`render.yaml`) for a one-click deploy:

1. Push this repo to your own GitHub account (or use this one) and sign in to [Render](https://render.com) with GitHub.
2. **New > Blueprint**, pick this repo. Render reads `render.yaml` and provisions a free web service (`ruby-health-demo`) automatically — Node runtime, `backend` as the root dir, `npm install` / `npm start`.
3. When prompted, set the `ANTHROPIC_API_KEY` secret (kept out of the blueprint on purpose — never commit it). `ANTHROPIC_MODEL` and `ANTHROPIC_UTILITY_MODEL` are set in `render.yaml`, and `backend/src/server.js` carries the same two as defaults if they are unset — read them from one of those rather than from a copy in this file, which is how the one that used to sit here went stale.
4. Deploy. Render gives you a stable `https://ruby-health-demo.onrender.com`-style URL — that's the shareable link. A custom domain can be attached later from the same dashboard, no redeploy needed.
5. For every deploy after that first one, add the service's **Deploy Hook** URL (Render → the service → Settings → Deploy Hook) to GitHub as an Actions secret named `RENDER_DEPLOY_HOOK_URL`. CI calls it once the tests pass, so a commit on `master` ships itself only when the suite is green. See "Deploys" in `CONTRIBUTING.md` for why deploys run from CI rather than from Render's own auto-deploy, which does not work for this service.

Note: the free plan spins the service down after periods of inactivity, so the first request after a while can take ~30s to wake it back up — fine for demo sharing, worth a paid plan if that matters later.

Note: the service already running at that URL was configured by hand and has drifted from `render.yaml` — it builds with `cd backend && npm install` from the repo root instead of the blueprint's `rootDir: backend`, and has no health check path set. Editing `render.yaml` does not change it; use the dashboard. The steps above still describe a correct fresh deploy.

### Status

- [x] Piece 1: project scaffold (backend + minimal frontend skeleton)
- [x] Piece 2: paste transcript → raw Claude extraction JSON, end to end
- [x] Piece 3: ICD-10/CPT code-suggestion step
- [x] Piece 4: claim-template population + editable review screen
- [x] Piece 5: tabbed, un-gated UI — all steps share one data model, no forced order
- [x] Piece 6: live mic capture via Web Speech API
- [x] Piece 7: deploy as a shareable link (Render blueprint — see "Deploying" above; you run the actual deploy since it needs your own hosting account)
- [x] Piece 8: Provider section — the billing provider's name, organization, NPI and tax ID, stored once and used to build every claim

