# Retained-step evidence / Kalan adımların kanıtı

## English

Alpha.2 explains why each step remains after reduction. It reuses the existing fresh single-deletion certification trials; it adds no extra replays and does not change the reduction algorithm or budgets.

| Status | Observation |
| --- | --- |
| `anchor` | The oracle request is protected by the scenario definition. It is not removed or proven necessary by a deletion trial. |
| `necessary` | Both fresh replays without this step returned the expected success, so that exact failure was lost. This is evidence within the retained, anchored scenario. |
| `unresolved` | Invalid, uncertain or mixed deletion results cannot prove necessity. |
| `removable` | Both fresh deletions still reproduced the failure; oracle drift makes the result inconclusive. |
| `unchecked` | Certification was not reached or did not finish. Any completed observations are retained without declaring necessity. |

`deletionWitnesses` follows `reducedStepIds` in order. Each witness has `stepId`, `status`, `trialNumbers` and `outcomes`. Trial references point to `events` with phase `minimality`, matching `omittedStepId` and the retained sequence minus that step. Earlier baseline/reduction trials are not silently reused as fresh certification. Two observed results do not certify the whole run when cancellation or a deadline interrupted processing.

The web workbench shows **Why these steps remain** in English/Turkish. Open a row's trial disclosure for actual IDs/outcomes. A report from an earlier version shows an explicit missing-witness notice; it is not upgraded into invented evidence.

Evidence JSON can now be downloaded after a partial reduction, with its actual `status`, `finalVerified` and `oneMinimal` values intact. Team authorization is unchanged. A partial report is not a replayable capsule: the capsule endpoint remains locked unless the reduction completed and freshly preserved the failure. The CLI already saves partial `report.json` without a `capsule.json`; it now includes the same witnesses.

One-minimality is conditional on the fixed oracle anchor and these observed replays. It does not prove the globally smallest scenario, deterministic behavior forever, or causation in a production system. Unresolved deletions remain unresolved; a smaller invalid scenario is not the same bug.

## Türkçe

Alpha.2, küçültme sonunda kalan her adımın neden tutulduğunu gösterir. Mevcut taze silme denemeleri kullanılır; ek tekrar denemesi, farklı algoritma veya yeni bütçe eklenmez.

Panelde **Bu adımlar neden kaldı?** bölümünü aç. `necessary`, adım silinince iki taze denemede beklenen başarının gözlendiğini belirtir. `unresolved`, geçersiz/belirsiz veya karışık sonuçtur; gereklilik kanıtı sayılmaz. `removable`, silmeye rağmen aynı hatanın iki kez sürdüğünü ve ölçütün değişmiş olabileceğini gösterir. `unchecked`, kontrolün başlamadığını veya bitmediğini söyler; tamamlanan tekil gözlemler yine korunur. `anchor`, sabit hata ölçütüdür; silinerek sınanmaz.

JSON'daki `deletionWitnesses`, kalan adımlarla aynı sıradadır. `trialNumbers` ve `outcomes`, gerçek `minimality` olaylarına bağlanır; `omittedStepId` hangi adımın çıkarıldığını belirtir. Eski raporlarda eksik kanıt açıkça gösterilir; geçmişe dönük kanıt uydurulmaz.

Kısmi küçültme için Kanıt JSON indirilebilir. Durum ve doğrulama bayrakları korunur, ekip yetkileri değişmez. Kısmi rapor tekrarlanabilir kapsül değildir; tamamlanmış ve taze doğrulanmış sonuç dışında kapsül indirme kapalıdır. CLI aynı bilgileri `report.json` içine yazar; yarım işlemde `capsule.json` üretmez.

Minimal olma, sabit ölçüte ve gözlenen denemelere bağlıdır. Tüm olası senaryoların en küçüğü olunduğunu, gelecekte hep aynı sonucu veya üretim ortamındaki nedenselliği kanıtlamaz.
