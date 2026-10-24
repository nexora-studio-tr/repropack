# Alpha 0.6 security review / Güvenlik değerlendirmesi

Date: 2026-10-24. Scope: free open-source ReproPack, account email/recovery, release contents and CI. This is a maintainer review supported by automated tests, not an independent audit.

| Risk | Implemented control | Evidence |
| --- | --- | --- |
| Recovery exposes whether an email exists | Same 202 response before lookup/delivery; bounded asynchronous queue and persistent throttles | HTTP tests with present/absent addresses and blocked delivery |
| Stolen or replayed account link | 256-bit token, stored SHA-256 only, purpose/email/password binding, expiry and atomic consumption | Wrong-purpose, expired, reused, concurrent reset and password-change tests |
| Reset affects a different account or changes membership | Token owner selected server-side; extra request fields rejected; memberships unchanged | Cross-account HTTP test |
| Old sessions or restored links remain usable | Reset revokes all sessions and account links; restore revokes saved links | HTTP tests, real SQLite backup/restore test |
| SMTP leaks account credentials without encryption | Required STARTTLS or implicit TLS with certificate validation; no debug/provider error output | Real local socket refuses STARTTLS; no AUTH sent |
| Same-page link or helper text breaks recovery | Hash-change handling, explicit action, fragment removal and accessible field names | Real browser recovery/verification, EN/TR 390px layout |
| Commercial source/runtime secrets enter release | Explicit source allowlist, symlink refusal, credential patterns, version consistency and per-file hashes | Release preflight and mutation tests; archive manifest verification |
| CI tag or third-party action drifts | Full commit SHA pins; read-only validation jobs; full gates before release job gets contents write | Workflow source check; remote execution recorded separately |

Remaining boundaries:

- SMTP credentials, authorized sender and provider delivery must be configured by the instance operator. Tests do not claim real mailbox delivery.
- The bounded email queue is not durable across process termination; request another link if delivery was interrupted.
- MFA/SSO, email-address changes, distributed execution and an independently audited hosted service are not included.
- Native applications execute trusted code. Docker is an explicit quota/isolation option with a shared kernel; it is not a hostile-code hosting guarantee.
- Pattern-based release scanning cannot detect every possible secret or vulnerability. No external penetration test or real-user pilot has been completed.
- GitHub publication, successful remote CI, private vulnerability reporting and managed demo deployment require verification in their actual accounts.

## Türkçe

Değerlendirme hesap kurtarma, e-posta doğrulaması, yayın paketinin kapsamı ve CI izinlerini kapsar. Süreli/tek kullanımlık bağlantılar, hesap ayrımı, bütün oturumların iptali, yedekten dönen bağlantıların iptali ve TLS zorunluluğu test edilmiştir. Arayüzde aynı sekmede açılan hesap bağlantıları ve erişilebilir alan adları düzeltilip gerçek tarayıcıda doğrulanmıştır.

Bu kayıt bağımsız güvenlik denetimi değildir. Gerçek SMTP teslimatı, GitHub/CI, güvenlik bildirim kanalı ve genel demo kendi hesaplarında doğrulanmadan tamamlandı sayılmaz. Ürün ücretsiz açık kaynak alfadır; ödeme veya abonelik içermez.
