# Reviewed HAR import / İncelemeli HAR içe aktarma

## English

Request capture intake is **offline HAR import**. It never connects to the origin in the file. No browser hook, live proxy or production recorder is installed. Use a small, sequential API trace and a base capsule with your independently defined failure/success oracle.

```sh
node src/cli.ts import-har examples/cart-session.har.json --origin http://127.0.0.1:9000 --base examples/postgres-cart.json --out artifacts/capture-example
```

The result is `capture-draft.json`, not a replayable capsule. Only entries from the explicitly selected origin are included. GET responses other than JSON are skipped and counted; non-JSON mutations are rejected. JSON request bodies up to 64 KiB are supported. All request headers and response bodies are discarded. Common credential-like JSON keys and query parameters are masked. Additional body JSON Pointers can be supplied with `--redact /customer/email,/contact/phone`.

Inspect the entire draft, including URL path segments, ordinary query parameters, free text, oracle and any unrecognized private fields. Masking is heuristic and can change application behavior; it does not establish anonymization or reproducibility. The last imported request becomes the oracle step. Recorded request order is replayed sequentially; concurrent timing is not preserved. The base capsule's explicit oracle remains authoritative.

After inspection, use the hash printed by the command:

```sh
node src/cli.ts approve-capture artifacts/capture-example/capture-draft.json --sha256 <reviewed-sha256>
node src/cli.ts reduce artifacts/capture-example/capsule.reviewed.json
```

Approval checks that the semantic capsule/summary still match the reviewed hash, then creates `capsule.reviewed.json` and `review-receipt.json`. It runs no requests and performs no upload. Existing files are not overwritten. A changed draft needs a newly generated/reviewed hash. The receipt records explicit local review, not reviewer identity, authorization or proof of complete masking.

The workbench rejects draft objects. Import the reviewed capsule through **Capsule source → Import JSON**. A raw manually created capsule remains a local operator input; this workflow is not an access-control system.

The original HAR remains wherever you stored it. It may contain secrets even when the exported draft does not. ReproPack does not copy it into the output bundle.

## Türkçe

İstek alımı çevrimdışı HAR dosyasıyla yapılır; dosyadaki adrese bağlanılmaz. Canlı proxy, tarayıcı hook'u veya üretim kaydedicisi kurulmaz. Küçük, sıralı bir API akışı ve hata/başarı ölçütünü önceden tanımladığın kapsül kullan.

Yukarıdaki `import-har` komutu sadece seçilen origin'e ait JSON isteklerini alır. Tüm istek başlıkları ve yanıt gövdeleri atılır. Bilinen sır benzeri gövde alanları ve query parametreleri maskelenir. Ek alanları `--redact /customer/email,/contact/phone` ile belirt. JSON olmayan GET yanıtları sayılarak atlanır; JSON olmayan mutasyonlar reddedilir.

Çıktı, çalıştırılabilir kapsül yerine `capture-draft.json` taslağıdır. URL yollarını, query parametrelerini, serbest metni ve ölçütü tek tek incele. Maskeleme anonimlik veya aynı hatanın tekrarını garanti etmez; davranışı değiştirebilir. Son istek ölçüt adımı olur. Eşzamanlılık/zamanlama korunmaz; sıralı tekrar yapılır.

İnceledikten sonra komutun verdiği SHA-256 ile `approve-capture` çalıştır. İncelenen semantik kapsül değiştiyse onay reddedilir. `capsule.reviewed.json` ve yerel inceleme makbuzu üretilir; istek gönderilmez veya veri yayınlanmaz. Var olan dosyaların üzerine yazılmaz. Makbuz kimlik/yetki doğrulaması değildir.

Arayüze taslağı değil, `capsule.reviewed.json` dosyasını yükle. Ham HAR orijinal konumunda durur ve sır içerebilir; dışa aktarılan klasöre kopyalanmaz.
