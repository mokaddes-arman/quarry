<p><img src="brand/quarry-lockup.svg" alt="Quarry" height="48"></p>

# Quarry

*Dig the answer out of what you already have.*

Quarry is a **locally hosted, project-scoped Retrieval-Augmented Generation assistant** for teams
that need grounded answers over their own engineering documentation — with **verifiable
citations** and **strict per-project isolation**.

- Answers are produced **only** from retrieved document excerpts. If the evidence is not
  there, the assistant **abstains** instead of guessing.
- Every citation points at a **real stored chunk** (document + version + location) that you
  can open and inspect.
- Projects are isolated by default. Cross-project retrieval happens **only** when you
  explicitly ask for it.
- Provider API keys are **encrypted at rest** (AES-256-GCM) and never stored, returned, or
  logged in plaintext.
- Everything runs on your machine. Documents, vectors and history stay local.

### Demo account

Want to try the messaging without an invitation? Sign in with the shared demo account
(also shown on the login page, with a one-click **Use demo account** button):

| Field    | Value                                    |
| -------- | ---------------------------------------- |
| Email    | `mokaddes.arman.2111+testuser@gmail.com` |
| Password | `Mokaddes@123`                           |

This is a regular (non-admin) user. Do not upload anything sensitive while signed in with it.

---

## Contents

1. [Requirements](#requirements)
2. [Quick start (PowerShell)](#quick-start-powershell)
3. [How it runs](#how-it-runs)
4. [Deploy on Render](#deploy-on-render)
5. [Configuration](#configuration)
6. [Commands](#commands)
7. [Testing & verification](#testing--verification)
8. [API surface](#api-surface)
9. [Security model](#security-model)
10. [Project layout](#project-layout)
11. [Known limitations](#known-limitations)

---

## Requirements

| Requirement | Notes |
| --- | --- |
| **Node.js >= 20.11** | Verified on Node **24.21.0** / npm **11.19.0**. |
| **npm** | Comes with Node. |
| **PostgreSQL + pgvector** | **Optional.** Not required for the default setup — see below. |
| **git / psql / ollama** | **Optional.** None are required by the app. |

### Database: zero-install by default

The app ships an **embedded PostgreSQL (PGlite) with the real `pgvector` extension**.
When `DATABASE_URL` is empty it stores everything under `storage/pgdata` — **no PostgreSQL
server, no `psql`, no Docker**. To use a real PostgreSQL instead, set `DATABASE_URL` and the
app switches over automatically (see [Configuration](#configuration)).

> `psql` and `ollama` are **not** on `PATH` on this machine; the app was fully installed,
> booted and tested without them. `git` is used only to publish the source.

---

## Quick start (PowerShell)

```powershell
# 1. Install dependencies (workspaces: server + web)
npm install

# 2. Create your environment file and set a master key
Copy-Item .env.example .env
node -e "console.log('APP_MASTER_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
#   -> paste that line into .env (replace the placeholder)
#   Optional: set ADMIN_EMAIL=you@company.com to create the first administrator at boot;
#   otherwise you will be asked to create one in the UI on first launch.

# 3. Pre-flight check (Node/npm/.env/master key/storage)
npm run setup

# 4. Create the schema (embedded PGlite — no server needed; also runs on boot)
npm run db:migrate

# 5. Developer mode: API on :3001 + Vite UI on :5173
npm run dev
#   open http://localhost:5173
```

The backend dev script intentionally runs **without file-watching**. PGlite is a single
process, and restarting it while it is writing can abort/corrupt the embedded database.
The UI still hot-reloads; after changing backend files, stop the stack with `Ctrl+C` and
run `npm run dev` again. Do not run two dev stacks at once — the second API will fail with
“database already open”. Use a real PostgreSQL (`DATABASE_URL`) if you want file-watching.

**Production-style single origin** (the backend serves the built SPA, one port):

```powershell
npm run build      # builds web/dist
npm start          # serves UI + API on http://127.0.0.1:3001
```

Then in the UI: **sign in → create a project → upload documents → wait for "indexed" → ask a
question → read the grounded answer and expand its citations.** Sign in with a password or a
single-use email link. The first launch asks you to create the administrator, after which you
invite users from the **Admin** page (see below for email setup).

To get *generated* answers you must add an LLM provider key in **Settings** (stored
encrypted). With no key configured, retrieval, document management and citation inspection
still work, but no answer is generated.

---

## How it runs

```
Browser (React + Vite + Tailwind)
   │  /api  (same origin in production; Vite dev proxy in development)
   ▼
Express API (CommonJS) ── Zod validation, narrow CORS, security headers
   │
   ├── Ingestion worker (DB-backed job queue)
   │     parsers → structure-aware chunker → embeddings → document_chunks
   │
   ├── Crawl worker (DB-backed job queue)
   │     SSRF-safe fetch → HTML→Markdown → document version → ingestion
   │
   ├── Retrieval (hybrid)
   │     pgvector cosine search  +  PostgreSQL full-text search
   │     → Reciprocal Rank Fusion → optional rerank → relative-score cutoff
   │
   ├── Grounding prompt (evidence wrapped as untrusted data)
   │
   └── LLM provider registry (OpenRouter / Groq - OpenAI-compatible)
         streaming via Server-Sent Events

Storage: local filesystem or private Supabase Storage (originals)
Database: PostgreSQL + pgvector  (or embedded PGlite + pgvector)
```

- **Embeddings:** local by default via `@xenova/transformers` (`all-MiniLM-L6-v2`, 384 dims).
  `ollama`, an OpenAI-compatible endpoint, and a deterministic offline `hash` provider are
  also available. Dimension is stored in the DB and validated.
- **Document versioning:** re-uploading the same content is detected by hash. History is
  immutable; a version is explicitly activated, and it can be searched only on request
  (`includeHistoricalVersions`).
- **Multi-format ingestion:** PDF, DOCX, XLSX, PPTX, TXT, Markdown, CSV, JSON, YAML,
  HTML, XML, RTF, ODT/ODS/ODP, source code and logs (~49 extensions).
- **Per-project persona:** each project can carry operator **instructions** that give the
  assistant a role (e.g. *Senior SQA Engineer*) and an output convention. They are appended
  to the grounded prompt and stay **subordinate** to the grounding/citation/untrusted-content
  rules, so they can never make the assistant invent facts or leak secrets. Editable in
  *Dashboard → Edit* (with a starter persona template and an 8000-character limit).
- **Knowledge base:** besides files, a project can hold **web links** (pages that are crawled
  into documents), **link lists** (a named set of URLs to import in one go) and
  **collections** (named groups of documents and links). See below.
- **Accounts:** password or single-use email-link sign-in; users see the projects they own or
  are assigned, administrators see everything. See below.
- **Public chat widget:** expose any project as an embeddable chat widget on another website
  with configurable branding, consent, allowed origins, and a copyable JavaScript snippet. External
  visitor conversations are isolated from internal chat history and reviewable by administrators.

### Accounts, sign-in and administration

A user can sign in with their email address and password, or request a **single-use,
time-limited sign-in link** (`/login#token=...`) by email. Passwords are optional: an invited
user can set one from their invitation link, and anyone can request a password reset from the
sign-in screen. Passwords are stored only as salted scrypt hashes. The link token travels in the
URL fragment, so it is never sent to the server or written to access logs, and it is removed
from the address bar as soon as it is consumed. A successful sign-in sets an HttpOnly,
`SameSite=Lax` session cookie (`quarry_session`); state-changing requests additionally require a
same-origin request. Setting or resetting a password revokes the account's other sessions.

**First run.** Either set `ADMIN_EMAIL` (and optionally `ADMIN_NAME`) in `.env` - the first
administrator is created at boot and a sign-in URL is printed to the server console - or open
the web app and complete the one-time setup screen. Do this **immediately** after the first
deploy (or set `ADMIN_EMAIL` up front): until the first account exists, whoever reaches the
setup screen can claim the administrator role. Projects that existed before accounts were
introduced are assigned to the first administrator.

**Administration.** Administrators get an **Admin** entry in the sidebar with:

- workspace totals (users, invites, projects, documents, chunks, conversations, active jobs);
- user management: create an account (which emails a sign-in link), resend a link, send a
  password-reset link, promote or demote, disable/enable, revoke all sessions, assign one or
  more projects, and delete a user (their projects must be reassigned to another administrator).

**Email.** Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` and
`MAIL_FROM` to send links automatically. SMTP is optional, and administrators always see the
generated one-time link in the UI (even when email was sent successfully), so it can be handed
over by another channel or copied if the message lands in spam. Mail failures never break
account creation.

**Isolation.** A project has an owner and may be assigned to other users. A normal user can
read or use the projects they own or were assigned, plus everything hanging off those projects
(documents, versions, chunks, links, link lists, collections, jobs). Renaming, archiving and
deleting a project remain owner-only. Foreign resources return **404**, not 403, so the API
never confirms that somebody else's data exists. Conversations also record the user who
created them: a user only sees their own chats, while an administrator sees every chat in the
workspace. That means an administrator can review a user's conversations, but chats the
administrator starts in that user's project stay private to administrators. Cross-project
search is filtered to the caller's accessible projects. Global configuration (providers,
settings, model usage, user management) is administrator-only; the only non-admin exception is
the personal `ui_theme` preference and the read-only model list used by the chat selector.

### Pages and URLs

Every page is a real URL that can be bookmarked, refreshed, or opened in a second window. The
active project travels in `?project=<id>`; the old `#`-based navigation is no longer used.

| Page | URL |
| --- | --- |
| Chat | `/chats` |
| Documents | `/documents` |
| Search | `/search` |
| Dashboard | `/dashboard` |
| Chat widget settings | `/embed` |
| Administrator conversation review | `/admin/conversations` |
| User administration | `/admin` |
| Model usage | `/model-usage` |
| Settings | `/settings` |

`/` and `/login` canonicalise to a real view once a session exists. The public widget is served
at `/embed/<publicKey>` and works without an account.

### Administrator conversation review

Administrators get a dedicated **Conversation review** window at `/admin/conversations`. It is
separate from normal chat and has four scopes:

- **My chats** - internal conversations the administrator owns;
- **Other users** - internal conversations owned by anybody else;
- **Widget visitors** - conversations started from a public widget;
- **All** - every internal and widget conversation.

Rows can be filtered by project, by workspace user, and by free-text search over titles, user
names/emails, and visitor names/emails. Opening a row shows the full transcript and citations
plus the visitor's name, email, and consent time. Administrators can **delete** a conversation,
but cannot reply, impersonate a user, or post as a visitor from this surface. Widget
conversations stay out of normal project history, dashboard statistics, and workspace counts,
even for administrators.

### Public chat widget

A project owner (or an administrator) can expose a project as an embeddable chat widget from
**Chat widget** (`/embed`). The page provides:

- **Branding** - brand name, slogan, theme colour, welcome message, and a logo uploaded as a
  PNG/JPEG/WEBP/GIF (2 MB limit) or supplied as an external URL. Uploaded logos are stored under
  the `external_logo/` folder in the configured storage backend;
- **Consent** - enable or disable the consent gate and edit its title, body, and privacy-policy
  link;
- **Allowed origins** - the websites permitted to use the key. An empty list allows any site;
  the app's own origin is always allowed;
- **Embed code** - a copyable `widgetUrl` and a floating launcher snippet:

  ```html
  <script src="https://your-host/embed.js?key=PUBLIC_KEY" async></script>
  ```

- **Key rotation** - invalidates the previous key and the old snippet immediately.

The launcher injects a floating button and an iframe pointing at `/embed/<publicKey>`. Visitors
do not sign in. Before the first message they enter their **name**, **email**, and (when
required) accept the consent notice. The server returns a random visitor token; the browser
keeps it in `localStorage` for that widget only, and the database stores only its SHA-256 hash.
Conversations are written to the normal `conversations`/`messages` tables with
`channel = 'external'`, a visitor snapshot, and no workspace owner. The widget API runs before
session authentication and CSRF, is scoped to one embed key and visitor token, and its
conversations are visible only through the administrator review window. Deleting the project,
the widget, or the conversation cascades the associated visitor data.

### Supabase / hosted Postgres: lock down the public schema

Supabase exposes the `public` schema over PostgREST to the `anon` and `authenticated` roles by
default. This app talks to Postgres directly (the table owner), so it does not need that
surface at all. Migration **`007_lockdown_public.sql`** revokes `anon`/`authenticated` grants
on every table in `public`, removes default privileges, and enables row-level security with no
policies, which makes PostgREST return nothing even if the schema stays exposed.

Also do this once in the Supabase dashboard:

1. **Project Settings → API → Exposed schemas:** remove `public` (keep only the schemas you
   actually expose; none for this app).
2. Keep using the **session pooler** (`…pooler.supabase.com:5432`) rather than the
   transaction pooler (`:6543`), and use a database user that owns the tables (or has
   `BYPASSRLS`) — the RLS-with-no-policies lockdown otherwise blocks the app itself.
3. Use TLS and verify the server certificate. The verified shape is:
   `...?sslmode=verify-full&sslrootcert=./certs/prod-ca-2021.crt`. The server replaces
   `sslrootcert` with the bundled public CA at `server/certs/prod-ca-2021.crt`, resolved
   from the code rather than the current working directory, so it works on hosts like
   Render. Set `DB_CA_CERT` to the certificate contents to override the file (literal
   `\n` line breaks are supported). Download the public CA from **Database Settings →
   SSL Configuration**. Current `pg` treats bare `sslmode=require` as verify-full, so it
   needs the CA; `sslmode=no-verify` encrypts but does not authenticate the server. Also
   enable **Enforce SSL on incoming connections** in the dashboard.

Run the migration again after adding any table to `public`, or enable RLS on it manually.
`npm run check` verifies the result on a live host: it fails if `anon`/`authenticated`
still hold table privileges or if any table in `public` has RLS disabled.

### Supabase Storage (recommended on Render)

Render's free tier has an ephemeral disk, so files under `STORAGE_DIR` disappear on redeploy.
Set all three Supabase Storage variables to keep uploaded documents in a private bucket:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only service-role key>
SUPABASE_STORAGE_BUCKET=quarry-documents
SUPABASE_LOGO_FOLDER=external_logo
```

Create the bucket as **private**. The app talks to the Supabase Storage REST API with the
service-role key from the server only; it never sends the key to the browser and never exposes a
public bucket URL. Downloads still go through `GET /api/documents/:id/file`, so the existing
project/user authorization checks apply before any bytes are read.

Document object keys include the owner, project and document ids:

```text
<owner-user-id>/<project-id>/<document-id>/v<version>__<filename>
```

Widget logos use a separate folder in the same bucket and the same Supabase URL/service-role
key. Set `SUPABASE_LOGO_FOLDER` to choose that folder; it defaults to `external_logo`:

```text
external_logo/<project-id>/<embed-id>/v1__<filename>
```

On local disk this becomes `storage/uploads/external_logo/...`. Old logo keys remain readable, so
re-uploading or deleting a reviewed logo cleans up only the object it replaces.

Permanent document deletion and project deletion remove the corresponding objects. If any of
the three variables is missing, the app uses `STORAGE_DIR` (local disk) as before, which is the
default for development and tests.

**Never** put `SUPABASE_SERVICE_ROLE_KEY` in the web app, a `VITE_*` variable, a public config
endpoint, or source control. Rotate it immediately if it is exposed.

### The Documents page: "Upload documents" and "View documents"

The **Documents** entry in the sidebar has two sections:

| Section | What it holds |
| --- | --- |
| **Upload documents** | Everything that *adds* to the knowledge base: the file drop zone, **web links**, **link lists**, **collections** and the **crawl jobs** that fetch the linked pages. |
| **View documents** | The document table (search, status filter, archived toggle, versions, re-index) plus the shared **`.md`** file of every document. |

**Web links** are pages on the internet that become part of the knowledge base. Paste one or
more URLs and they are queued for a crawl: the page is fetched, converted to Markdown and
stored as a normal document version, so it is retrieved, cited and versioned exactly like an
uploaded file. **Re-crawl** fetches the page again and adds a **new version** — the previous
content stays available, which is what keeps old citations verifiable.

**Link lists** are named sets of URLs. A list is inert until it is **imported**, which turns
every URL into a web link and queues a crawl for each of them (optionally into a collection).

**Collections** group documents and web links under a name. A collection is a view over the
knowledge base, not a copy: the items keep their own versions and crawl history.

**Crawl jobs** record every fetch. A failed job can be retried, which puts the link back into
the queue.

**Sharing a document as Markdown.** Every document can be handed out as a single `.md` file —
the content of the active version with a small YAML front-matter header (title, source,
project, version, and the source URL for a crawled page). In **View documents** each row has a
**View .md** button (renders the file in the app, with a *Source* tab for the raw bytes) and a
**download icon** that saves it as `<title>.md`.

### Crawling is SSRF-safe

A crawler fetches URLs a human typed in, so it is a classic server-side request forgery
vector. The fetcher therefore:

- accepts only `http`/`https` and refuses URLs with embedded credentials;
- refuses hostnames that resolve to a **loopback, link-local, private or unique-local**
  address (so `http://169.254.169.254/` — the cloud metadata endpoint — is never read);
- **re-validates every redirect hop**;
- caps the response size and the request duration.

Set `CRAWL_ALLOW_PRIVATE_HOSTS=true` only on a trusted machine (it is enabled automatically
for the test suite so it can crawl a local fixture server).

### Per-project persona & HTML deliverables

Set the instructions on a project (Dashboard → Edit → *Instructions / persona*) to steer the
assistant's role and output style for that project only. A common setup is the built-in
**Senior SQA Engineer** persona, which asks the model to produce QA deliverables — test plans,
requirement/traceability mappings, test cases, test reports, bug reports, feature listings —
as **self-contained HTML**.

When an answer contains a fenced ` ```html ` block, the chat renders it as an **HTML
deliverable**: the raw markup is shown in a code view, and a **Preview / Copy / Download**
button lets you inspect or save it. The preview is always **sandboxed in a blank iframe**
(`sandbox=""` — no scripts, no same-origin, no forms), so model-authored HTML can never run
against the app or read your data. The model authors the HTML itself; nothing is templated in
code beyond the optional starter persona.

Grounding and abstention are unchanged by any persona: the model is still only invoked when
evidence exists, and every claim is still tied to a real, cited source.

### Providers & the model-usage page

**Exactly two providers can answer questions.**

| Provider | Endpoint | Default model |
| --- | --- | --- |
| **OpenRouter** (primary) | `https://openrouter.ai/api/v1` | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| **Groq** (fallback) | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |

Both speak the OpenAI chat-completions protocol, so they share one adapter. Configure them in
**Settings → AI Providers** (the key is encrypted at rest), or for a UI-free setup with the
optional `OPENROUTER_API_KEY` / `GROQ_API_KEY` variables in `.env` (see `.env.example`).
Precedence is: the provider configured in Settings first, then the environment values.

**Automatic fallback and model rotation.** If OpenRouter has no key, or the request fails
with a rate limit / quota error, the app retries the same question once through **Groq**
and records which provider actually answered (`messages.provider`, `messages.model`).

Provider catalogues change — a model that worked yesterday can be retired overnight
(OpenRouter dropped `deepseek/deepseek-chat-v3-0324:free`, Groq dropped
`llama-3.1-8b-instant`). Each provider therefore keeps an ordered list of known models, and
a request that fails with `model_not_found` is retried with the next known model of the
same provider before the provider fallback is used. A timeout is never retried.

A third, **offline `mock`** adapter exists so the automated test suite and the end-to-end
run need no API key and no network. It is registered **only** when the process starts with
`NODE_ENV=test` (or under Vitest), so it can never answer a real question in a normal run.

**Model usage page (`/model-usage`).** Usage is measured from this app's own completed
answers. The page lists every model used with its requests and input/output/total tokens,
an average per request, and a grand total. Filter by day, week, month, year, or a custom
calendar range, and group the time-series chart by day/week/month/year.

---

## Deploy on Render

The repository is [github.com/mokaddes-arman/quarry](https://github.com/mokaddes-arman/quarry).
Quarry runs on Render as a single **Web Service**. The Node server serves both the API and the
built web app from one origin.

### 1. Create the service

You can use either option:

- **Blueprint (recommended).** In Render choose **New → Blueprint**, connect the
  `mokaddes-arman/quarry` repository, and Render reads [`render.yaml`](render.yaml). It asks
  for every secret marked `sync: false`.
- **Manual.** Choose **New → Web Service**, connect the repository and set:

| Setting | Value |
| --- | --- |
| Runtime | Node (version comes from `engines` in `package.json`: 24.x) |
| Branch | `main` |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |

Vite and Tailwind are regular dependencies, so the build also works with Render's default
`npm install; npm run build`. `--include=dev` just installs the test tooling as well.

### 2. Environment variables

| Variable | Required | Value |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` (turns on secure cookies) |
| `APP_MASTER_KEY` | yes | 32+ random characters. **If you reuse an existing database, use the same key as before.** Otherwise the stored provider API keys cannot be decrypted. |
| `DATABASE_URL` | yes | Supabase or other hosted Postgres with pgvector. Render's disk is ephemeral, so the embedded PGlite database is lost on every deploy. See [Supabase / hosted Postgres](#supabase--hosted-postgres-lock-down-the-public-schema). |
| `APP_PUBLIC_URL` | yes | The service URL, e.g. `https://quarry.onrender.com` (no trailing slash). Used in emailed links and in the widget embed snippet. |
| `CORS_ORIGIN` | yes | The same URL as `APP_PUBLIC_URL` |
| `ADMIN_EMAIL` / `ADMIN_NAME` | first deploy | Your email. The first administrator is created at boot and a sign-in link is printed to the Render log. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | recommended | Keeps uploaded files and widget logos after redeploys. See [Supabase Storage](#supabase-storage-recommended-on-render). If you reuse an existing bucket, keep its current name. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | optional | Sends invitations and sign-in links by email. Without SMTP, links are shown to the administrator and printed to the log. |
| `OPENROUTER_API_KEY` / `GROQ_API_KEY` | optional | You can also add provider keys later in **Settings → AI Providers** (stored encrypted). |

All other settings have working defaults. See [Configuration](#configuration).

### 3. After the first deploy

1. Open the Render log, follow the printed sign-in link (or open the site and finish the
   setup screen straight away), and set a password.
2. Add an LLM provider key in **Settings**, if you didn't set one as an environment variable.
3. The demo account shown on the login page exists only if you create it. Create it from
   **Admin → Users** with the email and password listed under [Demo account](#demo-account), or
   remove the `DEMO_ACCOUNT` block in `web/src/views/LoginView.jsx`.
4. **Moving from an older deployment:** the session cookie is now `quarry_session`, so
   everyone signs in again once. Websites that embed the chat widget must update the snippet
   to the new service URL. Copy the new snippet from **Embed** in the app.

---

## Configuration

All configuration lives in `.env` (never committed). `.env.example` documents every value.
The most important ones:

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST` / `PORT` | Bind address / port (all interfaces by default; set `HOST=127.0.0.1` for local-only). Render sets `PORT` automatically. | `0.0.0.0` / `3001` |
| `DATABASE_URL` | Real PostgreSQL + pgvector. **Empty → embedded PGlite.** | *(empty)* |
| `PGLITE_DIR` | Embedded database directory. | `./storage/pgdata` |
| `APP_MASTER_KEY` | 32+ char key that encrypts provider keys at rest. | *(must set)* |
| `STORAGE_DIR` | Local upload/temp directory; originals live there only when Supabase Storage is not configured. | `./storage` |
| `SUPABASE_URL` | Supabase project URL; set with the two variables below to enable remote storage. | *(empty)* |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service-role key for the private storage bucket. Never expose to the browser. | *(empty)* |
| `SUPABASE_STORAGE_BUCKET` | Private bucket name for original uploads. | *(empty)* |
| `SUPABASE_LOGO_FOLDER` | Folder prefix for widget logos within the same bucket. | `external_logo` |
| `MAX_UPLOAD_SIZE_MB` | Per-file upload cap. | `20` |
| `ADMIN_EMAIL` | First administrator, created on boot when the user table is empty. | *(empty)* |
| `APP_PUBLIC_URL` | Public origin used in emailed sign-in links. | *(request host)* |
| `AUTH_TOKEN_TTL_MINUTES` | Lifetime of a single-use sign-in link. | `30` |
| `AUTH_SESSION_DAYS` | Lifetime of a browser session. | `14` |
| `DEFAULT_EMBEDDING_PROVIDER` | `local` \| `ollama` \| `openai` \| `hash`. | `local` |
| `DEFAULT_EMBEDDING_MODEL` | Model id (must match `EMBEDDING_DIM`). | `Xenova/all-MiniLM-L6-v2` |
| `EMBEDDING_DIM` | Stored vector dimension. | `384` |
| `DISABLE_HOSTED_AI` | Privacy mode: refuse all hosted LLM calls. | `false` |
| `DEFAULT_LLM_PROVIDER` | Provider that answers questions — `openrouter` \| `groq`. | `openrouter` |
| `DEFAULT_LLM_MODEL` | Default model id for the chosen provider. | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| `OPENROUTER_API_KEY` | *(optional)* env fallback for the OpenRouter key. | *(empty)* |
| `GROQ_API_KEY` | *(optional)* env fallback for the Groq key. | *(empty)* |
| `RETRIEVAL_TOP_K` | Number of chunks returned. | `8` |
| `CRAWL_ALLOW_PRIVATE_HOSTS` | Allow the crawler to fetch loopback/private hosts (SSRF guard). | `false` |
| `SMTP_HOST` / `SMTP_PORT` | SMTP server for sign-in and invitation emails. | *(empty → links shown to the admin)* |
| `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | SMTP TLS + credentials. | `false` |
| `MAIL_FROM` / `MAIL_REPLY_TO` | Sender used in outgoing mail. | *(`no-reply@localhost`)* |

### Web crawling

The knowledge base can ingest **web pages**. The crawler is deliberately conservative:

| Variable | Purpose | Default |
| --- | --- | --- |
| `CRAWL_TIMEOUT_MS` | Maximum duration of one page fetch. | `30000` |
| `CRAWL_MAX_BYTES` | Hard cap on one downloaded page. | `5242880` (5 MiB) |
| `CRAWL_MAX_REDIRECTS` | Redirect hops allowed (each hop is re-validated). | `5` |
| `CRAWL_MAX_ATTEMPTS` | Attempts per crawl job before it is marked failed. | `3` |
| `CRAWL_CONCURRENCY` | Pages fetched in parallel by the crawl worker. | `1` |
| `CRAWL_USER_AGENT` | `User-Agent` sent with every fetch. | `QuarryBot/1.0 …` |
| `CRAWL_ALLOW_PRIVATE_HOSTS` | Allow loopback/private/link-local targets. **Off by default** (SSRF protection). | `false` |
| `CRAWL_STALE_JOB_MS` | A "processing" crawl job older than this is orphaned and re-queued. | `300000` |

### Deadlines (nothing can hang)

Every stage of a question and of an ingestion run has its own budget, so the UI always
gets a definite answer instead of an endless spinner.

| Variable | Guards | Default |
| --- | --- | --- |
| `ASK_TIMEOUT_MS` | The whole ask (provider → retrieval → generation). | `180000` |
| `RETRIEVAL_TIMEOUT_MS` | Embedding + hybrid search for one question. | `60000` |
| `DB_QUERY_TIMEOUT_MS` | Any single SQL statement. | `30000` |
| `LLM_REQUEST_TIMEOUT_MS` | The provider HTTP request. | `120000` |
| `LLM_STREAM_IDLE_TIMEOUT_MS` | Maximum silence between two streamed tokens. | `60000` |
| `EMBEDDING_REQUEST_TIMEOUT_MS` | The embedding provider request. | `60000` |
| `INGESTION_PARSE_TIMEOUT_MS` | Parsing one document. | `180000` |
| `INGESTION_JOB_TIMEOUT_MS` | One ingestion job, end to end. | `900000` |
| `INGESTION_STALE_JOB_MS` | A "processing" job older than this is orphaned and re-queued. Keep it **above** `INGESTION_JOB_TIMEOUT_MS`. | `1200000` |
| `CRAWL_TIMEOUT_MS` | One page fetch (web crawl). | `30000` |
| `CRAWL_STALE_JOB_MS` | A "processing" crawl job older than this is orphaned and re-queued. | `300000` |

Generate a master key:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Using a real PostgreSQL instead of PGlite

```powershell
# 1. Create a database and enable pgvector once:
#    CREATE EXTENSION IF NOT EXISTS vector;
# 2. Point the app at it in .env:
#    DATABASE_URL=postgres://quarry_user:change_me@localhost:5432/quarry
# 3. Apply migrations:
npm run db:migrate
```

For Supabase (or any hosted Postgres that exposes a REST API) also follow
[Supabase / hosted Postgres: lock down the public schema](#supabase--hosted-postgres-lock-down-the-public-schema)
above. Use the session pooler on port `5432`, not the transaction pooler.

---

## Commands

Run from the repository root:

| Command | What it does |
| --- | --- |
| `npm install` | Install all workspaces. |
| `npm run setup` | Pre-flight check: Node/npm, `.env`, master key, storage, optional tools. |
| `npm run dev` | API (`:3001`) + Vite UI (`:5173`) together. |
| `npm run dev:server` / `npm run dev:web` | Run just one side. The server does not file-watch; restart it after backend edits. |
| `npm run build` | Build the React SPA into `web/dist`. |
| `npm start` | Serve API **and** built SPA from one origin (`:3001`). |
| `npm run db:migrate` / `npm run db:status` | Apply / inspect migrations. |
| `npm run check` | Backend readiness report (DB, pgvector, schema, REST-exposure lockdown, embeddings, providers). |
| `npm test` | Backend unit + integration tests (Vitest). |
| `npm run test:e2e` | Playwright end-to-end suite (builds the SPA and boots its own server). |
| `npm run eval:rag` | Offline retrieval evaluation dataset + grounded-answer smoke test. |

---

## Testing & verification

Current status on this machine (all commands run from the repo root):

| Suite | Command | Result |
| --- | --- | --- |
| Backend unit + integration | `npm test` | **199 passed** (19 files) |
| End-to-end (real browser + real backend) | `npm run test:e2e` | **23 passed** |
| Retrieval evaluation | `npm run eval:rag` | **8/8 retrieval (100%) + e2e smoke pass** |
| Backend readiness | `npm run check` | **all checks passed** |

**What each suite proves**

- **Backend tests** — parsers, chunker, encryption, security (path traversal, validation,
  CORS), projects, documents/versioning, providers, retrieval, and the chat contract
  (grounding, abstention, source persistence, SSE streaming, prompt-injection wrapping).
  Auth and isolation have dedicated coverage: magic-link single use/expiry, password sign-in,
  invitation/reset password setup, sessions, CSRF, disabled accounts, first-run setup,
  401/403/404 boundaries, admin user CRUD (invite/resend/disable/delete/reassign), project
  assignment and access rules, cross-project retrieval scoping and the admin-only surfaces.
  The knowledge base has its own coverage:
  URL parsing/canonicalisation, private-host refusal, link lists, collections, crawl jobs
  and the `.md` export. Widget coverage adds owner/admin configuration, logo upload and
  deletion, key rotation, allowed origins, visitor consent and token hashing, external
  conversation isolation, administrator scopes/filters/detail/delete, and checks that widget
  chats never appear in project history, dashboard statistics or workspace counts.
- **End-to-end tests** — a real Chromium browser drives the actual SPA against a real
  backend: onboarding → project → document upload → indexing → ask → read the grounded
  answer and expand its citations; the HTTP-level RAG contract (retrieval, grounding,
  abstention on empty projects, per-project isolation and explicit cross-project opt-in);
  the knowledge-base flow (crawl a page → it becomes a document → preview and download
  its `.md`, create a link list and a collection); the admin flow (invite a user →
  set a password from the one-time link → sign in with it in a clean browser → the new
  account gets an isolated, project-less workspace, cannot see admin navigation, and the
  link cannot be reused); stable per-page URLs and reloads; the administrator conversation
  review window with own/other-user/widget scopes, filters, detail and delete; and the
  public widget flow in a clean browser (branding → consent + name/email → grounded answer
  with sources → transcript restored after reload → visible in the admin viewer).
- **RAG evaluation** — ingests a small labelled corpus and checks the right chunks are
  retrieved, that clearly-absent facts are **not** surfaced, and that a question yields a
  grounded answer with citations.

The e2e suite is deliberately **offline and deterministic**: it uses the embedded PGlite
database in a throwaway `storage/.e2e`, the `hash` embedding provider and the `mock` LLM
provider, so it needs no API keys and no network. It validates **wiring, grounding and
citations** — not model answer quality. Validate answer quality with your own model via
`npm run eval:rag` after configuring providers in Settings.

---

## API surface

All routes are under `/api` (the launcher script is the one root-level exception). Highlights:

| Area | Endpoints |
| --- | --- |
| Auth | `GET /auth/status`, `GET /auth/me`, `POST /auth/setup` (first run only), `POST /auth/request-link`, `POST /auth/login`, `POST /auth/password/forgot`, `POST /auth/link-info`, `POST /auth/verify`, `POST /auth/logout` |
| Administration | `GET /admin/overview`, `GET/POST /admin/users`, `PATCH /admin/users/:id`, `POST /admin/users/:id/resend`, `POST /admin/users/:id/password-reset`, `GET/PUT /admin/users/:id/projects`, `DELETE /admin/users/:id/projects/:projectId`, `DELETE /admin/users/:id/sessions`, `DELETE /admin/users/:id?reassign=<adminId>` (admin only) |
| Conversation review | `GET /admin/conversations?scope=mine\|users\|external\|all&projectId=&userId=&search=&limit=&offset=`, `GET/DELETE /admin/conversations/:id` (admin only; read/delete, no replies) |
| Widget settings | `GET/PATCH /projects/:id/embed`, `POST /projects/:id/embed/rotate-key`, `POST/DELETE /projects/:id/embed/logo` (project owner or admin) |
| Public widget | `GET /public/embeds/:key`, `GET /public/embeds/:key/logo`, `POST /public/embeds/:key/visitors`, `GET /public/embeds/:key/session`, `POST /public/embeds/:key/conversations`, `GET/POST /public/embeds/:key/conversations/:id/messages` (visitor token, no session) |
| Launcher | `GET /embed.js?key=<publicKey>` (root, outside `/api`) |
| Health | `GET /health`, `GET /health/ready`, `GET /system/status` |
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id` |
| Documents | `POST /projects/:projectId/documents/upload`, `GET /projects/:id/documents`, `GET/DELETE /documents/:id`, `GET /documents/:id/versions`, `POST /documents/:id/activate-version`, `POST /documents/:id/reindex`, `POST /documents/:id/restore`, `GET /documents/:id/file`, `GET /chunks/:id` |
| Markdown export | `GET /documents/:id/markdown` (JSON preview), `GET /documents/:id/markdown/download` (raw `.md` attachment; optional `?versionId=`) |
| Web links | `GET/POST /projects/:id/links`, `GET/PATCH/DELETE /links/:id`, `POST /links/:id/crawl` (re-crawl → new version) |
| Link lists | `GET/POST /projects/:id/link-lists`, `GET/DELETE /link-lists/:id`, `POST /link-lists/:id/items`, `POST /link-lists/:id/import` |
| Collections | `GET/POST /projects/:id/collections`, `GET/PATCH/DELETE /collections/:id`, `POST /collections/:id/items`, `DELETE /collections/:id/items/:itemId` |
| Crawl jobs | `GET /projects/:id/crawl-jobs`, `POST /crawl-jobs/:id/retry` |
| Conversations | `POST /projects/:projectId/conversations`, `GET /projects/:id/conversations`, `GET/PATCH/DELETE /conversations/:id`, `GET /conversations/:id/messages` |
| Answering | `POST /conversations/:id/messages` (SSE stream or JSON), `POST /conversations/:id/evidence` (retrieval only) |
| Projects (extra) | `GET /projects/:id/stats`, `GET /projects/:id/search`, `POST /projects/:id/archive` and `/restore`, `GET /projects/:id/jobs`, `POST /jobs/:id/retry` |
| Providers | `GET /providers/metadata`, `GET /providers/llm` (safe fields for every signed-in user); everything else (create/edit/test/default, `/providers/embedding`) is **admin only** |
| Usage | `GET /model-usage` (per-model token usage; `from`, `to`, `granularity`, `provider`, `model`, `projectId`), `GET /model-usage/catalog` (admin only) |
| Settings | `GET /settings`, `GET/PUT /settings/:key`, `GET /settings/embedding-index` (admin only); `PUT /settings/ui_theme` is available to every signed-in user |

Streaming answers emit Server-Sent Events: `status`, `retrieval`, `sources`, `token`,
`done`, `complete`, `error`.

---

## Security model

- **All interfaces by default** (`HOST=0.0.0.0`) so container hosts such as Render can reach
  the server; set `HOST=127.0.0.1` for local-only. Narrow CORS allow-list; strict security
  headers; no `x-powered-by`.
- **Authentication:** password or single-use emailed sign-in links, salted scrypt password
  hashes, SHA-256-hashed tokens, HttpOnly `SameSite=Lax` session cookies, same-origin
  enforcement for unsafe methods (CSRF), per-address/per-IP throttling on the auth endpoints,
  and immediate session revocation on logout, password change or by an administrator.
- **Per-user isolation:** every project has an owner; normal users can only reach the projects
  they own or were assigned, and the rows attached to them. Foreign resources are reported as
  404. Global administration surfaces are role-gated on the server, not just hidden in the UI.
- **Public widget isolation:** the widget API has no cookie/session auth. It is limited to one
  embed key, enforces the configured allowed origins, stores only hashed visitor tokens, and
  accepts a visitor token via `Authorization: Bearer ...` or `x-embed-token`. External
  conversations never appear in internal lists, project statistics, or workspace counts, and
  only administrators can read or delete them. The widget surfaces replace
  `X-Frame-Options: DENY` with `Content-Security-Policy: frame-ancestors *` so customers can
  iframe them; every other response keeps the deny-by-default framing policy.
- **Hosted Postgres lockdown:** the Supabase migration revokes `anon`/`authenticated` access
  and enables deny-by-default RLS on `public` (see above).
- **Every request body/query/param is validated with Zod**; SQL is fully parameterised.
- **Uploads** are stored with sanitised names; path traversal is rejected; size limits apply
  (`MAX_UPLOAD_SIZE_MB`, 20 MB by default).
- **API keys** are encrypted with AES-256-GCM using a key derived from `APP_MASTER_KEY`,
  returned only masked, and never logged.
- **Prompt injection:** retrieved text is wrapped in explicit evidence blocks and the system
  prompt instructs the model to treat it as untrusted data and never to reveal secrets or
  follow embedded instructions.
- `DISABLE_HOSTED_AI=true` blocks all outbound LLM calls for air-gapped operation.

---

## Project layout

```
.
├─ server/                 Express API (CommonJS)
│  ├─ src/
│  │  ├─ config/           validated .env
│  │  ├─ db/               PostgreSQL/PGlite layer, migrations, schema
│  │  ├─ crawl/            SSRF-safe fetcher, HTML→Markdown, crawl job worker
│  │  ├─ embeddings/       local / ollama / openai / hash providers
│  │  ├─ llm/              provider registry, prompt, streaming
│  │  ├─ ingestion/        job queue, worker, parsers, chunker
│  │  ├─ retrieval/        hybrid pgvector + full-text search, RRF, rerank
│  │  ├─ services/         projects, documents, conversations, providers, knowledge
│  │  ├─ middleware/       validation, errors, request context
│  │  └─ routes/           HTTP endpoints
│  ├─ tests/               Vitest unit + integration
│  ├─ eval/                retrieval evaluation corpus + dataset
│  └─ scripts/             check.mjs, rag-eval.mjs
├─ web/                    React + Vite + Tailwind SPA
│  └─ src/                 views, components, API client, theme
├─ e2e/                    Playwright specs + harness
├─ scripts/                check-prereqs.mjs
├─ storage/                runtime data (git-ignored)
├─ .env.example            configuration template
├─ playwright.config.js    e2e configuration (one origin, port 3101)
└─ TODO.md                 implementation checklist
```

---

## Known limitations

These are real and worth knowing before you rely on the app:

1. **Generated answers require a configured LLM provider.** Without a key in Settings, the
   app retrieves evidence and shows citations but does not produce an answer. Set an API
   key, or use the `mock`/local provider for testing.
2. **The default local embedding model downloads on first use.** `Xenova/all-MiniLM-L6-v2`
   (~90 MB) is fetched into `storage/models` the first time you index a document and needs
   network access. For a fully offline run, set `DEFAULT_EMBEDDING_PROVIDER=hash` — but note
   `hash` embeddings are **deterministic and not semantic**, suitable for development only.
3. **The embedded PGlite database is single-process.** An exclusive lock
   (`storage/pgdata.lock`) makes a second server, `npm run check`, migration or test run
   fail with a clear “already open” message instead of writing to the same directory.
   For that reason the backend dev script runs without `--watch`: restart it with
   `Ctrl+C` + `npm run dev` after backend edits, and never run two dev stacks. Use a real
   PostgreSQL (`DATABASE_URL`) if you need concurrency or file-watching. If startup still
   aborts with `Aborted()`, the data directory itself is corrupt: stop every server, move
   `storage/pgdata` aside, then run `npm run db:migrate` to create a fresh database.
   Uploaded source files remain under `storage/uploads`.
4. **E2E tests exercise the `mock` LLM and `hash` embeddings**, so they verify behaviour and
   citation integrity, not answer quality. Answer quality must be judged with a real model.
5. **The retrieval eval ships with an offline hash-embedding run.** It is a wiring/grounding
   regression check over a tiny corpus, not a benchmark of your production model.
6. **The working tree was not under version control until now.** The folder had no git
   repository, so early changes lived uncommitted on disk. It is now a git repository, hosted at
[github.com/mokaddes-arman/quarry](https://github.com/mokaddes-arman/quarry) (`main` branch).
7. **Scanned PDFs (image-only) are not OCR'd.** If a PDF has almost no selectable text the
   parser records an `ocrLikely` warning and the document is ingested with little or no
   searchable content. See [Scanned PDFs](#scanned-pdfs) below.
8. **Reranking is off by default** (`RETRIEVAL_RERANK_ENABLED=false`) and the shipped rerank
   is a lightweight heuristic, not a cross-encoder.
9. **Only two providers can answer: OpenRouter and Groq.** There is no wider fallback chain.
   If OpenRouter fails *and* Groq is not configured (or also fails), the answer fails with an
   error message instead of a spinner — the assistant bubble always shows the outcome.
10. **Known model lists can go stale.** The app retries a retired model with the next known
    model of the same provider, but a provider can retire every model the app knows about.
    Use **Settings → AI Providers** to pick a model that the provider currently lists.
11. **Deadlines are fixed values, not adaptive.** A slow provider is cut off at
    `ASK_TIMEOUT_MS` / `LLM_REQUEST_TIMEOUT_MS` rather than being retried with a longer
    budget. Raise the values in `.env` if your provider is legitimately slow.
12. **Web crawling needs outbound network access** and is HTML-oriented. A linked PDF or
    other binary file is fetched but not parsed — crawl the page that links it, or upload
    the file directly. A crawled page is stored as Markdown, so heavy navigation chrome
    and styling are dropped.
13. **The crawler is deliberately slow.** `CRAWL_CONCURRENCY=1` by default so a crawl never
    hammers a third-party site; raise it only for pages you control.

### Scanned PDFs

Image-only ("scanned") PDFs have no extractable text, so the app cannot index them. When the
average extracted text is very low (below ~20 characters per page) the parser marks the
document with an `ocrLikely` warning rather than guessing at content. Run OCR on such files
before uploading. Password-protected or encrypted PDFs are rejected with a clear error.

---

*All figures above were produced by running the commands on this machine; no test results
are fabricated. See `TODO.md` for the implementation checklist.*
