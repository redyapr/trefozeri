# cron-trigger

A tiny Cloudflare Worker whose only job is to call GitHub's `workflow_dispatch` API
every 5 minutes, so `.github/workflows/deploy.yml` actually runs that often.

**Why this exists**: GitHub's own `schedule:` trigger is documented as best-effort and
can be silently delayed or dropped under load. In practice, this repo's 5-minute
`schedule:` got progressively throttled — gaps grew from ~20 minutes to 10+ hours over
a few days — even though every run that did fire succeeded in under 2 minutes. An
externally-triggered `workflow_dispatch` isn't covered by that same caveat, so this
Worker's own Cron Trigger (Cloudflare's, not GitHub's) calls it directly instead. See
`worker.js`'s own comment for the full story.

`deploy.yml` keeps a much slower hourly `schedule:` of its own as a fallback safety
net, in case this Worker (or its PAT, or Cloudflare itself) is ever down.

## One-time setup

1. **Create a GitHub PAT** — [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
   (fine-grained token):
   - Repository access: **Only select repositories** → this repo.
   - Permissions → Repository permissions → **Actions: Read and write**.
   - No other permissions needed. Copy the token — you won't see it again.

2. **Install Wrangler** (Cloudflare's CLI) if you don't have it:
   ```
   npm install -g wrangler
   ```

3. **Log in to Cloudflare**:
   ```
   wrangler login
   ```
   (Free tier is enough — Cron Triggers cost nothing at this volume.)

4. **From this directory**, set the PAT as a Worker secret (never committed —
   Wrangler prompts for the value, it's not a shell arg):
   ```
   cd cloudflare/cron-trigger
   wrangler secret put GITHUB_PAT
   ```

5. **Deploy**:
   ```
   wrangler deploy
   ```
   Wrangler reads `wrangler.toml` and registers both the Worker and its `*/5 * * * *`
   Cron Trigger in one go — nothing else to configure in the Cloudflare dashboard.

6. **Verify it actually works** — open the deployed Worker's `*.workers.dev` URL
   (printed by `wrangler deploy`) in a browser, or:
   ```
   curl https://trefozeri-cron-trigger.<your-subdomain>.workers.dev
   ```
   `{"ok":true,"status":204}` means the dispatch succeeded — check the
   [Actions tab](https://github.com/redyapr/trefozeri/actions/workflows/deploy.yml)
   for a new run triggered by `workflow_dispatch`. `{"ok":false,...}` means the PAT is
   missing/wrong-scoped — the `body` field has GitHub's own error message.

7. **Let it run** — Cloudflare's dashboard (Workers & Pages → trefozeri-cron-trigger →
   Cron Triggers / Logs) shows each invocation. After a day, the Actions tab's
   `workflow_dispatch` runs should be landing every ~5 minutes with none of the
   multi-hour gaps `schedule:` alone was showing.

## Rotating the PAT

Fine-grained PATs expire (max 1 year). When it does, the Worker starts failing quietly
— `deploy.yml`'s own hourly `schedule:` fallback keeps things updated in the meantime,
but at the old slower cadence. Repeat step 1 and re-run step 4 with the new token.
