# Contributing / Katkı

Use Node.js 24.15+ and run `npm ci`, then `npm run check`.

The workbench requires first-owner setup and sign-in; [AUTH.md](docs/AUTH.md) covers the local bootstrap key, roles and team data. HTTP fixtures create isolated test identities. The browser command exercises setup, both real reduction adapters, invitations, roles and team switching in separate browser contexts. Never reuse real credentials or a developer's data directory in tests. Preserve server-side team scope on every new API route; UI restrictions alone are insufficient.

The suite now starts private native PostgreSQL 18 clusters and trusted Node child processes. Run as an ordinary OS user with loopback/process permissions; no Docker or system service is needed. Do not enable the embedded-postgres `createPostgresUser` option. Normal npm installation must allow the platform package's setup script to hydrate its own native-library symlinks. Only fresh ReproPack-owned test directories/databases may be removed.

Test files run sequentially by default: concurrent native PostgreSQL reset/crash tests and memory-hard password hashing can exhaust a small workstation and make bounded replays fail for resource contention. This schedules the test harness; it does not relax application deadlines, isolation or quotas.

Deployment changes should also pass `npm run image:build` and `npm run validate:deployment`. The gate creates uniquely owned disposable Compose projects and removes only their matching containers/volumes. `npm run release:package` checks the source distribution boundary; never package data directories or the parent checkout. `npm run test:browser` covers private workspaces, team access and the separate demo. Public tunnel sharing is an explicit operator action and is never started by CI.

Preserve the three-valued oracle. Different crashes, setup failures, network errors or unmatched responses must not become original failures or verified fixes. Use fresh temporary state for integration tests. Never point an automated test at production or at the commercial Discord bot.

Browser verification:

```sh
npx playwright install chromium
npm run test:browser
```

The smoke test starts its own loopback server and uses a temporary data directory. On Windows it can use a fresh headless Edge context if Chromium is not installed. It never attaches to your personal browser profile. `REPROPACK_BROWSER=edge` explicitly selects Edge.

Changes to capsule or report formats need versioning, validation tests and documentation in both READMEs. An incomplete run must remain distinguishable from a verified result. A new application adapter requires explicit reset/isolation semantics and real integration tests before it is enabled in the interface.

See [PostgreSQL](docs/POSTGRES.md) and [offline capture/review](docs/CAPTURE.md). Never relax a source snapshot transaction's read-only status, disable FK triggers to import a subset, pass an admin/source credential to an application worker, or accept executable paths through a capsule. Fake database tests do not replace the native integration suite.

Katkılarda `fail` / `pass` / `unresolved` ayrımını koru. Geçici test ortamları kullan; ticari Discord botuna veya üretime bağlanma. Davranış ve şema değişikliklerini Türkçe/İngilizce belgele. Yeni adaptörü gerçek entegrasyon doğrulaması tamamlanmadan çalışıyor diye sunma.

Testler gerçek, geçici PostgreSQL süreçleri başlatır. Sistem kullanıcısı/servisi kurma. Kaynak veriyi sadece salt okunur transaction ile al; FK kontrollerini kapatma, uygulama sürecine admin parolası geçirme ve kapsülden çalıştırılabilir dosya kabul etme.

For phase 3, `test/lifecycle.test.ts` kills only test-owned parent processes and checks real PostgreSQL/blocked-app cleanup. `test/sandbox.test.ts` uses a daemon protocol double and does **not** validate Linux isolation. Run `npm run validate:sandbox` for the complete image build/real-test/evidence gate, or follow [SANDBOX.md](docs/SANDBOX.md) for the manual `test:sandbox` path. Neither skips a missing engine. The real gate passed locally on Windows/WSL 2; GitHub CI remains a separate unexecuted release check. Re-run the real gate when changing sandbox behavior. Do not add Docker fallback, global prune, unowned PID termination, host mounts or source credentials to the workload. Unknown supervisor liveness must preserve the journal.

Üçüncü aşamada gerçek çökme testi ile Docker protokol testi ayrı değerlendirilir. Linux `test:sandbox` çalışmadan imaj/kota/izolasyon doğrulandı denemez. Eksik Docker sessizce atlanmaz; yerel moda düşülmez. Diğer projelerin süreçlerine ve kaynaklarına dokunma.
