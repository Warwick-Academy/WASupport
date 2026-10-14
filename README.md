# AcademyDesk

Custom helpdesk + AI Resource Centre for **Warwick Academy, Bermuda**, replacing Spiceworks.

**Stack:** Supabase · GitHub · SendGrid · Netlify (+ OpenAI for the LMRC, Twilio for H&S SMS).

```
apps/web                  React + Vite + Tailwind (Netlify-hosted)
netlify/functions         Serverless endpoints (TypeScript, esbuild)
supabase/migrations       Postgres schema + RLS
supabase/seed.sql         Local dev seed data
.github/workflows         CI
```

## Quick start

```powershell
# 1. Install deps
pnpm install

# 2. Copy env file
Copy-Item .env.example .env.local

# 3. Run the web app (no Supabase needed for the status page)
pnpm dev
# → http://localhost:5173

# 4. To exercise /api/* (Netlify Functions) locally:
pnpm netlify:dev
# → http://localhost:8888
```

See [STAGES.md](./STAGES.md) for the full step-by-step build walkthrough.

## Syncing home and school computers

Both computers should use `https://github.com/Warwick-Academy/WASupport.git`.
GitHub reports that the previous `Markinbda/WASupport` URL has moved there.
Update an older checkout with
`git remote set-url origin https://github.com/Warwick-Academy/WASupport.git`.
Source changes
sync through Git commits, not folder copying. Before switching computers, commit
and push your work; on the other computer, commit any local work before pulling.
Use `git pull --ff-only` to avoid an accidental merge. The school setup branch is
`local-sync-with-school-computer`; pushing it does not update production `main`.

On each Windows computer, install Node.js 20+, pnpm 9, Git, and the Netlify CLI.
If pnpm is not on PATH, `corepack pnpm` can be used instead. Restore dependencies
on that computer rather than copying `node_modules`:

```powershell
corepack pnpm install --frozen-lockfile
netlify login
corepack pnpm platform:sync
corepack pnpm netlify:dev
```

`platform:sync` uses your Netlify login (or `NETLIFY_AUTH_TOKEN`) to verify the
existing `wasupportportal` site's repository connection, fetch readable
development-scoped settings, validate Supabase access, and validate SendGrid
Mail Send in sandbox mode without delivering email. Netlify marks some secrets
as write-only: those cannot be exported, so first save real
`SUPABASE_SERVICE_ROLE_KEY` and `SENDGRID_API_KEY` values in `.env.local` using
your approved secret store. The command retains those local values and rejects
missing, masked, or placeholder credentials.

On success it updates only Git-ignored `.env.local` and `.netlify/state.json`.
The verified sender address falls back to the production value when there is no
development value. Other production-only settings are not copied by default.

If development credentials are empty and you deliberately want production access,
use `corepack pnpm platform:sync --use-production`. This explicitly allows
production setting fallback where Netlify permits reads; it cannot retrieve
write-only secrets. Never use it for an isolated test environment.

**This connects local development to the existing cloud Supabase database.**
Local app actions can change live records and send real emails. The sync command
itself does not deploy, change cloud settings, run migrations, or write database
records. Cloud data is shared, not replicated between computers.

Secrets and CLI logins do not sync through Git. Netlify environment settings,
Supabase Auth/provider settings, and SendGrid sender/webhook settings live in
their respective dashboards. Changes there affect both computers when they use
the same services; rerun `platform:sync` after credential changes.

Supabase migrations are source-controlled but must be applied separately by an
authorized operator. Install the Supabase CLI and link it on each computer with
`supabase link --project-ref lpfayazlroudwnsgioou` before using cloud migration
commands. Do not run `db:push` or `db:reset` merely to sync source code.

Signed SendGrid delivery callbacks additionally need
`SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` and the provider webhook configuration below;
a successful sandbox check does not prove real inbox delivery or callback setup.
OpenAI/Twilio are future integrations, not activated by this setup command.

## Ticket email delivery

Database triggers enqueue creation, assignment, status-change, and public-reply emails
in `notifications_outbox`. Internal notes and historical ticket imports do not send
emails. The scheduled `ticket-emails` function runs every minute, claims ten emails
with exclusive leases, and retries failed sends up to six times with backoff.
Submitter replies go to the assignee, or department managers when unassigned;
staff replies go to the submitter. The admin-only Email Log includes searchable
historical attempts, queue state, errors, and delivery outcomes.

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SENDGRID_API_KEY`, and
`SENDGRID_FROM_EMAIL` in Netlify's production functions scope. `APP_URL` should be
`https://wasupportportal.netlify.app`. The sender must be verified in SendGrid.

For delivery confirmation, configure SendGrid's signed Event Webhook to
`https://wasupportportal.netlify.app/api/email-delivery-events` with delivered,
bounce, dropped, and deferred events enabled. Set its public verification key as
`SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` in Netlify's production functions scope.
Do not overwrite a callback used by another application; use a separate SendGrid
subuser or a shared event router instead.

Accepted means SendGrid accepted the send, not that the recipient received it.
Delivery callbacks are deduplicated by provider event ID. Leases prevent concurrent
workers from sending the same queued email. Delivery is at-least-once: a process
failure after SendGrid accepts an email but before the database acknowledges it
can still cause a retry. Email replies are not ingested; users reply via ticket links.

Run `node scripts/test-ticket-emails.mjs` for mocked worker and signature tests.

## Imported assignees

Both Spiceworks import paths use `import_spiceworks_tickets` to resolve Assigned To
against eligible department profiles. Matching is exact after case/space and
Last, First normalization, or uses a complete profile email address. Ambiguous
or unmatched names stay in `legacy_assignee_name` for review; no users are created
and current assignees are never overwritten. Re-uploading an existing Ticket Number
fills its missing assignee without replacing its status or ticket details.
Historical imports and assignment backfills suppress ticket emails while retaining
assignment-change audit snapshots. The CSV must include Assigned To; blanks are allowed.
The browser can download unresolved names; the command-line importer writes an
adjacent `.unmatched-assignees.csv` report. Gary and Josh McCullough are not treated
as the same person without an explicit approved mapping.
