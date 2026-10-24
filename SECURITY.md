# Security / Güvenlik

Alpha 0.6 adds optional SMTP verification and recovery; see [setup and guarantees](docs/ACCOUNT-SECURITY.md). SMTP credentials stay with the operator. Restore revokes account links. The restricted public demo blocks these account endpoints. Automated tests and source pattern checks are not an independent security audit.

This alpha is an **authenticated workbench with team-scoped data**, plus a separate restricted synthetic-only demo. The private listener defaults to loopback; container ports also bind to host loopback by default. Account/session behavior, roles and migration are documented in [AUTH.md](docs/AUTH.md); container installation, backups and public demo boundaries are in [DEPLOY.md](docs/DEPLOY.md). A temporary public preview is supported. A permanent managed deployment and an independent security audit are not supplied.

## Implemented boundaries

- Public demo mode uses a fresh disposable database and refuses private database reuse, custom applications and bootstrap credentials. Its server accepts only the bundled HTTP scenario, blocks account/team administration and PostgreSQL, limits admissions/work, and expires isolated visitor sessions. The optional public preview has no host port, folder or Docker socket attached; cleanup checks exact engine/owner/container identity.
- Private Compose storage survives restart. Online SQLite backups have checksums; restore only creates a new directory, preserves the existing workspace, and revokes restored sessions/invitations. Source archives use an explicit file selection, reject symlinks and include `.gitignore`; runtime/private directories are excluded.

- The server binds to `127.0.0.1`; Host headers are checked to limit DNS rebinding.
- Every workbench API requires a current server-side session and team membership. Authenticated writes require the matching Origin, custom header and session-bound CSRF value. Cross-origin requests are rejected; CORS is not enabled.
- Passwords use bounded async scrypt; random session/invitation secrets are stored only as digests. Bootstrap is closed after one administrator. Invitations expire and are revocable/single-use. Server-side roles protect run creation, evidence, cancellation, fix checks, membership and audit access. Role changes revoke sessions; lost write access cancels the actor's work.
- Runs are scoped in storage and live lookup, and PostgreSQL adapter registries/snapshots are separate per team. Custom applications require an explicit operator team binding. Legacy runs remain unassigned until a password-confirmed import by the original instance administrator.
- Capsules can select the HTTP demo or an operator-registered Node/PostgreSQL application by logical IDs. They cannot register module paths, SQL, credentials or arbitrary remote targets. A trusted configuration file is selected outside the API.
- Application workers receive a per-trial database login with DML/sequence privileges, no superuser/CREATEDB/CREATEROLE/schema creation, and no access to other databases. Selected environment variables are forwarded; source/admin credentials are not.
- Schema/seed SQL runs through a separate non-superuser owner login in owned databases. Source capture uses a repeatable-read read-only transaction. Required parents are allowlisted and referential constraints are preserved on restore.
- Configured non-key TEXT columns are masked before snapshot materialization. Offline HAR import discards headers/response bodies, masks credential-like values and requires review of the exact semantic capsule hash before generating a reviewed capsule.
- Request and capsule sizes, step counts, budgets and queue size are bounded.
- React escapes displayed content. The server sends a restrictive CSP, disables framing, and prevents MIME sniffing.
- SQLite writes are parameterized. Its files remain local. No telemetry, cloud uploads or AI calls are made by the engine.
- An interrupted run is reported as interrupted on restart; it is not automatically replayed.
- Independent cleanup supervisors survive a workbench crash, including Windows Job Object detachment. Real native startup/crash tests cover PostgreSQL and a blocked app. Docker journals bind cleanup to an exact workspace, random owner and engine ID; uncertain liveness or failed cleanup retains the journal.
- Explicit Docker mode requires a local immutable image and Linux cgroup v2 limits/default seccomp. Its command policy removes external networking, host mounts, capabilities and writable root, and inspects restrictions before start. No runtime/native fallback is allowed. Real OOM/PID/deadline, network/filesystem and crash tests passed on Windows/WSL 2: see [validation evidence](docs/SANDBOX.md).

These controls do not defend against malware or another process already running as your user. The HTTP demo shares the workbench process. Default native workers retain your OS privileges and are for trusted code; they have a watchdog but no hard host memory/CPU quotas. Docker is an explicit alternative validated against a real Linux engine on Windows/WSL 2. Remote CI has not run. Configuration/source capture and schema/seed SQL remain trusted host operations in either mode.

The whole Docker trial, including its temporary PostgreSQL, shares a container user. It cannot claim tamper-proof execution evidence against its own malicious application. No other trial or host/source credential is included. Docker uses a shared Linux kernel; no VM boundary or public hostile-code service is provided. If both supervisor and workbench die, Docker recovery occurs at the next sandbox initialization; the absent supervisor cannot enforce its deadline meanwhile. Native simultaneous-supervisor loss leaves remnants for inspection instead of guessing at recycled PIDs. Recovery never performs a global prune.

There is no live production traffic recorder. HAR and configured column masking do not guarantee complete anonymization: URL path segments, unknown fields, free text, unmasked database columns and user-authored capsules may still contain private data. Raw database rows and credentials are not included in current capsule/report exports. The review receipt is a local workflow record, not an identity or authorization credential.

## Reporting

Permanent managed hosting and a private vulnerability-reporting channel are not configured yet. Before publication, enable the repository's private security reporting and document a monitored contact. Avoid including credentials or production payloads in a public issue.

Giriş, sunucu oturumu, CSRF, ekip rolleri, veri/snapshot ayrımı ve ekip denetim izi eklendi; ayrıntılar [AUTH.md](docs/AUTH.md) belgesinde. Varsayılan yerel çalıştırma güvenilir kod içindir; ayrı süreç OS sandbox değildir. Docker seçimi açık ve imaj kimliği sabittir; altyapı yoksa işlem reddedilir. Windows çökme temizliği ve Windows/WSL 2 üzerinde gerçek Linux izolasyon/kota testleri geçti. Şema/seed ve kaynak yapılandırması her iki modda güvenilir olmalıdır. Maskeleme tam anonimlik garantilemez. Kamuya açık dağıtım, bağımsız güvenlik denetimi ve uzak CI henüz yapılmadı.
