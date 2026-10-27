# Installation, release and demo / Kurulum, yayın ve demo — alpha 0.6

## Live demo / Canlı demo

[Open ReproPack](https://repropack-demo-4rq9.onrender.com/) runs the restricted synthetic demo on Render Free over HTTPS. No sign-up is required. Visitors have separate temporary workspaces; private accounts, PostgreSQL applications and uploaded scenarios are disabled. The real 16 → 5 reduction, three fresh fix trials, exports and visitor isolation have been validated over public HTTPS.

The free service can sleep when idle and needs time to wake up. Demo sessions last up to 60 minutes and are lost on service restarts. See [Render Free limits](https://render.com/docs/free). This public demo is separate from the persistent private installation below.

[Canlı ReproPack demosu](https://repropack-demo-4rq9.onrender.com/) Render Free üzerinde HTTPS ile çalışır. Kayıt gerekmez; her ziyaretçinin ayrı, geçici çalışma alanı vardır. Ücretsiz sunucu uyuyabilir ve ilk açılış gecikebilir. Oturumlar 60 dakika sonra veya servis yeniden başladığında sıfırlanır. Özel kullanıcı/ekip yönetimi ve PostgreSQL uygulamaları yerel kuruluma aittir.

## Private installation

Requires a Linux Docker engine and Docker Compose. From the ReproPack directory:

```sh
docker compose up --build --detach --wait
```

Open `http://127.0.0.1:4317`. Read the initial setup key in your own terminal with `docker compose exec app cat /var/lib/repropack/bootstrap-token`, then choose your administrator account/password. The key is consumed at setup. No account is pre-created. A Node installation already listening on 4317 can stay separate: choose `REPROPACK_HTTP_PORT=4318` and `REPROPACK_PUBLIC_ORIGIN=http://127.0.0.1:4318` before running Compose.

The image runs as UID/GID 10001, with a read-only root, dropped capabilities, no-new-privileges, process/CPU/memory limits and bounded `/tmp`. Only the named data volume is persistent. Ports bind to host loopback. An operator-managed HTTPS proxy can use `REPROPACK_PUBLIC_ORIGIN=https://your-domain.example`; Host/Origin must be preserved. Explicit loopback HTTP origins are also accepted for alternate local port mappings. Public non-loopback HTTP origins are rejected.

This container hosts trusted application factories in native mode, including the bundled real PostgreSQL fixture. It is different from per-trial Docker isolation in [SANDBOX.md](SANDBOX.md). No Docker daemon socket is mounted and no Docker CLI is included in the web image. Hostile user-supplied code execution is not offered. Custom factory code must be reviewed and included in an operator-built image, with the team binding described in [AUTH.md](AUTH.md).

`GET /healthz` exposes only liveness status, without credentials or run/account data. Compose waits for the image's health check. Restart with `docker compose restart app`; accounts, sessions, team scope and run history stay in the named volume. Interrupted work is not replayed automatically. PostgreSQL snapshots are temporary registry state and are rebuilt after restart.

## Backup and restore

Run `docker compose exec app node scripts/backup.mjs` after first-owner setup. The SQLite online backup includes committed account/team/history/audit state while the application is running. It writes a unique `.sqlite` plus a JSON checksum manifest under the data directory's `backups/`. Copy both files to a private backup destination with `docker compose cp`; they contain private account hashes and potentially private capsule contents. PostgreSQL snapshots, source credentials and operator application configuration are not bundled.

Restore always creates a **new directory**, validates the checksum and SQLite integrity, and revokes all restored sessions and unused invitations. Existing workspaces are never overwritten. For example, after stopping the service:

```sh
docker compose stop app
docker compose run --rm --no-deps app node scripts/restore.mjs /var/lib/repropack/backups/CHOSEN.sqlite /var/lib/repropack/restored-01
```

Set `REPROPACK_CONTAINER_DATA_DIR=/var/lib/repropack/restored-01`, then `docker compose up --detach --wait`. Sign in again using the account/password state from the chosen backup. The old database stays in place for inspection. Snapshot-dependent fix verification requires a fresh reduction. The checksum detects corruption; backups are not independently signed.

## Disposable demo

```sh
docker compose -f compose.demo.yaml up --build --detach --wait
```

Open `http://127.0.0.1:4320`. Source users can also run `npm ci && npm run demo:web`. Each visitor opens a separate workspace without signing up. It lasts up to 60 minutes, with at most ten reduction/fix operations. At most 30 workspaces are held. Admission is limited to ten starts per observed remote address per 15 minutes; proxy traffic shares that observed-address limit. Expired access is denied immediately; cleanup follows after active work stops, on a 15-second sweep or next session request.

Only the unchanged synthetic 16-request HTTP fixture can run. The real reducer checks the failure, reduces it to five steps and checks the bundled fix. Personal data/code upload, PostgreSQL/custom applications, invitations and account/team administration are disabled by the server. A demo database cannot be opened as a private workbench. Demo storage is a fresh temporary directory without a persistent volume; ending a session, expiry, or a restart removes access. Restarts intentionally discard all demo state.

### Temporary public preview, without an account

After building the app image, pull the official client once and start sharing:

```sh
docker compose build
docker pull cloudflare/cloudflared:latest
npm run demo:share
```

The command resolves immutable local image IDs and prints a temporary HTTPS URL after an external demo-only readiness check. The tunnel, web demo and network keeper use a separate Docker network namespace. No host port, host folder, private workspace or Docker socket is attached. The web container is inspected before publishing the link. Even a surviving tunnel cannot forward to a later process on a reused host port.

The preview ends within approximately two hours or when stopped. The computer, Docker engine and tunnel must remain running. This uses [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), which are temporary testing endpoints without an uptime guarantee, not a permanent deployment. Stop with Ctrl+C, or use the printed lease:

```sh
node scripts/share-demo.mjs stop .repropack/previews/CHOSEN-ID/lease.json
```

Cleanup checks the original engine, full container IDs and owner/workspace labels. A changed engine, forged metadata or uncertain create keeps the lease for inspection; there is no global prune. If the controlling shell dies, the demo server still has an independent two-hour lifetime. Retained owned containers can be stopped later using the lease.

### Free persistent public URL

`render.yaml` defines **one Free Docker web service**, exclusively in demo mode. Import the ReproPack repository into Render and use this Blueprint. No database, paid disk or other paid service is requested. `RENDER_EXTERNAL_URL` supplies the exact HTTPS origin; no private administrator credentials are required.

[Render's Free service](https://render.com/docs/free) has idle sleep, cold starts, monthly quotas and an ephemeral filesystem. These fit the disposable demo, while private account/history storage needs persistent hosting. A Render account and a source repository connection are still required for a permanent deployment. The Blueprint is preparation, not evidence of a live Render deployment. Review the Free tier selected by the provider; adding paid resources is a separate choice. [Blueprint reference](https://render.com/docs/blueprint-spec).

## Source release

`npm run release:package` produces `artifacts/release/repropack-0.5.0-alpha.1.tgz` and a SHA-256 file. It refuses to overwrite an existing archive. The archive includes a file/hash manifest, the npm lockfile, sources, sample data, docs, tests and deployment files. `.repropack`, `.env`, private databases, installed dependencies, build output, sibling projects and Git metadata are excluded; symbolic links are rejected. Extract it, run `npm ci`, then `npm run dev` or Compose. `package.json` stays private to prevent accidental npm publication.

Validate the real deployment locally with `npm run validate:deployment` after building the image. It provisions uniquely named disposable Compose projects, checks non-root/read-only/port restrictions, real PostgreSQL, private data survival, backup/restore and independent demo visitors/restarts. It removes only resources carrying that attempt's ownership labels, then saves a report under `artifacts/deployment-validation/`. Public tunneling is never started by CI.

## Türkçe

Özel kurulum: `docker compose up --build --detach --wait`. Arayüz `http://127.0.0.1:4317`; ilk anahtarı kendi terminalinde `docker compose exec app cat /var/lib/repropack/bootstrap-token` ile oku ve yönetici hesabını kendin oluştur. 4317'de mevcut Node sunucusu varsa `REPROPACK_HTTP_PORT=4318` ve `REPROPACK_PUBLIC_ORIGIN=http://127.0.0.1:4318` seç. Kaynak dizininde `.env` otomatik okunmaz; Compose değişkenleri kabuktan veya kendi `.env` dosyasından alır.

Konteyner yetkisiz kullanıcıyla, salt okunur kök dosya sistemiyle ve sınırlı CPU/bellek/süreç/geçici alanla çalışır. Hesaplar, ekipler ve geçmiş yalnızca isimli veri volume'ünde kalır. Host portu loopback'e bağlıdır. HTTPS proxy için adresi `REPROPACK_PUBLIC_ORIGIN` ile açıkça tanımla. Web konteynerine Docker soketi bağlanmaz; içindeki uygulama fabrikaları güvenilir olmalıdır.

Yedek: `docker compose exec app node scripts/backup.mjs`. Oluşan `.sqlite` ve yanındaki `.json` dosyasını birlikte özel bir yere kopyala. Aktif SQLite yazmalarıyla tutarlı yedek alınır; ham PostgreSQL snapshot'ı ve kaynak yapılandırması dahil değildir. Geri yükleme yalnızca yeni bir dizine yapılır; eski çalışma alanına dokunulmaz. Checksum/bütünlük doğrulanır; geri yüklenen oturumlar ve kullanılmamış davetler geçersiz kılınır. Yukarıdaki restore komutundan sonra `REPROPACK_CONTAINER_DATA_DIR` ile yeni dizini seçip yeniden başlat.

Yerel demo: `docker compose -f compose.demo.yaml up --build --detach --wait`, ardından `http://127.0.0.1:4320`. Node ile `npm run demo:web` de kullanılabilir. Ziyaretçiler kayıtsız, birbirinden ayrı ve en fazla 60 dakikalık alan açar. Her alanda 10 küçültme/düzeltme işlemi, instance genelinde 30 alan sınırı vardır. Proxy arkasında yeni alan açma limiti paylaşılır. Yalnızca dahil edilen örnek veri çalışır; PostgreSQL, özel kod/veri yükleme ve hesap/ekip yönetimi kapalıdır. Gerçek motor, hata/düzeltme ve dışa aktarma çalışır; sonuçlar önceden kaydedilmiş görüntüler değildir.

Geçici HTTPS paylaşımı: imajı oluştur, `docker pull cloudflare/cloudflared:latest` çalıştır ve `npm run demo:share` kullan. Bağlantı yaklaşık iki saat veya işlem durana kadar geçerlidir; bilgisayar ve Docker açık kalmalıdır. Tünel yalnızca ayrı Docker ağ alanındaki demo servisine gider; host portu, özel veri klasörü ve Docker soketi aktarılmaz. Kapatmak için Ctrl+C veya yukarıdaki sahiplik kontrollü stop komutunu kullan.

Kalıcı ücretsiz adres için `render.yaml`, Render Free Docker demo servisini tanımlar. Render hesabı/depo bağlantısı gerekir; bu dosya tek başına yayına çıkıldığı anlamına gelmez. Ücretsiz servis uyur, yeniden başlarken yerel verisini kaybeder ve kota uygular. Örnek verili geçici demoya uygundur; özel ekip verisinin kalıcı tutulacağı hizmet ayrıca planlanmalıdır. Ücretli servis eklenmez. Kaynak `.tgz` arşivini `npm run release:package`, gerçek Docker dağıtım testini `npm run validate:deployment` üretir.
