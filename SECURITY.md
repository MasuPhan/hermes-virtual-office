# Security Policy

## Reporting a vulnerability

Report security issues privately — please do not open a public issue for them.

Include what you can: the affected version or commit, a description of the
issue, and a minimal way to reproduce it. You will get an acknowledgement, and
an update if the report is accepted.

## What this project does with your credentials

This is worth stating plainly, because the app sits between a browser and a
machine that runs autonomous agents.

**The office does not hold or store any credential.** There is no database, no
session store, no user accounts. It reads and writes through the Hermes CLI on
the host it runs on, using whatever permissions that host already has.

Specifically:

- **Hermes keys live in `.env.local`** (gitignored, never committed) and are read
  server-side only. The meeting engine uses them to reach the configured model
  provider. They are never sent to the browser.
- **No credential is ever rendered into the page.** The office shows agent names,
  task titles, cron schedules and logs. If your workflow puts a secret in a task
  title or a log line, it will be displayed — that is the same data the CLI shows.
- **The browser never talks to the Hermes CLI directly.** All calls go through the
  Next.js route handlers in `src/app/api/hermes/`, which strip the agent-session
  markers before invoking the CLI and return only the fields the UI needs.

## Deploying it

**The office has no authentication.** Anyone who can reach the port can read the
board. This is a local single-user control surface, not a multi-user service.
Binding to loopback is **not** authentication: any local process that can reach
the port can supply trusted HTTP headers. Do not expose it on a LAN or the public
internet without a real authentication layer in front of it.

The patch in this tree adds two defence-in-depth fences, not login:

- A common trusted-Host ingress check for **every** API method (including GET),
  and exact trusted-Origin checks for mutations. `X-Forwarded-*` headers are
  never trusted.
- A default **SAFE/read-only management mode** (`HVO_MANAGEMENT_MODE=safe`).
  Read views and the office's own SQLite name/avatar state work; real Hermes
  mutations, chat/meeting agent calls and task/board writes are refused until the
  operator explicitly sets `HVO_MANAGEMENT_MODE=write`. Destructive actions
  (kill, selfrepair, restart, pause-all, fallback chain) require the additional
  explicit `HVO_ALLOW_PRIVILEGED=1`.

Even in write mode, this is still a single-user tool with no user accounts. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Scope

In scope:

- Anything that leaks a secret to the browser or into a log
- Command injection through any field the UI sends to the Hermes CLI
- Path traversal in the meeting archive reader, which reads files under `DATA_DIR`

Out of scope:

- The absence of authentication (documented and intentional — see above)
- Vulnerabilities in the Hermes CLI, the model provider, or three.js
- Anything requiring an attacker to already have shell access to the host
