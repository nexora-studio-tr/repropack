# ReproPack

**[0.6.0-alpha.2](https://github.com/nexora-studio-tr/repropack/releases/tag/v0.6.0-alpha.2)** adds [retained-step deletion evidence](docs/DELETION-EVIDENCE.md), linked fresh trials and explicit partial reports. No extra replays are added.

**Less noise. Same failure.** Reduce a reproducible HTTP scenario while preserving its exact failure signature.

[![CI](https://github.com/nexora-studio-tr/repropack/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nexora-studio-tr/repropack/actions/workflows/ci.yml)

[Türkçe](README.tr.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md) · [Roadmap / status](docs/ROADMAP.md)

Free, MIT-licensed open source. **Alpha: install locally with trusted application code.** The public demo is a disposable synthetic example. No billing, subscriptions or automatic telemetry.

**[Try the live demo →](https://repropack-demo-4rq9.onrender.com/)** · No sign-up · Synthetic data only.

The free instance can sleep when idle, so the first load may take about a minute. Demo workspaces expire after 60 minutes and reset on service restarts.

## Account recovery and release controls — alpha 0.6

Optional SMTP email verification and password recovery use expiring, hashed one-use links, bounded delivery, account isolation and full session revocation. English/Turkish screens and HTTP/SMTP/browser checks cover the complete flow. See [configuration and guarantees](docs/ACCOUNT-SECURITY.md).

`npm run release:check` validates the source allowlist, package versions, common credential patterns and pinned CI actions. Tag releases run the full CI gates before publishing a checksum-verified source archive. Community [pilot instructions](docs/PILOT.md) and issue forms collect voluntary feedback; no independent user pilot or security audit is claimed.

[Deploy a free disposable demo](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fnexora-studio-tr%2Frepropack) · [Private installation](docs/DEPLOY.md)

## Installation and shareable demo — alpha 0.5

`docker compose up --build --detach --wait` starts the private workbench with persistent storage. `docker compose -f compose.demo.yaml up --build --detach --wait` opens a separate disposable demo on port 4320; source users can use `npm run demo:web`. Visitors try the actual reducer without signing up, with their own limited, temporary sample workspace. A checksum-verified source archive, backup/restore commands, a Free Render Blueprint and an optional temporary HTTPS preview are included. See [installation and demo / Türkçe](docs/DEPLOY.md).

## Accounts and teams — alpha 0.4

The private workbench requires sign-in. First setup uses the private `.repropack/bootstrap-token` file; choose your own administrator account and password. Teams have owner/admin/member/viewer roles, expiring one-use invitations, server-side sessions, CSRF checks and scoped activity. Every run API and PostgreSQL snapshot is scoped to the active team. Older local history remains private until explicitly imported. See [setup, permissions and security limits / Türkçe](docs/AUTH.md). The default private listener stays local; public demos use the separate restricted mode.

## Isolation and recovery — alpha 0.3

An explicit Docker execution mode, hard workload quotas, ownership journals and independent cleanup supervisors are included. Native Windows crash recovery and the **real Linux Docker gate on Windows/WSL 2** pass, including kernel OOM/PID limits, external-network exclusion and parent-crash cleanup. Default native execution still requires trusted code. See [setup, limits and validation evidence / Türkçe](docs/SANDBOX.md). GitHub Actions validates Windows/Linux, browser flows, Docker isolation and deployment. Permanent managed hosting remains optional; alpha 0.5 includes a separate disposable public preview.

## PostgreSQL applications — alpha 0.2

Select **Node.js + PostgreSQL** in the interface, or run:

```sh
npm run demo:postgres
node src/cli.ts reduce examples/postgres-cart.json
```

Operator-registered Node.js applications now run against real, disposable PostgreSQL 18 databases. Related rows are selected in a read-only source transaction, configured non-key TEXT fields are masked locally, and an owned template database is frozen. Every replay gets a clone, a fresh Node process, and a database-specific restricted login. No Docker, system service or global system user is installed. Native binaries are pinned by the lockfile; normal npm installation runs their required package setup.

The PostgreSQL example selects four of eight source records and masks one email. Its 12-step flow reduces to three steps because the snapshot already contains the selected cart and item. The registered fixed module is checked against the same frozen snapshot.

See [PostgreSQL setup / Türkçe](docs/POSTGRES.md) and [reviewed offline HAR import / Türkçe](docs/CAPTURE.md). Capsules hold logical application/snapshot IDs, never executable paths, SQL or credentials. Reports contain hashes/counts; database rows are not bundled.

## What works today

This is a **local alpha with authenticated team workspaces**. The original HTTP cart fixture remains available alongside the PostgreSQL adapter. Its intentional discount bug and fresh empty state provide a quick engine demonstration. The reducer removes irrelevant requests, verifies the retained failure again, and exports a replayable JSON capsule with trial evidence.

The included 16-step scenario reduces to five steps: create cart → add coffee → apply coupon → change quantity → checkout. The original returns $100 while retaining SAVE20; the included patched fixture returns the expected $80.

- Complement-based delta debugging with ordered steps and an anchored oracle.
- Explicit `fail`, `pass`, and `unresolved` results; a different error cannot impersonate the original failure.
- Three baseline trials, repeated candidate trials, fresh final verification, cancellation, and bounded work.
- Conservative minimality reporting: invalid deletions do not prove a step is necessary.
- CLI bundles, a React workbench in English/Turkish, local SQLite history, and demo fix verification.

## Run

Requires **Node.js 24.15+** and npm. No AI API key or database service is required.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:4317**, complete first-owner setup and sign in. Choose an adapter, click **Reduce scenario**, inspect the evidence and export the capsule. The HTTP fix check runs the included patched fixture; the PostgreSQL fix check runs the operator-registered `fixedModule`. Neither edits your code.

```sh
npm run demo
node src/cli.ts reduce examples/cart-discount.json --out artifacts/my-repro
npm run check
```

`npm run demo` writes `report.json`, `capsule.json`, and `REPRODUCE.md` under a new `artifacts/` directory. Existing files are never overwritten. Incomplete reductions emit a report but no supposedly verified capsule. The CLI exits with code 2 for incomplete or inconclusive work.

The server binds to loopback. Set `REPROPACK_PORT` and optionally `REPROPACK_DATA_DIR` in your shell to change its port/data directory. `.env.example` documents these settings; `.env` files are not automatically loaded.

## Capsule contract

See [the v1 HTTP example](examples/cart-discount.json) and [the v2 PostgreSQL example](examples/postgres-cart.json). V2 adds logical `application` and `snapshot` IDs. `oracle.failure` and `oracle.success` map RFC 6901 JSON Pointers to exact JSON values. Both require the declared HTTP status. At least one shared pointer must disagree between the signatures.

```json
{
  "stepId": "checkout",
  "status": 200,
  "failure": { "/coupon": "SAVE20", "/total": 100 },
  "success": { "/coupon": "SAVE20", "/total": 80 }
}
```

`fail` means the **same bug** occurred; it is a useful reduction outcome. `pass` means the declared expected result occurred. Setup failures, network errors, unstable outcomes, and other responses are `unresolved`. The oracle step must be last and is never deleted.

`finalVerified` only establishes that the retained scenario reproduced the signature in fresh trials. `oneMinimal` additionally requires all single-step deletions to produce a stable `pass`. Neither establishes a globally smallest reproduction, correctness of unrelated code, or absence of flaky behavior in future runs. The demo intentionally reports inconclusive minimality when removing prerequisites makes a request sequence invalid.

## Tests

`npm run check` runs strict TypeScript checking, Node tests, and the production interface build. Tests cover real loopback HTTP replays, failure preservation, unstable baselines, late instability, work limits, cancellation, input validation, same-origin writes, DNS rebinding protection, persistence, and crash recovery.

The HTTP tests need permission to open/connect to temporary loopback ports. Restricted execution sandboxes can block them with `EACCES`; do not mistake that for successful integration validation.

Browser smoke tests are available with `npm run test:browser` after installing a Playwright browser. See [contributing](CONTRIBUTING.md).

## Current boundaries

**Current boundaries:** request intake is offline HAR import, not a live production traffic recorder. Native factories and schema/seed SQL must be trusted. Docker mode is explicit, fails closed and is validated on Windows/WSL 2. Redaction needs configured rules and review, and does not guarantee anonymization. Snapshots are ephemeral; capsules require matching application/snapshot inputs. Team authorization is included in alpha 0.4. SMTP account recovery is included in alpha 0.6. Agent integrations and MFA remain future work; consult the roadmap for publication and hosting status. The default listener stays local.

The proposed Claude Code/Codex developer plugin is a **separate product**. No plugin manifest, hook, or agent workflow is bundled here. Commercial Discord bot sources and private data are outside this project.

## License

MIT. See [LICENSE](LICENSE).
