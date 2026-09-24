# tmrw

A quiet black-and-white diary. Pick a shade for the day, write about it, and leave a short checklist for tomorrow.

This version runs on **Cloudflare Workers + D1**. The website, numbered accounts, passwords and diary database can use Cloudflare's Free plan. No Python server, paid disk, downloads or manual file uploads are needed.

## Launch from this GitHub repo

1. Sign into [Cloudflare](https://dash.cloudflare.com/), using the Free plan.
2. Open **Workers & Pages → Create application → Import a repository** (or **Connect to Git**).
3. Authorize GitHub and select **anikamelkoter/tmrw**, branch **main**.
4. Use these settings:

   | Setting | Value |
   | --- | --- |
   | Worker name | `tmrw` |
   | Root directory | repository root |
   | Build command | leave blank |
   | Deploy command | `npm run deploy` |

5. Deploy. Wrangler requests a D1 database bound as **DB**. Accept its free database provisioning if prompted. The app initializes its tables on the first API request.
6. Open the **workers.dev** URL shown by Cloudflare. Create your account before sharing the link if you want user **#1**.
7. In the Worker's **Bindings**, find the D1 database ID. Save that non-secret ID as `database_id` inside the `d1_databases` entry in `wrangler.jsonc` using GitHub's editor (or ask your coding assistant to do it). Cloudflare's automatic provisioning does not write this ID back to GitHub. Pinning it makes the intended database explicit for future builds. Never delete/recreate that database to update the website.

Once connected, commits to **main** trigger Cloudflare deployments. Keep using this repository for changes. GitHub Pages is not the host for the login/database version.

### If Cloudflare asks you to create the database manually

Create **Storage & databases → D1 → Create database**, named `tmrw-db`. Copy its database ID into the `d1_databases` entry in `wrangler.jsonc` on GitHub, then retry deployment. No SQL pasting is needed for initial setup.

No account credentials or Cloudflare tokens are committed to this repository. Connecting your Cloudflare account is a one-time owner step; this code change alone does not publish a live site.

## Free-plan limits

As checked September 24, 2026, Workers Free includes 100,000 dynamic requests/day. D1 Free includes 5 million rows read/day, 100,000 rows written/day and 5 GB total storage. Static asset requests are served separately. Free is subject to those limits, not unlimited hosting. Stay on the Free plan; a custom domain is optional.

Official references: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [automatic resource provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning), [GitHub-connected builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

## Features

- Original calendar layout with blank rounded squares, gray hover, and smooth day expansion.
- Five rating shades; hover previews the cumulative scale, click saves the choice, calendar reflects the selected shade.
- “For tmrw” feeds the next calendar day's “from yesterday” tasks, including month and year boundaries. Completion belongs to the next day; changing source text resets its completion.
- Diary, rating and checklist autosave per account. The same user number and password work on another device.
- Sequential account numbers allocated by D1, starting at 1 on a new database.
- Passwords hashed with salted native scrypt, random server-side sessions, HTTP-only cookies, request-origin checks, and database-backed login throttling.
- Atomic entry version checks prevent one device silently overwriting another's changes.

## Local development (optional)

Use Node.js 22.13+:

```sh
npm ci
npm run dev
```

Open the localhost URL that Wrangler prints. Local D1 data is separate from the live database; schema initialization is automatic. Development/test accounts do not consume public account numbers.

```sh
npm test
npm run check
npm run deploy:check
```

Tests run the Worker handlers against real SQLite through a D1 adapter: account numbering, password validation, sessions, two-device reads, user isolation, stale-write rejection, request validation and throttling. `deploy:check` validates and bundles without publishing. Signup, entry retrieval, logout and login were also exercised in Cloudflare's local workerd runtime. Live free-tier CPU usage and full browser behavior still need verification after deployment; local tests do not simulate Cloudflare's CPU quotas.

## Data and maintenance

- `public/` is the only published asset directory; server source and tests are not served to visitors.
- `src/worker.js` contains the API; `src/schema.js` initializes empty databases idempotently.
- `migrations/0001_initial.sql` records the initial schema. Add versioned migrations for later schema changes; do not drop account tables during deploys.
- A daily scheduled job removes expired sessions and login throttle records.
- After deployment, export backups from the D1 dashboard. Keep backups private.
- If you used the previous local Python version, those local accounts are not automatically imported. Keep that database until a migration is arranged. The former code remains available in Git history.
- There is no email/password recovery yet. Keep your user number and password safe.
- Diary content is private between users, but it is not end-to-end encrypted; the database owner can access it.
- Autosave needs internet. If saving fails, leave the page open. A conflict warning means copy unsaved text before reloading. This is not an offline diary.
