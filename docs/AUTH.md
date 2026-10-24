# Accounts and team boundaries / Hesap ve ekip sınırları — alpha 0.4

## First workspace

Run `npm ci && npm run dev`, then open `http://127.0.0.1:4317`. The first launch creates a random, private `.repropack/bootstrap-token`. Open that local file and paste its contents into **Local setup key**. Choose your name, email, password and team name. There is no default password or public registration. The key is consumed atomically and its file removed where possible; a retained file cannot initialize the instance again. A restart before setup retains the same key.

Use a password of at least 15 characters, up to 256 UTF-8 bytes. Emails are case-normalized; passwords are not trimmed or silently normalized. The application stores a salted scrypt hash, never a recoverable password. Keep the data directory private, including SQLite/WAL files, backups and the setup key. These files are excluded from Git and container build context. Custom `REPROPACK_DATA_DIR` locations need equivalent protection.

After setup, **Account & team** provides invitations, role changes, password changes and activity. Invitation links are displayed once, carry a random secret in the URL fragment, expire after 24 hours and are single-use. Reissuing an invitation invalidates the previous link for that email/team. Share it privately yourself; ReproPack does not send email. Email ownership is not independently verified: possession of the invitation is the onboarding credential. Existing accounts must sign in with the invited email before accepting; invitations cannot replace an account's password.

## Roles

| Action | Owner | Admin | Member | Viewer |
| --- | --- | --- | --- | --- |
| Read team runs and export verified evidence | Yes | Yes | Yes | Yes |
| Start, cancel and check replays | Yes | Yes | Yes | No |
| View member emails, pending invites and audit events | Yes | Yes | No | No |
| Invite/manage members and viewers | Yes | Yes | No | No |
| Invite/manage admins | Yes | No | No | No |
| Transfer ownership | Yes, with current password | No | No | No |
| Change own password; create/switch own teams | Yes | Yes | Yes | Yes |

There is exactly one owner per team. The owner cannot be removed or demoted through member endpoints; ownership transfer atomically promotes another existing member and makes the previous owner an admin. Both accounts must sign in again. Member role changes/removal invalidate that account's sessions and its outstanding invitations issued for the affected team. Active/queued work is cancelled when its creator loses write permission. Every protected request reads current membership; UI controls are not authorization.

## Sessions, CSRF and ingress

- Session IDs contain 256 random bits and only their SHA-256 digests are stored. Login, team switch and password change issue a fresh session. Logout invalidates it on the server; password change revokes all of the user's other sessions.
- Cookies are `HttpOnly`, `SameSite=Strict`, host-only and scoped to `/`. The default listener is loopback HTTP, with a cookie name unique to its port. Tokens are never put in localStorage or sessionStorage. Server-side idle expiry is one hour; absolute expiry is 12 hours. At most ten sessions are retained per user.
- Authenticated writes require the matching Origin, `X-ReproPack-Local: 1`, JSON when a body is accepted, and the session-bound `X-ReproPack-CSRF` token. The public session endpoint supplies the CSRF value to same-origin JavaScript. Setup/login/new-account invite acceptance also require same-origin custom-header requests. CORS is disabled.
- Password hashing uses async scrypt with `N=131072`, `r=8`, `p=1`, a random 16-byte salt and a 64-byte key. At most two password computations run concurrently. Authentication attempts are limited to ten per account and 60 per remote address per 15-minute window; counters survive a restart. Limits count successful attempts too. `429` asks the client to wait, rather than queuing unlimited expensive work.
- For an operator-managed HTTPS reverse proxy, explicitly set `REPROPACK_PUBLIC_ORIGIN=https://repropack.example.com`. Only that exact Host/Origin is accepted, and the cookie becomes `__Host-repropack-session; Secure; HttpOnly; SameSite=Strict; Path=/`. The listener remains `127.0.0.1`. Preserve the configured Host, forward cookies/Origin/custom headers and terminate TLS before forwarding to loopback. `X-Forwarded-*` never establishes trust. Public hosting, TLS certificates and an externally verified deployment are not supplied by this phase.

The password and session choices follow the [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [session-management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). This implementation has local automated validation, not an independent security audit.

Behind a proxy, the remote-address attempt limit applies to the proxy's loopback address and is shared by its users. Review capacity and enforce appropriate limits at the ingress before a larger deployment; forwarded addresses are deliberately not trusted implicitly.

## Team data and operator applications

The active team is held in the server session. Clients cannot override it with a body/header/query parameter. Run listing, live progress, detail, capsule/report export, cancellation and fix checks all use that scope; another team's run ID returns `404`. Storage refuses to move an existing run to a different team. Each team owns a separate adapter registry, PostgreSQL cluster and frozen snapshot under `teams/<team-id>/`. Switching back reuses only that team's snapshot. The server queue holds at most eight jobs, with at most two per team and two per user.

The bundled PostgreSQL fixture contains synthetic data and is available to all teams. A custom operator application **must** be bound to one existing team:

```powershell
$env:REPROPACK_APP_CONFIG = 'C:\path\to\trusted\repropack.json'
$env:REPROPACK_APP_TEAM_ID = '<team-id-from-Account-and-team>'
npm run dev
```

Other teams never receive that registration. A custom application cannot replace a bundled application's ID. Schema/source configuration remains operator controlled; Docker selection and its trust limitations remain as documented in [SANDBOX.md](SANDBOX.md). The CLI is a local operator tool with filesystem access, not a remotely authenticated service.

Existing alpha 0.3 runs are retained with no team assignment and hidden from every team. Only the original instance administrator, while owning the target team, can explicitly import them using **Import previous local history** and their current password. Import annotates the original payloads with the chosen team/actor and records the operation; nothing is automatically published or assigned to the first team.

The API appends scoped activity for setup, sign-in/out, password change, team creation/ownership, invitations/membership, run creation/completion/cancellation, fix checks, exports and history import. Owners/admins can read the latest 100 events. Secrets, request bodies, source rows and raw invitation/session tokens are excluded. The application exposes no audit-edit/delete endpoint; a local database administrator can still alter files, so this is not a tamper-evident external audit service.

Optional SMTP email verification and forgotten-password recovery are implemented in alpha 0.6; see [account email, setup and validation limits](ACCOUNT-SECURITY.md). MFA/SSO and multi-process/distributed queues remain unimplemented. Billing is outside the free open-source release's scope. An account whose last team membership is removed receives its own empty workspace only after a successful password sign-in; removed team data remains inaccessible.

## Türkçe

`npm ci` ve `npm run dev` sonrasında `http://127.0.0.1:4317` adresini aç. İlk yönetici için `.repropack/bootstrap-token` dosyasındaki anahtarı kullan; adını, e-postanı, en az 15 karakterlik parolanı ve ekip adını kendin seç. Varsayılan parola ve herkese açık kayıt yoktur. Anahtar tek kullanımlıdır; kurulumdan önce yeniden başlatma anahtarı değiştirmez. Anahtar dosyası silinemese bile kurulumdan sonra geçersizdir. Özel veri klasörü ve yedeklerini Git'e ekleme.

**Hesap ve ekip** ekranından davet oluştur, rol değiştir, kendi parolanı değiştir ve etkinlikleri incele. Davet bağlantısı yalnızca oluşturulduğunda gösterilir, 24 saat geçerlidir ve bir kez kullanılabilir. Aynı kişiye yeni davet eskisini iptal eder. Bağlantıyı kendin özel olarak paylaş; e-posta gönderilmez ve e-posta sahipliği ayrıca doğrulanmaz. Mevcut hesap, daveti kabul etmeden önce kendi e-postasıyla giriş yapmalıdır. Davet, var olan parolayı değiştiremez.

Ekip sahibi yöneticileri ve sahipliği; yönetici yalnızca üyeleri/görüntüleyicileri yönetir. Üye deneme çalıştırabilir. Görüntüleyici yalnızca okur ve doğrulanmış kanıtları dışa aktarır. Her ekipte tek sahip vardır; sahipliği devretmek mevcut parola ister ve iki hesabın oturumlarını kapatır. Rol değiştirme/üyelik kaldırma oturumları geçersiz kılar. Çalıştırmayı başlatan kişi yazma iznini kaybederse bekleyen/aktif işi iptal edilir. Yetki her istekte sunucuda kontrol edilir.

Oturum HttpOnly/SameSite=Strict çerezindedir; tarayıcı depolarına yazılmaz. Boşta kalma sınırı bir saat, toplam ömrü 12 saattir. Çıkış sunucudaki oturumu siler; parola değiştirme diğer oturumları kapatır. Yazma istekleri doğru Origin, özel başlık ve oturuma bağlı CSRF değeri gerektirir. Parolalar scrypt ile tutulur. Kimlik doğrulama sınırları hesap başına 10 ve adres başına 60 deneme/15 dakikadır; en fazla iki parola hesabı aynı anda çalışır. Sayaçlar yeniden başlatmada korunur.

Aktif ekip oturumda tutulur; gövde, sorgu veya başlıkla başka ekip seçilemez. Başka ekibin çalıştırma kimliği `404` verir. Her ekibin adaptörü, PostgreSQL kümesi ve dondurulmuş snapshot'ı ayrıdır. Özel uygulamayı bağlamak için `REPROPACK_APP_CONFIG` yanında **Hesap ve ekip** ekranındaki kimlikle `REPROPACK_APP_TEAM_ID` tanımlamak zorunludur. Diğer ekipler bu uygulamayı göremez. CLI, dosya erişimi olan yerel operatör aracıdır.

Eski yerel geçmiş korunur ve kendiliğinden hiçbir ekibe açılmaz. İlk instance yöneticisi, sahibi olduğu ekibe mevcut parolasıyla açıkça içe aktarabilir. Denetim izi ekip kapsamındadır; sahibi/yöneticisi son 100 olayı görebilir. Parola, oturum/davet sırrı ve ham istek/veritabanı satırları kaydedilmez. Yerel veritabanı yöneticisinin dosyaları değiştirmesine karşı imzalı kayıt garantisi yoktur.

Varsayılan sunucu yalnızca loopback üzerinde çalışır. HTTPS proxy için `REPROPACK_PUBLIC_ORIGIN` açıkça tanımlanır; Secure ve `__Host-` çerezi kullanılır. Proxy'nin Host, Origin, çerez ve özel başlıkları koruması gerekir; `X-Forwarded-*` güven kaynağı değildir. Alfa 0.6 içinde isteğe bağlı SMTP e-posta doğrulaması ve parola kurtarma eklendi; [kurulum ve sınırlar](ACCOUNT-SECURITY.md). MFA/SSO ve dağıtık kuyruk desteklenmez. Ücretsiz açık kaynak sürüm ödeme veya abonelik içermez. Yayın durumunu [yol haritasından](ROADMAP.md) kontrol et.
