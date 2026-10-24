# Architecture / Mimari

## Current execution path

```text
React workbench ── session/team policy ── local queue ─┐
                                         ├─ reducer ── demo HTTP executor
CLI ─────────────────────────────────────┘               │
                                              fresh state for each trial
```

The engine has no model-provider dependency and no agent integration. The `Executor` interface accepts an ordered candidate and an abort signal, and returns a three-valued result. The HTTP demo creates a fresh loopback fixture. Native PostgreSQL execution clones a frozen owned database and starts a trusted app. Optional Docker execution streams the selected masked snapshot/schema to a fresh network-disabled container that creates its own PostgreSQL/app for the candidate. Both close resources in `finally` and have independent supervisors. [Isolation design and validation gate](SANDBOX.md).

Node.js 24 runs erasable TypeScript directly. TypeScript checks the backend, engine and React interface before the esbuild production bundle. The server and CLI use Node built-ins. SQLite stores run history; startup marks unfinished runs interrupted instead of replaying them.

The HTTP workbench authenticates an opaque cookie against hashed server-side sessions, checks a session-bound CSRF value for writes, and reads current team membership for authorization. Active team selection lives in the session. SQLite run queries and live-job lookups always carry that team ID; their adapter registries, native clusters and frozen snapshots are separate. Custom operator applications are bound to one team, and legacy unassigned history is quarantined until explicitly imported. Account/team changes and administrative/run activity use scoped audit records. [Account and permission model](AUTH.md).

## Reduction contract

1. Reproduce the baseline three times. A disagreement or non-failure stops reduction.
2. Partition the ordered input and test complements. Never delete the anchored oracle.
3. Accept a smaller candidate only after two matching failure trials. Cache stable outcomes by ordered step IDs inside this invocation.
4. Reproduce the reduced scenario in three fresh trials, bypassing the cache.
5. Check every single-step deletion twice. A reproducible failure invalidates the candidate's minimality claim. Any uncertain deletion prevents certification of 1-minimality.

This is complement-based delta debugging with conservative certification. It does not promise a global minimum, and repeated testing does not mathematically eliminate nondeterminism. Work has trial and wall-time budgets. An executor must honor its abort signal. Executable code is accepted only through an operator-selected trusted application config, never a capsule/API-supplied path.

## Boundaries / Sınırlar

The HTTP fixture is disposable state. Native PostgreSQL processes/roles require trusted host code. Explicit Docker mode pins its image and engine, checks kernel-limit support and inspects restrictions before starting. It has no automatic native fallback. The application and temporary PostgreSQL are one disposable workload; its verdict is not an adversarial attestation. Real Linux container validation passed locally on Windows/WSL 2; remote CI has not run. No executable path, image or command is accepted in capsules. Source/schema configuration remains trusted, and source capture remains read-only. See [the PostgreSQL contract](POSTGRES.md) and [sandbox trust/cleanup model](SANDBOX.md).

Offline HAR intake selects one declared origin, keeps JSON API requests in recorded order, masks configured/common credential values, and writes a non-executable draft. Explicit semantic-hash review produces a capsule and receipt. It never calls the recorded origin. See [capture limitations](CAPTURE.md).

Arayüz ve CLI aynı çekirdeği ve adaptör registry'sini kullanır. Hata ölçütü uygulamadan bağımsızdır. PostgreSQL kaynak verisi salt okunur transaction ile seçilir; FK ilişkileri korunarak kopyalanır ve her denemede yeni süreç/veritabanı kullanılır. HAR alımı çevrimdışıdır ve inceleme sonrası kapsül üretir. Geçersiz istekler farklı bir hatayı asıl hata yapmaz. SQLite, ekip kapsamlı geçmişi ve kimlik verisini tutar. Oturum, sunucu rolleri, CSRF ve ekip sınırları alfa 0.4 içinde eklendi; [AUTH.md](AUTH.md) belgesine bak.
