# PostgreSQL application adapter / PostgreSQL uygulama adaptörü

## English

`npm run demo:postgres` runs a real separate Node application and a private native PostgreSQL cluster. It creates no service and changes no existing cluster. The included module/schema/seed/config are in `examples/postgres-app/`. A normal `npm ci` installs the pinned platform binaries; PostgreSQL requires a non-root operating system user. ReproPack never creates one for you.

For your own **trusted** application, create a configuration in its project directory. The configuration is explicitly selected with CLI `--config` or the server's `REPROPACK_APP_CONFIG` environment variable. The server also requires `REPROPACK_APP_TEAM_ID` to bind this registration to one existing team; see [AUTH.md](AUTH.md). Capsules and API requests cannot register executable files.

```json
{
  "id": "my-app",
  "module": "./repropack-app.ts",
  "fixedModule": "./repropack-fixed.ts",
  "schema": "./test-schema.sql",
  "sourceUrlEnv": "MY_APP_READONLY_DATABASE_URL",
  "snapshot": {
    "id": "order-42",
    "tables": ["public.customers", "public.orders", "public.order_items"],
    "roots": [{ "table": "public.orders", "where": { "id": 42 } }],
    "childrenOf": ["public.orders"],
    "maxRows": 200,
    "redact": [{ "table": "public.customers", "column": "email", "kind": "email" }]
  }
}
```

Use a local `seed` SQL file instead of `sourceUrlEnv` for synthetic/test data. The two options are mutually exclusive. Schema and seed SQL run only in ReproPack-owned databases as a non-superuser owner role. An explicitly selected external source is accessed only by the read-only snapshot transaction. Prefer a read-only source login as an additional restriction.

All referenced files must resolve inside the configuration directory. The factory contract is:

```ts
export async function createApplication({ databaseUrl }: { databaseUrl: string }) {
  // Connect your app to this URL. Do not run migrations here.
  return { server, async dispose() { /* close your database pools */ } };
}
```

Return a Node HTTP server that is not already listening. ReproPack binds it to a fresh loopback port inside a new Node process on every trial. The worker receives only selected OS environment variables and its own restricted database URL over IPC. Prepare schema via the configuration, not inside the application factory: application logins have DML/sequence privileges, not schema creation, superuser, role creation or database creation privileges.

V2 capsules specify `adapter: "node-http-postgres"`, `application: "my-app"`, `snapshot: "order-42"`. Use a separately reviewed `fixedModule` for before/after comparison; it is optional. Entry module hashes are pinned when configuration is loaded, not transitive dependency/build hashes. Restart after changing code or schema/configuration.

### Snapshot semantics

- A repeatable-read, read-only transaction selects roots and their transitive FK parents. Descendants are traversed only from tables in `childrenOf`, preventing a selected customer's other orders from being swept in automatically.
- Composite keys and deferrable FK cycles are supported. Constraints and triggers are never disabled during import. Non-deferrable cross-table cycles fail closed.
- Only ordinary tables with an insertable primary key, at most 64 insertable columns, and no RLS are supported. Views, partitioned tables and generated primary keys are rejected. Table names use lower-case `schema.table` identifiers.
- Every referenced parent table must be allowlisted. Limits: 20 tables, 1000 total rows, 2 MiB of collected row JSON; queries have statement/lock timeouts. Byte limits are checked after rows are fetched, not a hard process-memory quota.
- Configured non-key TEXT fields are replaced by per-snapshot HMAC pseudonyms. PK/FK redaction and arbitrary type transformations are unsupported. Other private fields remain unchanged unless explicitly configured; this is not complete anonymization.
- Import preserves exact bigint/numeric strings, bytea and JSON. Identity sequences are advanced from selected rows. Default/trigger/schema behavior is whatever your trusted schema declares; the adapter does not reconstruct a schema from production.
- All trial connections are closed before their database and login role are dropped. A frozen template is cloned only without active sessions, following [PostgreSQL template database rules](https://www.postgresql.org/docs/18/manage-ag-templatedbs.html).

Snapshots are cached for the current registry lifetime. A server restart requires a fresh reduction before a fix can be checked against a new snapshot. Exported JSON contains the capsule and hash/count evidence, not raw database rows or application source. Reproduction therefore needs the registered application and the corresponding snapshot inputs. Durable portable database bundles are not implemented.

Default native mode does not sandbox malicious JavaScript or protect host files/network access. Only run trusted code natively. Independent supervisors now clean up after a workbench crash. For explicit Docker execution, limits, trust boundaries and the real Linux validation passed locally on Windows/WSL 2, see [SANDBOX.md](SANDBOX.md). Remote CI has not run.

## Türkçe

`npm run demo:postgres`, ayrı Node süreci ve gerçek PostgreSQL ile örneği çalıştırır. Docker veya sistem servisi kurmaz. Kendi uygulaman için proje klasöründe yapılandırma oluştur; CLI'da `--config`, sunucuda `REPROPACK_APP_CONFIG` ile açıkça seç. Sunucuda ayrıca mevcut ekip kimliğiyle `REPROPACK_APP_TEAM_ID` tanımla; kayıt yalnızca o ekibe açılır. API üzerinden dosya veya çalıştırılabilir modül tanımlanamaz.

`module`, `schema`, isteğe bağlı `seed` ve `fixedModule` yolları yapılandırma klasörünün içinde kalmalıdır. Factory, henüz dinlemeye başlamamış bir Node HTTP sunucusu ve bağlantıları kapatan `dispose()` döndürür. Uygulama sadece kendisine verilen `databaseUrl` kullanır; çalışma sırasında migration yapmaz. Her denemede süreç ve veritabanı yenilenir. Uygulama rolü superuser değildir; şema, rol ve veritabanı oluşturamaz, diğer veritabanlarına bağlanamaz.

Gerçek test kaynağı için `sourceUrlEnv` ile ortam değişkeni adı tanımla; URL/parolayı kapsüle yazma. Kaynak yalnızca salt okunur, repeatable-read transaction ile okunur. Alternatif olarak `seed` dosyasıyla sentetik veri kullan. Şema ve seed SQL'i yalnızca ReproPack'in oluşturduğu veritabanlarında çalışır.

Seçilen kökün gerekli FK üst kayıtları otomatik eklenir. Alt kayıtlar sadece `childrenOf` kapsamında alınır. Bileşik anahtarlar ve ertelenebilir döngüler desteklenir; constraint/trigger kapatılmaz. RLS, view/partition ve ertelenemeyen çapraz tablo döngüleri açık hata ile reddedilir. Kayıt ve bayt sınırları vardır; bunlar işletim sistemi kaynak kotası değildir.

Maskeleme yalnızca açıkça belirtilmiş anahtar olmayan TEXT alanlarına uygulanır. Diğer özel alanlar kendiliğinden anonimleşmez. Snapshot mevcut registry ömrü boyunca dondurulur; yeniden başlatmada yeni küçültme gerekir. Dışa aktarılan rapor hash ve sayıları içerir, ham veriyi veya uygulama kodunu içermez. Kapsülün yeniden çalışması aynı uygulama/snapshot girdilerini gerektirir.

Varsayılan yerel mod güvenilir uygulamalar içindir; ayrı süreç OS sandbox değildir. Bağımsız gözetmenle Windows çökme temizliği doğrulandı. Açık Docker seçimi, sert kotalar ve Windows/WSL 2 üzerinde geçen gerçek Linux testleri için [SANDBOX.md](SANDBOX.md) belgesine bak. Uzak CI henüz çalıştırılmadı. RLS, partition ve tablo kalıtımı snapshot kapsamını genişletmemek için reddedilir.
