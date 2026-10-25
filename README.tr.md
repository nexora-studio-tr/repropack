# ReproPack

[![CI](https://github.com/nexora-studio-tr/repropack/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nexora-studio-tr/repropack/actions/workflows/ci.yml)

Ücretsiz, MIT lisanslı açık kaynak alfa. Yerel kurulumda güvenilir uygulama kodu kullanılır; genel demo geçici ve sentetiktir. Ödeme, abonelik ve otomatik telemetri içermez.

**[Canlı demoyu aç →](https://repropack-demo-4rq9.onrender.com/)** · Kayıt gerektirmez · Yalnızca örnek veri.

Ücretsiz sunucu boşta kaldığında uyuyabilir; ilk açılış yaklaşık bir dakika sürebilir. Demo çalışma alanları 60 dakika sonra ve servis yeniden başladığında sıfırlanır.

## Hesap kurtarma ve yayın kontrolleri — alfa 0.6

İsteğe bağlı SMTP e-posta doğrulaması ve parola kurtarma eklendi. Bağlantılar süreli ve tek kullanımlıktır; anahtarların yalnızca özeti saklanır. Sıfırlama bütün oturumları kapatır. [Kurulum ve güvenlik sınırları](docs/ACCOUNT-SECURITY.md).

`npm run release:check` yalnızca yayınlanacak kaynakları denetler. CI eylemleri tam commit kimliğine sabitlenmiştir; etiket yayını CI kontrollerini geçmeden sürüm arşivi yayımlamaz. [Gönüllü pilot yönergesi](docs/PILOT.md) ve GitHub geri bildirim formları hazırdır; bağımsız güvenlik denetimi veya gerçek kullanıcı pilotu yapılmış sayılmaz.

[Ücretsiz geçici demo kur](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fnexora-studio-tr%2Frepropack) · [Yerel kurulum](docs/DEPLOY.md)

**Daha az gürültü. Aynı hata.** Tekrarlanabilir bir HTTP senaryosunu, aynı hatayı koruyarak küçültür.

[English](README.md) · [Mimari](docs/ARCHITECTURE.md) · [Güvenlik](SECURITY.md) · [Yol haritası](docs/ROADMAP.md)

## Kurulum ve paylaşılabilir demo — alfa 0.5

`docker compose up --build --detach --wait` kalıcı verili özel atölyeyi açar. `docker compose -f compose.demo.yaml up --build --detach --wait`, 4320 portunda ayrı bir geçici demo başlatır; Node ile `npm run demo:web` de kullanılabilir. Ziyaretçiler kayıt olmadan gerçek motoru kendi sınırlı, geçici örnek alanında dener. Checksum doğrulamalı kaynak arşivi, yedek/geri yükleme, ücretsiz Render yapılandırması ve isteğe bağlı geçici HTTPS paylaşımı eklendi. [Kurulum ve demo belgesi](docs/DEPLOY.md).

## Hesap ve ekipler — alfa 0.4

Özel atölye giriş gerektirir. İlk kurulumda `.repropack/bootstrap-token` dosyasındaki özel anahtarı kullanıp kendi yönetici hesabını ve parolanı seç. Ekip sahibi/yönetici/üye/görüntüleyici rolleri, süreli ve tek kullanımlık davetler, sunucu oturumları, CSRF kontrolü ve ekip etkinlikleri eklendi. Çalıştırma API'leri ve PostgreSQL snapshot'ları aktif ekip kapsamında ayrılır. Eski yerel geçmiş açıkça içe aktarılana kadar kapalı kalır. [Kurulum, yetkiler ve sınırlar](docs/AUTH.md). Özel atölye varsayılan olarak yerel kalır; paylaşım demosu ayrı ve sınırlı modda açılır.

## İzolasyon ve kurtarma — alfa 0.3

Açıkça seçilen Docker modu, sert iş yükü kotaları, sahiplik journal'ı ve bağımsız temizlik gözetmenleri eklendi. Windows çökme temizliği ile **Windows/WSL 2 üzerinde gerçek Linux Docker testleri geçti**: bellek ve süreç kotaları, dış ağ erişiminin engellenmesi ve ana süreç çökünce temizlik doğrulandı. Varsayılan yerel mod güvenilir kod gerektirir. [Kurulum, sınırlar ve doğrulama kanıtı](docs/SANDBOX.md). Uzak GitHub CI ve kalıcı yönetilen dağıtım yapılmadı; alfa 0.5 ayrı bir geçici paylaşım demosu ekler.

## PostgreSQL uygulamaları — alfa 0.2

Arayüzden **Node.js + PostgreSQL** seç veya çalıştır:

```sh
npm run demo:postgres
node src/cli.ts reduce examples/postgres-cart.json
```

Yerel operatörün açıkça tanımladığı Node.js modülü, gerçek PostgreSQL 18 üzerinde sınanır. Kaynak veritabanından salt okunur transaction ile ilişkili kayıtlar alınır, belirtilen anahtar olmayan TEXT alanları yerelde maskelenir ve dondurulmuş bir şablon oluşturulur. Her denemede yeni veritabanı kopyası, ayrı Node süreci ve yalnızca o veritabanına yetkili uygulama rolü kullanılır. Docker, sistem servisi veya işletim sistemi kullanıcısı kurulmaz.

Örnekteki 8 kaynak kaydından 4 ilişkili kayıt seçilir, 1 e-posta maskelenir. Snapshot sepeti ve ürünü zaten içerdiği için 12 adımlık akış 3 adıma iner. Tanımlanan düzeltilmiş modül aynı snapshot üzerinde sınanır.

[Kendi uygulamanı bağlama](docs/POSTGRES.md) · [HAR dosyasından incelemeli kapsül oluşturma](docs/CAPTURE.md). Kapsüle yalnızca mantıksal uygulama/snapshot kimlikleri girer; dosya yolu, SQL veya veritabanı parolası girmez. Rapor ham veriyi değil hash ve kayıt sayılarını içerir.

## Bugün çalışan kapsam

Bu sürüm **kimlik doğrulamalı ekip alanları içeren yerel bir alfa**. PostgreSQL adaptörünün yanında ilk HTTP sepet demosu da kullanılabilir. Bu demoda her deneme temiz bir sunucu ve boş durumla başlar. Motor gereksiz istekleri eler, kalan senaryodaki hatayı taze denemelerle doğrular ve kanıtları JSON olarak dışa aktarır.

Örnek 16 adımdan 5 adıma iner: sepet oluştur → kahve ekle → kupon uygula → adedi değiştir → ödeme özetini oku. Kupon SAVE20 olarak durmasına rağmen hatalı sürüm 100 dolar, dahil edilen düzeltilmiş sürüm 80 dolar döndürür.

- Sırayı ve hata ölçütü adımını koruyan delta debugging motoru.
- `fail` / `pass` / `unresolved` ayrımı; başka bir hata, asıl hata sayılmaz.
- Üç başlangıç denemesi, tekrarlanan adaylar, taze doğrulama, iptal ve çalışma sınırları.
- Geçersiz adımlar nedeniyle belirsiz kalan minimal olma durumunu açıkça raporlama.
- CLI paketi, Türkçe/İngilizce React arayüzü, yerel SQLite geçmişi ve demo düzeltmesini sınama.

## Kurulum

**Node.js 24.15+** ve npm gerekir. AI API anahtarı veya harici veritabanı servisi gerekmez.

```sh
npm ci
npm run dev
```

**http://127.0.0.1:4317** adresini aç. Sağ üstten TR ve istediğin adaptörü seç. **Senaryoyu küçült** ile başlat, deneyleri incele ve kapsülü indir. HTTP seçeneği dahil edilen demo düzeltmesini, PostgreSQL seçeneği yerelde tanımlanan `fixedModule` kodunu sınar. Kodunu otomatik değiştirmez.

```sh
npm run demo
node src/cli.ts reduce examples/cart-discount.json --out artifacts/benim-hatam
npm run check
```

CLI yeni bir `artifacts/` klasörüne `report.json`, doğrulama tamamlandıysa `capsule.json` ve `REPRODUCE.md` yazar. Var olan dosyaların üzerine yazmaz. Eksik veya belirsiz çalışmada çıkış kodu 2 olur; doğrulanmış gibi kapsül üretilmez.

Sunucu yalnızca loopback adresini dinler. Port için `REPROPACK_PORT`, veri klasörü için `REPROPACK_DATA_DIR` ortam değişkenleri kullanılabilir. `.env.example` açıklama içindir; `.env` dosyası otomatik okunmaz.

## Hata ölçütü ve rapor

[Örnek kapsüldeki](examples/cart-discount.json) `oracle.failure` ve `oracle.success` alanları JSON Pointer yollarını tam JSON değerleriyle karşılaştırır. Hata ve başarı imzaları ortak en az bir alanda çelişmelidir. Son adım ölçüttür ve silinmez.

- `fail`: Aynı hata yeniden oluştu; küçültme açısından aranan sonuçtur.
- `pass`: Tanımlanan beklenen başarı gözlendi.
- `unresolved`: Kurulum hatası, başka yanıt, ağ sorunu veya tutarsızlık nedeniyle sonuç belirsiz.

`finalVerified`, kalan senaryonun taze denemelerde aynı hatayı verdiğini gösterir. `oneMinimal` için ayrıca her tek-adım silme deneyi tutarlı biçimde `pass` vermelidir. Bunlar küresel olarak en küçük senaryoyu, uygulamanın tamamının doğruluğunu veya gelecekte hiç kararsızlık olmayacağını kanıtlamaz. Örnekte önkoşulları silmek geçersiz akış ürettiği için minimal olma durumu bilinçli olarak belirsiz raporlanır.

## Doğrulama

`npm run check`: strict TypeScript, Node testleri ve arayüz derlemesi. Gerçek loopback HTTP deneyleri; aynı hatayı koruma, kararsız başlangıç, çalışma sınırları, iptal, girdi doğrulama, origin/Host kontrolleri, kalıcılık ve yarım kalan işleri kurtarma sınanır.

Test ortamının geçici loopback portlarına bağlanabilmesi gerekir. Kısıtlı sandbox bunu `EACCES` ile engelleyebilir; bu durumda entegrasyon doğrulanmış sayılmaz. Tarayıcı testi için [katkı belgesine](CONTRIBUTING.md) bak.

## Henüz bulunmayanlar

İstek alımı çevrimdışı HAR içe aktarma ile yapılır; canlı üretim kaydedicisi yoktur. Yerel uygulama kodu ve şema/seed SQL'i güvenilir olmalıdır. Docker modu açıkça seçilir ve altyapı yoksa çalışmaz; Windows/WSL 2 üzerinde gerçek Linux motoruyla doğrulandı. Maskeleme tam anonimlik garantilemez, alan kuralları ve inceleme gerekir. Snapshot geçicidir; indirilen kapsül aynı uygulama/snapshot girdilerini gerektirir. Kullanıcı/ekip yetkilendirmesi alfa 0.4 içinde eklendi. SMTP hesap kurtarma alfa 0.6 içinde eklendi. Ajan bağlantıları ve MFA sonraki işlerdir; yayın durumu yol haritasında belirtilir. Varsayılan sunucu yerel kalır.

Claude Code/Codex geliştirici eklentisi **ayrı ürün** olarak ele alınır; bu projede eklenti manifesti veya hook yoktur. Ticari Discord botunun kodu ve özel verileri bu projenin dışındadır.

## Lisans

[MIT](LICENSE).
