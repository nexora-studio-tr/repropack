# Source publication / Kaynak yayını

The repository target is `shadow2028-blip/repropack`, public and MIT licensed. Only ReproPack's explicit source allowlist may be uploaded. Do not initialize, stage or push the surrounding multi-project workspace.

## Prepare and verify

```sh
npm ci
npm run check
npm run test:browser
npm run release:check
npm run release:package
npm run release:prepare
```

`release:prepare` makes a **new** `artifacts/github/repropack-VERSION/source` directory and a sibling manifest with paths, SHA-256 values and the target repository. It refuses an existing staging directory or source changes during copying. It does not upload, modify Git configuration or include runtime databases, keys, application data, commercial siblings, `node_modules` or generated artifacts. Review the staged source and its manifest before publishing.

The normal CI checks Windows/Linux, browsers, real Docker isolation and container deployment. Actions are pinned to exact commits, checkout does not persist credentials, validation has read-only repository access and dependency auditing is included. Remote green checks must be observed after upload; local reports are separate evidence.

A `vVERSION` tag runs the reusable CI workflow before the release job creates a GitHub **prerelease** with the source archive and checksum. The tag must exactly match package.json. The application is deliberately `private:true` in npm; GitHub publication does not publish an npm package.

## Demo and pilot

`render.yaml` provisions the restricted synthetic demo on a Free Render service with its assigned HTTPS origin. The deploy link in the README requires a Render account and a public source repository. Free services may sleep, restart and lose local data; visitor workspaces are disposable by design. This is separate from private Compose storage. A configured Blueprint is not proof of a live deployment.

Enable private vulnerability reporting in the GitHub repository before inviting external users. Use [the pilot guide](PILOT.md) and the voluntary feedback issue form; no external user results are fabricated.

## Türkçe

`npm run release:prepare` yalnızca ReproPack kaynaklarından yeni bir hazırlık klasörü ve SHA-256 manifesti oluşturur. Üstteki çok projeli depoyu başlatmaz, stage etmez veya göndermez. Ticari Discord botları, özel veri, anahtarlar ve çalışma zamanı dosyaları kapsama girmez.

GitHub yüklemesinden sonra gerçek CI sonucu ayrıca kontrol edilmelidir. `vVERSION` etiketi tam kontrolleri geçtikten sonra alfa sürümünü arşiv ve sağlama toplamıyla yayımlar. npm paketi yayımlanmaz. Render bağlantısı ücretsiz, sentetik bir demo içindir; hesap ve açık kaynak deposu gerekir. Hazır yapılandırma canlı dağıtım anlamına gelmez. Dış kullanıcıları davet etmeden önce GitHub özel güvenlik bildirimi özelliğini aç ve pilot yönergesini kullan.
