# Status and roadmap / Durum ve yol haritası

Alpha 0.6.0-alpha.2 adds [retained-step evidence](DELETION-EVIDENCE.md), fresh deletion-trial references and partial evidence downloads. Existing PostgreSQL snapshot lifetime limits and external pilot gates remain unchanged. Exact validation belongs to the release attachments and Actions run.

The project is an independent ReproPack product. A general-purpose Claude Code/Codex plugin is separate and has not been specified or implemented here.

| Stage | Deliverable | State |
| --- | --- | --- |
| 1 | Ordered reduction engine, exact signatures, budgets, fresh verification | Locally validated |
| 1 | CLI, real disposable HTTP demo, React workbench, SQLite history | Locally validated, including browser/CLI |
| 1 | English/Turkish docs and meaningful automated checks | Included |
| 2 | Registered Node application adapter; real PostgreSQL snapshot/reset; relation-aware subsetting | Locally validated |
| 2 | Scoped offline HAR intake, local redaction and reviewed capsule export | Locally validated |
| 3 | Explicit Docker isolation/quotas, fail-closed policy, ownership recovery | Real Linux Docker gate passed locally on Windows/WSL 2 |
| 3 | Native workbench hard-kill and startup-crash cleanup | Locally validated on Windows |
| 4 | Secure user/team management, server-enforced roles, tenant isolation, audit trail | Locally validated in alpha 0.4 |
| 4 | Installable self-hosted release and restricted public demo | Private release and restricted HTTPS demo deployed on Render Free; temporary previews also supported |
| 5 | Optional email verification/recovery, EN/TR UI, release preflight and pinned CI | Alpha 0.6 implemented; local and remote evidence recorded separately |
| 5 | Free open-source publication and community pilot | Public GitHub source and all five remote CI jobs verified; external user pilot pending |

The current target is a free MIT-licensed open-source alpha with team security and a restricted synthetic demo. Billing and subscriptions are outside this release's scope. A production traffic recorder and hostile-code hosting service are not supplied. Public publication, remote CI and managed-demo deployment must each be verified independently; configuration alone is not evidence of deployment.

Published repository: [nexora-studio-tr/repropack](https://github.com/nexora-studio-tr/repropack). The [verified five-job remote CI run](https://github.com/nexora-studio-tr/repropack/actions/runs/40130973117) covers Windows/Linux, browsers, Docker isolation and deployment. The Windows runner uses a verified non-administrative token because PostgreSQL refuses administrative execution. Private vulnerability reporting, dependency alerts and secret push protection are enabled. The [restricted live demo](https://repropack-demo-4rq9.onrender.com/) is deployed on Render Free. Public HTTPS validation covers 12 checks, including real 16 → 5 reduction, three fresh fix trials, exports and visitor isolation. No live provider email delivery or independent user pilot is claimed.

## Stage 1 validation / Birinci aşama kaydı — 2026-10-24

- Windows, Node.js v24.15.0: `npm run check` passed (strict TypeScript, 17 tests, production build).
- `npm run demo` passed: 16 → 5 steps, 90 trials, fresh failure verification and built-in demo fix verification.
- `npm run test:browser` passed: keyboard entry, real reduction, fixed demo, JSON download, history reselection, invalid JSON, Turkish interface, and a 390px mobile layout without page overflow.
- Desktop/mobile screenshots were rendered and visually inspected. A mobile overflow caused by a visually hidden table label was corrected before the browser check passed.
- Integration tests required execution outside the restricted sandbox because it blocked even loopback connections with `EACCES`.
- GitHub Actions configuration is included; no remote CI run has been performed. PostgreSQL and container validation followed in stages 2 and 3 below; SaaS authorization and deployment remain unimplemented.

## Stage 2 / İkinci aşama — alpha 0.2

- Native PostgreSQL 18.4 was started and stopped on Windows without installing a service, system user or Docker.
- The Node/PostgreSQL request scenario reduced from 12 to 3 steps in 36 trials. Four related rows were selected from eight seeded records, one email was masked, and the registered fixed module produced the expected result.
- The test suite reached 31 passing tests, covering composite/deferred-cycle FKs, exact bigint/decimal/bytea/JSON restoration, sequence progress, source non-mutation, role restrictions, child environment filtering and cancellation cleanup in addition to the first-stage checks.
- Browser verification exercised both adapters and fixes, snapshot evidence, downloads, history, invalid input, keyboard entry and English/Turkish 390px layouts. Desktop/mobile output was visually inspected.
- CLI PostgreSQL reduction passed (12 → 3, 36 trials, registered fix verified). Synthetic HAR draft/review/replay also passed (4 → 3, 18 trials, two masked values, one discarded header, registered fix verified). Results are recorded in local artifact bundles.
- No remote GitHub Actions run or public deployment has been performed.

This phase accepts trusted factory modules and offline HAR files. It does **not** implement live production interception, automatic arbitrary-application instrumentation, durable portable database bundles or OS/container sandboxing. Source redaction remains rule-driven and needs review. Snapshots live for the current registry lifetime; after restart, a fresh reduction is required before checking a fix.

## Stage 3 / Üçüncü aşama — alpha 0.3

- Optional immutable-image Docker runtime: no external network/host mounts/privileges, read-only root, bounded tmpfs, memory/swap/CPU/PID quotas and an external workload deadline. The host checks engine support and inspects the created container; missing infrastructure cannot silently become native execution.
- Independent supervisors for native PostgreSQL and application workers. Windows hard-kill and startup-crash tests pass, including a blocked app event loop. Windows Job Object inheritance and named-pipe half-close behavior were found by these tests and corrected.
- Credential-free ownership journals, live-supervisor challenges, exact label/engine checks, stale resource recovery and conservative journal retention on uncertainty/failure. No blanket prune or guessed orphan PIDs.
- UI/report execution evidence and EN/TR setup/security docs. Snapshot inheritance/partition expansion is rejected, and bytea transport preserves lookalike objects in JSONB.
- Windows/Node.js 24.15: `npm run check` passed with 46 tests, strict TypeScript and production build. The browser gate passed real HTTP 16 → 5 / native PostgreSQL 12 → 3 reductions, both fixes, execution-boundary evidence, downloads, keyboard/history/invalid-input flows and EN/TR 390px layouts. Desktop/mobile screenshots were inspected. The refreshed preview correctly advertises Docker configuration; its EN/TR budget note and mobile layouts also passed a browser check.
- **Real Docker gate passed:** after the authorized Windows component setup and user restart, per-user Docker Desktop 4.96.3 / Engine 29.9.2 ran Linux containers with cgroup v2 on WSL 2. The official installer hash and publisher signature were verified. `npm run validate:sandbox` built the immutable runtime and passed nine real checks: failure/fix replay, host-secret exclusion, read-only root, denied external network, cgroup quotas, kernel OOM, PID enforcement, wall deadline and parent-crash cleanup. Evidence: local `artifacts/sandbox-validation/2026-10-24T11-24-20-364Z-7f5806b6/report.json`.
- Docker reduction has a bounded 300-second total budget because every trial starts a fresh PostgreSQL/container; per-workload quotas remain 512 MiB, one CPU, 64 tasks and 15 seconds. Native PostgreSQL retains 120 seconds. Budget exhaustion never produces certified output.
- Full Docker CLI validation passed: 12 → 3 steps in 36 trials, 183,880 ms of reduction, fresh failure verification and three successful registered-fix replays. The retained sequence is `apply-coupon`, `change-quantity`, `checkout`. Two deletions were inconclusive, so the result preserves the failure without claiming certified minimality. Evidence: local `artifacts/repro-1792850530711/report.json` and its exported capsule.
- The validation command records pass/blocked/fail reports without raw snapshot rows or credentials. Linux CI uses the same command and retains the report. No remote GitHub Actions run or public deployment has been performed.

## Stage 4 / Dördüncü aşama — alpha 0.4: accounts and teams

- Closed first-administrator bootstrap, invitation-only onboarding, salted scrypt passwords, opaque hashed sessions, persistent authentication throttling, bounded password-hash concurrency, CSRF and explicit HTTPS cookie/origin policy.
- Owner/admin/member/viewer roles enforced by the API, single-owner transfer with password reauthentication, session invalidation on role/password changes and cancellation when a creator loses write access.
- Team-scoped run storage and live lookups, immutable run ownership, team-specific PostgreSQL adapter/snapshot lifetimes and explicit operator team bindings for custom applications.
- Legacy local history remains quarantined until the original instance administrator imports it with a current password. Team audit events omit credentials and source payloads.
- EN/TR setup/sign-in, invitations, active-team switching, member roles, password/ownership controls and recent activity in the React workbench. See [setup and trust boundaries](AUTH.md).
- Windows/Node.js 24.15: the final `npm run check` passed strict TypeScript, all 60 tests and the production build. Real multi-team PostgreSQL tests confirmed different frozen snapshots per team and stable reuse when switching back. Test files run sequentially to avoid native-cluster/password-hashing resource contention; application budgets/quotas were preserved.
- The final `npm run test:browser` passed both gates: authenticated HTTP 16 → 5 / PostgreSQL 12 → 3 and registered fixes; setup, HttpOnly storage, invitation acceptance, viewer controls, team switching, role revocation/re-login, logout and EN/TR 390px account layouts. Desktop/mobile output was visually inspected, including the updated mobile team selector and role selection after save. Local summary: `artifacts/phase4-validation/report.json`. No remote CI or public deployment was performed.

## Stage 4 / Dördüncü aşama — alpha 0.5: installation and demo

- Non-root production image, read-only/capability-limited Compose services, health checks, persistent private volume and explicit HTTPS/local origin handling. A separate demo Compose file uses only disposable storage.
- Anonymous demo visitors have isolated, expiring workspaces, a bounded operation budget and server-enforced synthetic-only execution. Account/team operations, PostgreSQL and uploads are disabled in this mode. The demo executes the real reducer/fix; it is not a recorded playback.
- Consistent online SQLite backups, checksum/integrity validation and restore into a new directory with session/invitation revocation. Existing workspaces are retained; snapshots/source configuration are not exported.
- Source release archive with lockfile, `.gitignore`, per-file manifest and SHA-256. No parent Git repository, sibling/commercial source, private database, setup key, `.env`, dependencies or runtime output is packaged.
- Optional account-free temporary HTTPS preview in its own Docker network namespace, with no host port/data/socket attached and an independent two-hour server lifetime. Cleanup verifies engine identity, full IDs and workspace/owner labels. The Free Render Blueprint prepares a permanent demo URL once a Render account/source connection is available.
- Real Docker/Compose validation passed 24 checks, including real PostgreSQL, restart persistence, backup/restore, demo isolation and reset. Local evidence: `artifacts/deployment-validation/da48e7d9-c1df-4fc6-a7ca-95bede042a54/report.json`. External HTTPS validation passed 12 checks, including actual 16 → 5 reduction/fix and denied cross-visitor/admin access; its temporary URL/expiry is in `artifacts/public-demo-validation/report.json`.
- `npm run check` passed strict TypeScript, 68 tests and production build. All three browser gates passed: private reductions/fixes, account/team management, and isolated no-signup demo visitors with real reduction/fix/export, logout and EN/TR 390px layouts. Remote GitHub Actions has not run; the Render Blueprint has not been deployed. The source distribution keeps `package.json` private and includes `.gitignore` for safe installation before a later GitHub publication.

Özel kurulum paketi ve örnek verili geçici HTTPS paylaşımı eklendi. Kalıcı Render yayını için hesap/depo bağlantısı gerekir; kalıcı yönetilen servis yayına alınmadı. Canlı üretim kaydı ve taşınabilir kalıcı veritabanı paketleri ayrıca ele alınmalıdır. Kurulum için [DEPLOY.md](DEPLOY.md) belgesine bak.

Product validation should target developers who repeatedly spend time reconstructing state-dependent bugs. Compare time to a reproducible case and correctness of the retained failure against their current workflow. Star count and willingness to pay are not validated by a successful demo.
