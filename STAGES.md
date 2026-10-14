# AcademyDesk — Build Walkthrough

This is the historical build checklist, not a record of current service access.
For home/school synchronization and current credential setup, use the
[README](./README.md#syncing-home-and-school-computers).

This file is the running checklist we work through together. Each stage has
**(a)** what to provision in third-party dashboards (things only you can do)
and **(b)** what we change in the repo (I do these). Tick items as we go.

---

## Stage 0 — Prerequisites (do once)

Install on your Windows machine:

- [ ] **Node 20+** — already detected ✓
- [ ] **pnpm 9** — installed ✓
- [ ] **Git** — already detected ✓
- [ ] **GitHub CLI** (`gh`) — `winget install --id GitHub.cli`
- [ ] **Supabase CLI** — `scoop install supabase` *(or download from https://github.com/supabase/cli/releases)*
- [ ] **Netlify CLI** — already detected ✓ (`netlify-cli/24.x`)
- [ ] **Docker Desktop** — required for `supabase start` (local Postgres)

Accounts to create (free tiers are fine to start):

- [ ] GitHub org or personal repo
- [ ] Supabase account → two projects: `academydesk-staging`, `academydesk-prod`
- [ ] Netlify account → one site linked to the GitHub repo
- [ ] SendGrid account → verified sender domain (`warwickbermuda.com`)
- [ ] OpenAI account → API key with a monthly spend cap
- [ ] Twilio account → one Bermuda number for H&S alerts

---

## Stage 1 — Local "hello AcademyDesk"

Goal: see the app running locally and the `/api/health` function responding.

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Open <http://localhost:5173>. You should see the AcademyDesk status page.
Supabase will show as "missing" — that's expected; we wire it up in Stage 3.

To also start the Netlify Functions emulator (so `/api/health` works):

```powershell
pnpm netlify:dev   # serves both web + functions on http://localhost:8888
```

---

## Stage 2 — Push to GitHub

```powershell
git init
git add .
git commit -m "chore: initial AcademyDesk scaffold"
gh repo create warwick-academy/academydesk --private --source . --remote origin --push
```

(If you're not using `gh`, create the repo in the GitHub UI and `git push -u origin main`.)

CI runs automatically — confirm the **CI** workflow passes on the first push.

---

## Stage 3 — Local Supabase

```powershell
supabase init      # only if it asks; config.toml is already committed
supabase start     # spins up local Postgres + Studio on :54323
supabase db reset  # applies migrations + seed
```

Then capture the local URL + anon key from `supabase status` and add to `.env`:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon key from `supabase status`>
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<service_role key from `supabase status`>
```

Reload <http://localhost:5173> — the status page should now show **Supabase config: detected**.

---

## Stage 4 — Cloud Supabase (staging first, then prod)

1. Create project `academydesk-staging` in the Supabase dashboard. Pick a strong DB password and store it in your password manager.
2. Link the local repo:
   ```powershell
   supabase link --project-ref <staging-ref>
   supabase db push           # applies migrations to staging
   ```
3. From the project's **Settings → API**, copy the URL + anon + service-role keys.
4. Repeat for `academydesk-prod` later (don't push migrations there until Stage 6).

---

## Stage 5 — Netlify site

```powershell
netlify login
netlify init                  # link to GitHub repo, accept defaults
```

In the Netlify UI → **Site settings → Environment variables**, add (staging values):

| Name | Scope |
|---|---|
| `VITE_SUPABASE_URL` | All scopes |
| `VITE_SUPABASE_ANON_KEY` | All scopes |
| `SUPABASE_URL` | Functions only |
| `SUPABASE_SERVICE_ROLE_KEY` | Functions only |
| `OPENAI_API_KEY` | Functions only |
| `SENDGRID_API_KEY` | Functions only |
| `SENDGRID_FROM_EMAIL` | Functions only |
| `SENDGRID_INBOUND_SECRET` | Functions only |
| `TWILIO_ACCOUNT_SID` | Functions only |
| `TWILIO_AUTH_TOKEN` | Functions only |
| `TWILIO_FROM_NUMBER` | Functions only |

Push to `main` → Netlify auto-deploys. Visit the live URL and `/api/health`.

---

## Stage 6 — Authentication (Microsoft SSO)

1. In Entra ID (Azure portal), register an app:
   - Redirect URI: `https://<staging-ref>.supabase.co/auth/v1/callback`
   - Allowed audience: this tenant only.
2. Copy **Application (client) ID**, **Directory (tenant) ID**, and create a **client secret**.
3. In Supabase dashboard → **Authentication → Providers → Azure**, paste those three values, set the issuer URL `https://login.microsoftonline.com/<tenant>/v2.0`, and enable.
4. Update `supabase/config.toml` to flip `[auth.external.azure].enabled = true` locally (we'll add login UI next).

---

## Stage 7 — Phase 1 build (foundation)

We'll iterate on these features and commit as we go:

- [ ] Sign-in / sign-out UI using Supabase JS
- [ ] Three department queues: IT / Facilities / H&S
- [ ] Ticket submission form
- [ ] Ticket detail page with public + internal replies
- [ ] Submitter dashboard ("my tickets")
- [ ] Basic KB browser
- [ ] SendGrid outbound: ticket created / replied / resolved emails
- [ ] SendGrid inbound: `help@warwickbermuda.com` → ticket

---

## Stage 8 — Phase 2 (SLA, assets, H&S workflows, reports)

See [Warwick_Academy_AcademyDesk_Specification.docx](./Warwick_Academy_AcademyDesk_Specification.docx) §6 + §8.

---

## Stage 9 — Phase 3 (LMRC: RAG on pgvector + OpenAI)

- [ ] Add `pgvector` extension and `kb_chunks` table
- [ ] `kb-embed` Edge Function to chunk + embed KB articles on upsert
- [ ] `ai-lmrc` Netlify Function — streaming chat grounded in retrieved chunks
- [ ] AI pre-fill on ticket form (category / priority / summary)
- [ ] LMRC analytics dashboard

---

## Stage 10 — Phase 4 (mobile + go-live)

- [ ] Expo React Native app sharing the design system
- [ ] Expo Push notifications
- [ ] Twilio SMS for Critical/Urgent H&S
- [ ] Pentest + load test
- [ ] Spiceworks data import script + parallel run
- [ ] Go-live cutover
