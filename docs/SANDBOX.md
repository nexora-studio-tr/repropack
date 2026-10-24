# Isolation and recovery / İzolasyon ve kurtarma — alpha 0.3

**Validation status — 2026-10-24:** native Windows crash recovery, the host-side Docker protocol and **real Linux Docker validation on Windows/WSL 2 pass**. `npm run validate:sandbox` built the runtime and ran the real smoke gate on Docker Desktop 4.96.3 / Engine 29.9.2 / cgroup v2. Its nine checks covered failure/fix replay, host-secret exclusion, read-only root, external-network denial, cgroup CPU/memory/PID settings, kernel OOM, PID enforcement, wall deadline and parent-crash cleanup. Evidence: local `artifacts/sandbox-validation/2026-10-24T11-24-20-364Z-7f5806b6/report.json`. No remote GitHub Actions run has been performed; a local pass does not claim remote CI or a standalone Linux host matrix. The product remains a local alpha; alpha 0.4 account/team authorization is documented in [AUTH.md](AUTH.md).

The full Docker CLI flow also passed: 12 → 3 steps, 36 trials, fresh failure verification and three successful fixed-module replays. Reduction took 183,880 ms within its 300-second budget. Two prerequisite deletions were inconclusive, so minimality is not certified. Local bundle: `artifacts/repro-1792850530711/`.

## Choose the execution boundary

| Mode | Application runs | Resource limits | Intended input |
| --- | --- | --- | --- |
| Default `trusted-native` | Separate host process and per-trial database clone | Cooperative engine budget; independent 15-second application watchdog | Trusted local factory modules |
| Explicit `docker` | A fresh Linux container containing the whole trial, application and PostgreSQL | cgroup memory/CPU/PID limits, tmpfs space bounds, external wall deadline | Operator-selected workload image and reviewed, masked snapshot |

The UI and exported environment evidence distinguish these modes. Docker mode requires an immutable **local** `sha256:<64 hex>` image ID. It never pulls an image or falls back to native execution. The operator-selected schema/seed SQL and source configuration remain trusted: source capture/preparation occurs on the host. A capsule cannot choose an image, executable path, credentials, SQL or quotas.

The host checks Linux, cgroup v2, memory/swap/CPU/PID support and built-in seccomp before running. It then inspects the created container and refuses weakened restrictions. The container uses:

- No external network (`--network=none`); loopback inside the container serves the app and its temporary database.
- UID/GID `10001:10001`, all Linux capabilities dropped and `no-new-privileges`.
- A read-only image, bounded `noexec,nosuid,nodev` tmpfs at `/work` and `/tmp`, and 8 MiB shared memory.
- No host bind mounts, Docker socket, published ports, devices, image-declared volumes or restart policy.
- Default 512 MiB RAM with no additional swap, one CPU, 64 tasks, 192 MiB `/work`, 16 MiB `/tmp`, 15 seconds per attached workload. Quotas also cover PostgreSQL and helpers.
- Disabled Docker log storage. Selected masked input travels over stdin, not command arguments or a host-mounted payload file. Arbitrary stdout/observations are never copied into persisted trial evidence.

An OOM or deadline is `unresolved`, never proof that the original bug occurred. Startup/daemon/cleanup failures fail the run. The total reduction budget is 300 seconds in Docker mode, including fresh container/PostgreSQL startup for every trial; native PostgreSQL retains 120 seconds and the HTTP demo 30 seconds. Per-workload quotas are unchanged. Incomplete output remains uncertified.

This isolates **one whole trial**. Its app, local runner and temporary PostgreSQL share a container user, so actively hostile code could tamper with that trial's data or claimed result. It is not an attestation system. No host/source credential, other trial or other tenant is included in the container. Docker shares a kernel with its Linux host; this alpha does not implement a VM boundary or a public hostile-code service.

## Build and validate explicitly

The complete real-engine gate now has one command:

```sh
npm run validate:sandbox
```

It checks the real Linux engine, builds the allowlisted runtime image, pins the resulting image ID, and runs the full sandbox smoke test. Set `REPROPACK_SANDBOX_IMAGE` to an existing immutable local image ID to skip building. Each attempt writes a unique `artifacts/sandbox-validation/<attempt>/report.json` with `passed`, `blocked` or `failed`, engine/image metadata and whether the real smoke test executed. Missing Docker records no passed checks and returns nonzero, as do build/test failures. The underlying Node script uses 2 for blocked and 1 for failed; an npm/shell wrapper can normalize these codes, so use the JSON status to distinguish them. Only an actual successful smoke run exits 0. The report contains no snapshot rows or credentials. Built validation image tags are retained for reuse. Linux CI runs this same command and uploads the report even on failure.

On Windows it also finds the documented per-user Docker Desktop installation without changing the global PATH. This command does not install Docker, enable Windows components, accept software terms or restart the computer.

Run from the `repropack` directory. The build context has an allowlist and does not include the sibling commercial Discord bot. Building requires internet access; replay requires only an already installed local image. For independently reproducible image builds, supply a digest-pinned base image in your build process; the supplied versioned base tag is not a digest pin. Execution itself always pins the resulting image ID.

PowerShell:

```powershell
docker build --file Dockerfile.sandbox --tag repropack-sandbox:local .
$repropackImageId = docker image inspect --format '{{.Id}}' repropack-sandbox:local
$env:REPROPACK_SANDBOX_IMAGE = $repropackImageId
node src/cli.ts sandbox-doctor
npm run test:sandbox
npm run demo:postgres
```

POSIX shell, after building the same image:

```sh
export REPROPACK_SANDBOX_IMAGE="$(docker image inspect --format '{{.Id}}' repropack-sandbox:local)"
node src/cli.ts sandbox-doctor
npm run test:sandbox
```

`sandbox-doctor` is read-only. The real smoke test requires Docker and fails rather than skips if it is missing. It checks actual failure/fix replay, forbidden host-secret inheritance, read-only root, no external interface/connectivity, cgroup settings, kernel OOM/PID enforcement, deadline and parent-crash cleanup. It uses only disposable resources and reserved documentation IP `198.51.100.1` for its denied-network probe. No Docker/service/system-user installation is performed by ReproPack. The image creates its own user only inside the image.

Set the image environment variable before starting `npm run dev` to use the sandbox for the bundled PostgreSQL application. Without it, the default remains trusted native mode.

## Custom application configuration

Build the factory module and its dependencies into an image containing the supplied runtime at `/opt/repropack`. Extend the trusted local application config from [POSTGRES.md](POSTGRES.md):

```json
{
  "execution": {
    "kind": "docker",
    "image": "sha256:<actual-local-image-id>",
    "module": "/opt/repropack/application/app.ts",
    "fixedModule": "/opt/repropack/application/fixed.ts",
    "quotas": { "memoryMiB": 512, "cpus": 1, "pids": 64, "scratchMiB": 192, "wallMs": 15000 }
  }
}
```

This is a fragment, not a full application config. Existing host `module`, schema and snapshot declarations are still required. The host entry-module hash must match the module embedded in the image; the immutable image ID additionally identifies transitive image contents. Declare `fixedModule` on both sides or neither. Paths must be normalized absolute Linux paths. Accepted bounds: RAM 256–2048 MiB; CPU 0.25–2; tasks 16–128; `/work` 64–512 MiB and at most half RAM; workload wall time 3–30 seconds. This workload deadline excludes bounded Docker setup/cleanup command time.

## Crash ownership and recovery

Detached supervisors receive a private IPC channel. If the workbench disappears, they close owned PostgreSQL, terminate stuck application workers or force-remove their container. On Windows, detachment prevents the workbench's kill-on-close Job Object from terminating the cleanup supervisor together with the app. They never import host application modules themselves. Native mode does not guarantee containment of deliberately detached descendants; use Docker for workload containment.

Before Docker `create`, a journal records a random owner, the canonical workspace scope, exact container name and engine ID, with no payloads or credentials. A named pipe/Unix socket answers liveness challenges. Unknown/slow liveness is not treated as death. Cleanup rechecks engine identity, full container ID and both ownership labels; no PID-based orphan killing or blanket `docker prune` is used.

If both the workbench and supervisor are killed, the next **sandbox initialization** checks journals and removes only stale owned containers. A different engine/context, uncertain liveness or failed daemon/cleanup command retains the journal and blocks recovery. Restore the original Docker context/engine before retrying. A stopped or killed supervisor cannot enforce its clock while down; the journal is recovery on restart, not an always-on external scheduler. Complete machine power loss also cannot run an in-process cleanup handler. Native cluster remnants after a simultaneous supervisor kill are retained rather than removed by unsafe PID guessing.

## Türkçe

Tek komutluk doğrulama: `npm run validate:sandbox`. Gerçek motoru kontrol eder, imajı oluşturup sabitler, tüm Docker testlerini çalıştırır ve `artifacts/sandbox-validation/` altında sonuç kaydeder. Docker yoksa `blocked`, test/derleme başarısızsa `failed` ve sıfır olmayan çıkış kodu üretir. Node betiği bunları 2/1 ile ayırır; npm/kabuk kodu değiştirebildiği için kesin ayrımı JSON durumundan oku. Sadece gerçek test tamamlanınca `passed` olur. Kayıtta özel snapshot verisi veya parola bulunmaz. Komut işletim sistemine kurulum yapmaz; Windows bileşenlerini değiştirmez. Docker Desktop'ın kullanıcıya özel kurulumunu global PATH'i değiştirmeden bulur. Oluşturulan imaj yeniden kullanım için korunur.

Varsayılan mod **güvenilir yerel kod** içindir; ayrı süreç OS sandbox değildir. Docker modu açıkça seçilir ve yalnızca yerelde mevcut sabit imaj kimliğini kabul eder. Docker, desteklenen cgroup v2 kotaları veya imaj bulunmazsa işlem reddedilir; kod yerel modda çalıştırılmaz. Şema/seed SQL'i ve kaynak yapılandırması yine operatörün güvenilir girdisidir; uygulama modülü Docker seçildiğinde ana makinede yüklenmez.

Konteynerin dış ağı kapalı, kök dosya sistemi salt okunur, kullanıcısı yetkisizdir. Host klasörü, Docker soketi, kaynak/admin parolası veya açık port aktarılmaz. PostgreSQL dahil tüm deneme bellek/CPU/süreç/süre ve geçici alan sınırına girer. Docker küçültmesinin toplam bütçesi, her denemedeki konteyner/PostgreSQL başlangıcını kapsayan 300 saniyedir; yerel PostgreSQL 120, HTTP demosu 30 saniye kullanır. Deneme başına sert kotalar korunur. Kota aşımı asıl hataymış gibi değerlendirilmez. İmaj kimliği, çalışma modu ve kotalar kanıt raporuna eklenir. Aynı denemenin içindeki kötü niyetli uygulama kendi verisini/sonucunu bozabilir; rapor imzalı çalıştırma tasdiki değildir.

Bağımsız gözetmen, ana uygulama zorla kapanınca temizliği sürdürür. Gözetmen de kapanırsa sonraki sandbox başlangıcında journal üzerinden yalnızca aynı Docker motorundaki sahipli kaynaklar temizlenir. Canlılık belirsizse, motor değişmişse veya temizlik başarısızsa kayıt korunur. Diğer projelerin süreçleri/konteynerleri taranarak öldürülmez. Motoru değiştirdiysen önce eski bağlama geri dön. Yerel modda gözetmenin de öldürülmesinden kalan dosyalar, PID tahminiyle silinmez.

**Gerçek Docker doğrulaması geçti.** Windows/WSL 2, Docker Desktop 4.96.3 ve Engine 29.9.2 üzerinde imaj oluşturuldu; dokuz gerçek izolasyon/kota/çökme kontrolü başarılı oldu. Yerel kanıt yukarıdaki `report.json` dosyasındadır. GitHub Actions henüz uzakta çalıştırılmadı. Kullanıcı/ekip yetkilendirmesi alfa 0.4 ile eklendi; [AUTH.md](AUTH.md) belgesine bak. Halka açık dağıtım henüz yapılmadı.

Tam Docker CLI akışı da geçti: 12 → 3 adım, 36 deneme, 183.880 ms küçültme süresi; hata taze denemelerde korundu ve düzeltilmiş modül üç kez beklenen başarıyı verdi. İki ön koşul silmesi belirsiz olduğundan en küçüklük iddiası yoktur. Yerel kapsül ve rapor: `artifacts/repro-1792850530711/`.

## Primary references

- [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [Docker run and image IDs/digests](https://docs.docker.com/engine/containers/run/)
- [Docker tmpfs storage](https://docs.docker.com/engine/storage/tmpfs/)
- [Node.js permission model trust boundary](https://github.com/nodejs/node/blob/main/doc/api/permissions.md)
