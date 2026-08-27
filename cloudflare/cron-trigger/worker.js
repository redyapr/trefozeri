// Cloudflare Worker: pings GitHub's workflow_dispatch API every 5 minutes so the
// trefozeri deploy workflow (.github/workflows/deploy.yml) actually runs that often.
//
// Why this exists: GitHub's own `schedule:` cron trigger is documented as
// best-effort — "may be delayed... in some cases the event may be dropped" — and in
// practice this repo's 5-minute schedule got progressively throttled by GitHub's own
// scheduler (observed gaps growing from ~20min to 10+ hours over a few days in late
// Aug 2026, even though every run that DID fire took under 2 minutes and succeeded —
// so it wasn't the workflow itself being slow or failing, just the trigger not firing).
// workflow_dispatch, invoked by an external caller instead of GitHub's own schedule
// event, isn't covered by that same "may be dropped" caveat — so this Worker's own
// (far more reliable) Cron Trigger calls it directly instead of relying on GitHub's.
//
// deploy.yml keeps a much slower `schedule:` (hourly) of its own as a fallback safety
// net in case this Worker, its PAT, or Cloudflare itself is ever down — see that
// workflow's own comment.
//
// GITHUB_PAT is a fine-grained personal access token scoped to just this one repo,
// with "Actions: Read and write" permission — set via `wrangler secret put GITHUB_PAT`,
// never committed. See this directory's README.md for full setup steps.

const OWNER = 'redyapr'
const REPO = 'trefozeri'
const WORKFLOW_FILE = 'deploy.yml'
const REF = 'master'

async function dispatch(env) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub's API rejects requests with no User-Agent header.
      'User-Agent': 'trefozeri-cron-trigger',
    },
    body: JSON.stringify({ ref: REF }),
  })

  // A successful dispatch returns 204 No Content — no body to read.
  if (res.status === 204) return { ok: true, status: 204 }

  const body = await res.text().catch(() => '')
  console.error(`[trefozeri-cron-trigger] dispatch failed: ${res.status} ${body}`)
  return { ok: false, status: res.status, body }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env))
  },
  // GET (or any method) triggers + reports the same dispatch by hand — from a browser
  // or curl — without waiting for the next Cron Trigger tick. Handy for verifying the
  // PAT/permissions right after deploying this Worker, before trusting it to the cron.
  async fetch(request, env) {
    const result = await dispatch(env)
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 502,
      headers: { 'content-type': 'application/json' },
    })
  },
}
