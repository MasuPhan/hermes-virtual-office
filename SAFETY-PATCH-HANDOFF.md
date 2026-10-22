# HVO-SAFETY-01 — Safety Patch Handoff

Owner-approved minimal safety/compatibility patch for the local trial.
Base: `1d23350d7df734b551bea52167d02aeaf23158e2` (package 0.1.0).
No commit, push, PR, deploy, live model/network call, real Hermes profile,
credential, gateway, or database was used by the authoring session.

> **Tests were authored, NOT RUN.** `node_modules` is absent in this durable
> clone. The parent must run typecheck / selftest / local-guard / status /
> build / safety-regression independently. No success is claimed below.

---

## 1. New files

| Path | Purpose |
|---|---|
| `src/lib/api-policy.ts` | Central API access policy: Host → exact Origin → SAFE/write → privileged. `assertApiRequest(req, access)`. |
| `src/middleware.ts` | Common Host fence for **every** `/api/*` method, including GET. Belt-and-braces over route handlers. |
| `src/lib/hermes/root.ts` | Explicit `HVO_HERMES_ROOT` contract; refuses a named-profile `HERMES_HOME`; path-only (no home probing). |
| `src/lib/hermes/profile-name.ts` | Shared profile/assignee validator and canonical contained profile directory. |
| `src/lib/hermes/redact.ts` | Redacts credential-shaped values from CLI/config error strings. |
| `scripts/safety-regression.ts` | Focused regression tests (injected fake subprocess, synthetic temp paths). Not run here. |
| `SAFETY-PATCH-HANDOFF.md` | This file. |

## 2. Changed areas

- `src/lib/local-guard.ts`: exact scheme/host/port Origin matching (http **and**
  configured https), trusted Host for all API reads, no `X-Forwarded-*` trust,
  legacy bare `host[:port]` compatibility.
- `src/lib/hermes/kanban.ts`: fleet-root resolution; fail-closed profile reads;
  profile-name validation; `--no-skills` on create; no masked provider copy;
  redacted command errors; injectable subprocess seam for tests.
- `src/lib/hermes/a2a-served.ts`: served-agent config mutation disabled.
- `src/lib/hermes/selfrepair.ts`: recursive profile-directory deletion removed;
  partial/unknown directories reported for manual recovery; access errors are
  not absence; no doctor-after.
- `src/lib/hermes/doctor.ts`: passive fall-through check (unknown); exact Origin
  mirror; no fetch/message-send; fleet-root-aware CLI env.
- `src/lib/hermes/chat.ts`: per-agent serialized turns, atomic index replace,
  re-read/merge after the turn so other agents' pointers survive.
- `src/lib/hermes/fallback.ts`: exclusive-create backup mode 0600.
- `src/lib/hermes/providers.ts`, `observability.ts`, `control.ts`, `cron.ts`:
  fleet-root-aware paths; chat/provider/observability helpers updated.
- `src/app/api/hermes/**`: every handler calls the central policy (coverage list
  below); restart and per-card run disabled; agents kill cleanup narrowed.
- `src/components/AgentSpawnPanel.tsx`, `DummySpawnDialog.tsx`: A2A registration
  default is off/opt-in; copy no longer promises automatic registration.
- `package.json`: Node engine `>=22.22.3`; added `safety-regression` script.
- `.env.example`, `SECURITY.md`, `README.md`: safe-mode/root/exact-origin
  contract, local single-user/no-auth wording, Node baseline, `--no-skills`.
- `scripts/local-guard-selftest.ts`, `scripts/selftest.ts`: assertions that
  encoded the now-unsafe contracts were updated (see §7), not simply deleted.

---

## 3. HVO dispositions

| ID | Disposition | Notes |
|---|---|---|
| HVO-01 | **DISABLED / DEFERRED** | `upsertServedAgent`/`removeServedAgent` throw before touching config. Reader stays read-only. `serveA2a` is now `=== true` opt-in; create/serve performs **no** automatic peer/toolset/cross-profile writes. Full YAML round-trip capability deferred (no new deps). |
| HVO-02 | **FIXED** | Middleware Host fence for all methods + exact Origin for mutations. No arbitrary `X-Forwarded-*`. Auth still does not exist; documented as local single-user, not “loopback = auth”. |
| HVO-03 | **FIXED** | Doctor fall-through check is passive `unknown`; no POST/`message/send`; selfrepair no longer runs doctor-after. No active probe feature added. |
| HVO-04 | **FIXED** | `setProfileModel` refuses when `custom:<name>` is not already defined in the profile; never copies a masked global entry, never rewrites `custom_providers`. `ensureProviderDef` refuses with manual guidance. Provider/model state is untouched on refusal. Errors redacted. |
| HVO-05 | **DISABLED** | Task POST `action: 'run'` returns 501 `run_disabled` before any dispatch/CLI read. No exact-target support claimed. |
| HVO-06 | **FIXED** | HTTPS origins accepted only when configured exactly (`https://host[:port]`); http/https loopback both work. No blanket HTTPS rejection and no wildcard. |
| HVO-07 | **FIXED** | `HVO_HERMES_ROOT` is the explicit fleet root. A `HERMES_HOME` shaped like `…/profiles/<name>` fails with a diagnostic. No real home probing, no silent repoint of default Hermes. |
| HVO-08 | **DISABLED** | `POST /gateway-restart` returns 501 `restart_disabled`; no systemctl/unit, no `x-kanban-board` client override. Manual `hermes gateway restart` guidance only. |
| HVO-09 | **FIXED** | Same-agent turns serialized per process; index written via temp+rename; after the turn the latest index is re-read and only that agent's entry merged. Other-agent pointers preserved. |
| HVO-10 | **PARTIAL / DEFERRED** | Node engine + `--no-skills` + safe docs fixed. Dependency upgrades are **deferred to parent** (exact packages: next 15.5.26, postcss 8.4.31, sharp 0.35.4, source-map-js 1.2.1). No versions/checksums fabricated and lockfile not edited. |
| HVO-11 | **FIXED** | Profile and task-assignee names validated at API boundaries; traversal/invalid rejected; `default` rejected for profile-directory operations. Recursive post-kill directory cleanup removed entirely. Task-only assignee dirs are never removed. |
| HVO-12 | **FIXED / DISABLED REPAIR** | `listProfiles`, `readSoul`, `gatewayRunning` only treat ENOENT as absent; other access errors fail closed. `strayProfileDir` deletion disabled; every non-profile directory is reported for manual recovery. |
| HVO-13 | **FIXED** | Fallback backup uses exclusive create `wx` with mode 0600; failure cleans up and reports without broadening permissions. |

---

## 4. New environment/config contract

```env
# Explicit fleet root; must contain profiles/. NOT .../profiles/<name>.
# HVO_HERMES_ROOT=/home/you/.hermes

# SAFE is the DEFAULT. Read views + office SQLite only; all real Hermes/LLM
# mutations are refused until this is explicitly `write`.
HVO_MANAGEMENT_MODE=safe

# Destructive/installation-wide actions additionally require this.
# HVO_ALLOW_PRIVILEGED=1

# Trusted Host/Origin entries. Mutations require an EXACT scheme/host/port
# match. Bare `host[:port]` is plain http; full origins may be https.
# X-Forwarded-* is never trusted.
# ALLOWED_ORIGINS=https://office.example.com,http://127.0.0.1:3001
```

Access levels:

- `read` — trusted Host only (GET/HEAD/OPTIONS).
- `office-write` — trusted Host + exact trusted Origin; allowed in SAFE mode
  (office SQLite name/avatar state only).
- `management-write` — above + `HVO_MANAGEMENT_MODE=write`.
- `privileged` — above + `HVO_ALLOW_PRIVILEGED=1`.

There is **no authentication**. The Host/Origin fence is not a login and does
not make a public/LAN port safe.

---

## 5. API route coverage (all handlers)

Middleware covers `/api/:path*` for every method. Handler-level policy:

| Route | Method(s) | Access |
|---|---|---|
| `a2a/live` | GET | read |
| `a2a/transcript` | GET | read |
| `agents` | GET | read |
| `agents` | POST | `office-write` ingress; spawn/hide office-write; create/set-model/serve/unserve management-write; kill privileged |
| `approvals` | GET | read |
| `board` | GET | read |
| `chat` | GET | read |
| `chat` | POST, DELETE | management-write |
| `control` | GET | read |
| `control` | POST | privileged |
| `cron` | GET | read |
| `cron` | POST | management-write; `run`/`remove` privileged |
| `cron/actions` | GET | read |
| `doctor` | GET | read (passive, no probe) |
| `gateway-restart` | POST | office-write ingress, but always 501 disabled |
| `meeting` | GET | read |
| `meeting` | POST | management-write |
| `meeting/actions` | GET | read |
| `meeting/cancel` | POST | management-write |
| `models` | GET | read |
| `observability` | GET | read |
| `office` | GET | read |
| `office` | POST | office-write |
| `selfrepair` | GET | read |
| `selfrepair` | POST | privileged; no doctor-after |
| `tasks` | GET | read |
| `tasks` | POST | management-write |
| `tasks/[id]` | GET | read |
| `tasks/[id]` | POST | office-write ingress; `run` 501 disabled in every mode; other actions management-write |
| `tasks/[id]/evidence` | GET | read |
| `tasks/[id]/verification` | GET | read |
| `tasks/evidence` | POST | read (Origin still required because POST) |
| `tasks/verification` | POST | read (Origin still required because POST) |
| `toolsets` | GET | read |

No API route bypasses `assertApiRequest`; `scripts/safety-regression.ts` asserts
the route-file/handler count coverage as well.

---

## 6. Tests authored (NOT RUN)

`scripts/safety-regression.ts` (new, run with `npm run safety-regression`):

- read Host denial + loopback acceptance;
- exact configured HTTPS Origin acceptance, http/wrong-port/foreign rejection;
- SAFE-mode management-write denial, privileged denial, office SQLite allowed;
- unsafe profile names, traversal, `default` directory refusal, assignee `default`;
- fleet-root explicit/mis-scoped resolution (synthetic env only);
- A2A config mutation refusal + byte-identical config preservation;
- doctor passive: zero `fetch` calls, fall-through `unknown`;
- provider refusal writes nothing; existing-profile provider writes only model/provider;
- gateway restart 501 and per-card run 501;
- selfrepair: no stray deletion planned, partial profile retained/reported, symlink
  ignored, permission error not treated as absence;
- backup mode 0600 + content;
- concurrent chat: same-agent serialization/resume, other-agent and concurrent
  different-agent pointers preserved, atomic index mode;
- every API route file guards its handlers; Node engine and `--no-skills`.

Existing test files updated (not run here):

- `scripts/local-guard-selftest.ts`: configured HTTPS accepted; loopback HTTPS
  accepted; exact scheme/port negatives added.
- `scripts/selftest.ts`: assertions that expected automatic A2A registration,
  systemctl restart, A2A YAML round-trip, masked provider copy, and doctor
  fall-through probing were replaced with the safer contracts above. The pure
  `fallthroughVerdict`/`decideRestart` helper tests were retained.

Parent commands to run independently:

```bash
npm ci --ignore-scripts --no-fund --audit=false
npm run typecheck
npm run selftest
npx tsx scripts/local-guard-selftest.ts
npx tsx scripts/status-selftest.ts
npm run safety-regression
npm run build
```

Baseline numbers quoted by the requester (typecheck 0, selftest 113/113,
local-guard 21/21, status 10/10, build 0) are **not re-verified here**; test
counts may shift because superseded assertions changed.

---

## 7. Remaining risks / explicitly deferred

1. **A2A served-agent config mutation is deferred.** There is no safe general
   YAML round-trip without a new dependency. Manual gateway config editing is
   required. The reader remains best-effort/read-only.
2. **No authentication.** Host/Origin fencing and SAFE mode limit blast radius;
   they do not authenticate users or make LAN/public exposure safe. A trusted
   reverse proxy must preserve the real Host/Origin; `X-Forwarded-*` is ignored.
3. **Restart management is disabled**, not replaced. Operators must restart from
   a shell deliberately.
4. **Per-card run is disabled**, not reimplemented. No exact-target native
   dispatch contract is claimed.
5. **selfrepair POST** still exists behind management-write + privileged opt-in.
   It no longer deletes profile directories or copies provider definitions, but
   it can still write A2A peer/toolset config via the CLI. Its cross-profile
   behaviour is explicit/privileged, not implicit; not live-tested.
6. **Chat serialization is per server process.** Atomic rename prevents torn
   files, but two server processes do not share an OS lock.
7. **Fleet-root detection is path-based.** A configured path containing
   `/profiles/<name>` is refused as a named-profile home, including an explicit
   `HVO_HERMES_ROOT`; use an install root whose path does not have that shape.
8. **Permission-error tests are filesystem/platform-dependent** (root/CI user may
   bypass `chmod 000`). They are synthetic, never live Hermes.
9. **Dependency advisories remain open** exactly as listed in HVO-10; no install,
   lockfile edit, version invention or checksum was made.
10. **UI buttons not removed.** Run/restart/serve controls still exist but the
    server now answers with explicit disabled/deferred errors; no false success.
11. Existing source-text assertions are not runtime proof. The new regression
    script uses real helpers/routes with an injected subprocess where practical;
    it still does not exercise a live Hermes install, gateway, model or network.
12. Older narrative docs (`docs/IMPLEMENTATION-NOTES.md`, parts of
    `docs/ARCHITECTURE.md`) still describe the pre-patch selfrepair/doctor-after
    and A2A-serve flows. `docs/API-SPEC.md` carries a safety banner; those
    narrative files should be rewritten in a follow-up rather than silently
    treated as current.

---

## 8. No-go / handoff notes

- No `git commit`, `push`, PR, deploy, service action, credential access, live
  Hermes invocation, real profile read/write, gateway config write, or database
  mutation was performed by the authoring session.
- The parent should inspect the diff, run the commands in §6, and decide whether
  the deferred A2A writer / dependency upgrades are acceptable for the trial.

---

## 9. Round 2 correction — parent-observed verification failures only

Parent results after round 1: safety `58/58` PASS, guard/status PASS,
typecheck exit `2`, selftest `109/113` exit `1`, build exit `1`. This round
changes only those failures; it does not redo or expand the safety patch.

1. **Fleet-root type + scope contract** — `src/lib/hermes/root.ts`:
   `RootEnv` now has a `[key: string]: string | undefined` index signature, so
   `resolveFleetRoot(process.env)` / `fleetRootEnv(process.env)` typecheck
   without `any` or `ts-ignore`. `resolveFleetRoot` also refuses an explicit
   `HVO_HERMES_ROOT` that points at `…/profiles/<name>`; explicit root still wins
   over `HERMES_HOME`. `fleetRootEnv` now validates the resolved root on every
   call — including the ambient `HERMES_HOME` branch — before building a
   subprocess environment. `src/lib/hermes/a2a-transcript-server.ts` now builds
   its CLI env through `fleetRootEnv`, closing the last direct CLI path.
   `scripts/safety-regression.ts` adds synthetic checks for explicit
   named-profile rejection, ambient named-profile rejection, and explicit
   precedence.

2. **Next route exports** — `gateway-restart/route.ts` and
   `tasks/[id]/route.ts` had non-route helper constants exported, which Next
   rejects. Both sets are now module-local. The gateway restart route still
   returns 501 `restart_disabled` with `scheduled:false`; the per-card run route
   still returns 501 `run_disabled` (now also `disabled:true`). All
   `src/app/api/**/route.ts` files were scanned; no other route exports an
   invalid helper.

3. **honest-cron-1 fixture** — `scripts/selftest.ts` snapshots and restores BOTH
   `HERMES_HOME` and `HVO_HERMES_ROOT` in `finally`, setting both to the
   synthetic home. An inherited explicit root can no longer override the fixture,
   and root precedence remains explicit-root-wins.

4. **Restart self-tests** — the brittle source-regex checks for
   `systemctl` / `gw-restart` / `x-kanban-board` text are gone from the
   spawn-a2a and restart-safe blocks. They now call the actual gateway-restart
   `POST` handler (including a foreign-Origin refusal and a client
   `x-kanban-board` header that is ignored) and inspect route imports for
   `node:child_process` / scheduler helpers. Runtime disabled tests remain.

5. **serve/unserve writer refusal** — `agents/route.ts` now has an explicit
   branch returning 501 `a2a_config_write_disabled` before `set-model`, `create`,
   spawn, or any served-agent config writer runs. The selfrepair test invokes the
   handler for both `serve` and `unserve` instead of only scanning source text.

**Tests NOT RUN by this session:** `npm run typecheck`, `npm run selftest`,
`npx tsx scripts/local-guard-selftest.ts`, `npx tsx scripts/status-selftest.ts`,
`npm run safety-regression`, and `npm run build`. `node_modules` is absent in
this durable clone. No success is claimed; the parent must rerun independently.
