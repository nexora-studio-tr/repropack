# Account email and recovery / Hesap e-postası ve kurtarma

Email is an optional self-hosting capability. It does not add public registration or a paid service. The disposable demo disables account administration and never sends email. Existing local installations keep working without SMTP.

## Operator setup

Set these server environment variables (the application does not load `.env` automatically):

```text
REPROPACK_SMTP_HOST=smtp.example.com
REPROPACK_SMTP_PORT=587
REPROPACK_SMTP_SECURE=0
REPROPACK_SMTP_USER=your-smtp-user
REPROPACK_SMTP_PASSWORD=your-smtp-password
REPROPACK_MAIL_FROM=repropack@example.com
REPROPACK_PUBLIC_ORIGIN=https://repropack.example.com
REPROPACK_REQUIRE_VERIFIED_EMAIL=1
```

Port 587 requires STARTTLS. For implicit TLS, use port 465 and `REPROPACK_SMTP_SECURE=1`. TLS certificates are always validated; there is no plaintext-authentication switch. Keep SMTP credentials in the hosting platform's secret settings. Configure your provider's sender authorization, delivery limits and DNS requirements. The repository supplies no sender account or mail provider.

`REPROPACK_REQUIRE_VERIFIED_EMAIL=1` blocks workspace data and team administration until email is verified, including existing accounts after upgrading. Session inspection, verification requests, password changes and logout remain available. The flag fails startup without configured mail delivery. Otherwise verification is available in **Account & team** without changing the local access policy.

## Behavior and guarantees

- Verification links last 24 hours; recovery links last 30 minutes. Tokens contain 256 random bits and only their SHA-256 hashes are persisted.
- Links use URL fragments, are removed from the address bar, and are consumed only by an explicit same-origin POST. Link scanners do not consume them on GET.
- Tokens are bound to the user, current email and password version. A replacement link, password change, successful reset or expiry makes older links unusable.
- Anonymous recovery returns the same `202 {"accepted":true}` for existing and absent accounts before account lookup/SMTP delivery. Authentication limits and an eight-task email bound limit abuse.
- Recovery changes only the token owner's account, proves email possession, revokes every session and pending invitation issued by that account, invalidates all its account links, cancels its active jobs and requires a normal sign-in. Memberships and team ownership are preserved.
- Backups remain private. Restore additionally revokes email links, including recovery links present in a backup.
- SMTP failure invalidates the undelivered token and emits a generic error without address, token, password or provider response. Request another link after fixing delivery.
- The short delivery queue is not a durable mail service. A process restart can lose pending delivery; request another link. The API's acceptance means queued, not confirmed arrival.

## Validation boundary

Automated HTTP tests exercise expiry, reuse, simultaneous reset, account isolation and session revocation. A real local SMTP socket verifies that credentials are not sent without TLS. Browser checks cover explicit verification, recovery, password confirmation and EN/TR mobile screens using a test-only in-memory delivery transport. Live provider delivery and an independent penetration test are **not** claimed by these checks.

## Türkçe

SMTP isteğe bağlıdır; açık kayıt veya ücretli abonelik eklenmez. Ayarlar sunucu ortam değişkenleriyle verilir. `587` portunda STARTTLS, `465` portunda `REPROPACK_SMTP_SECURE=1` ile doğrudan TLS kullanılır. Sertifika doğrulaması kapatılamaz.

`REPROPACK_REQUIRE_VERIFIED_EMAIL=1` seçilirse mevcut hesaplar dahil e-posta doğrulanana kadar çalışma alanı verileri ve ekip yönetimi açılmaz. SMTP yoksa sunucu bu ayarla başlamaz. Yerel kurulum SMTP olmadan kullanılabilir; bu durumda kurtarma servisi varmış gibi gösterilmez.

Doğrulama bağlantısı 24 saat, parola kurtarma bağlantısı 30 dakika geçerlidir. Anahtarların kendisi veritabanında tutulmaz; adres çubuğundaki parça temizlenir ve işlem bir düğmeyle onaylanır. Yeni bağlantı önceki bağlantıyı geçersiz kılar. Parola sıfırlama bütün oturumları ve kullanıcının bekleyen davetlerini iptal eder, ekip üyeliğini değiştirmez ve otomatik giriş yapmaz.

Kurtarma isteği hesabın varlığını açığa çıkarmaz. İstek kabulü e-postanın ulaştığı anlamına gelmez; SMTP kurulumu, gönderici yetkilendirmesi ve gerçek teslimat kurulumu yapan kişinin sorumluluğundadır. Otomatik testler gerçek e-posta teslimatı veya bağımsız güvenlik denetimi olarak sunulmaz.
