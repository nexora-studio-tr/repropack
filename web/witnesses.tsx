import type { Reduction } from '../src/core/minimize.ts';

export function DeletionEvidence({ report, language }: { report: Reduction; language: 'en' | 'tr' }) {
  const t = (en: string, tr: string) => language === 'en' ? en : tr;
  const labels = {
    anchor: t('Protected oracle anchor', 'Korunan hata ölçütü'),
    necessary: t('Deleting lost the failure twice', 'Silince hata iki kez kayboldu'),
    unresolved: t('Deletion was inconclusive', 'Silme sonucu belirsiz'),
    removable: t('Deletion still reproduced the failure', 'Silince aynı hata devam etti'),
    unchecked: t('Check not completed', 'Kontrol tamamlanmadı'),
  };
  const outcomes = { pass: t('Expected success', 'Beklenen başarı'), fail: t('Same failure', 'Aynı hata'), unresolved: t('Inconclusive', 'Belirsiz') };
  return <section className="evidence-panel deletion-evidence" aria-label={t('Retained-step evidence', 'Kalan adımların kanıtı')}>
    <div className="evidence-heading"><h2>{t('Why these steps remain', 'Bu adımlar neden kaldı?')}</h2></div>
    <p className="witness-scope">{t('Two fresh deletion replays can show why a step remained in this anchored scenario. The oracle anchor is fixed, not tested for removal. This does not prove a globally smallest scenario.', 'İki taze silme denemesi, adımın bu sabit ölçütlü senaryoda neden kaldığını gösterebilir. Hata ölçütü sabittir; silinerek sınanmaz. Bu, tüm olası senaryoların en küçüğü olduğunu kanıtlamaz.')}</p>
    {report.deletionWitnesses ? <div className="table-scroll"><table><thead><tr><th>{t('Retained step', 'Kalan adım')}</th><th>{t('Deletion evidence', 'Silme kanıtı')}</th><th>{t('Fresh trials', 'Taze denemeler')}</th></tr></thead><tbody>{report.deletionWitnesses.map(witness => <tr key={witness.stepId}>
      <td><code>{witness.stepId}</code></td><td>{labels[witness.status]}</td><td>{witness.trialNumbers.length ? <details className="trial-detail"><summary>{witness.trialNumbers.length} {t('trials', 'deneme')} +</summary><ul>{witness.trialNumbers.map((number, i) => <li key={number}>#{number} · {outcomes[witness.outcomes[i]!]}</li>)}</ul></details> : <span>{witness.status === 'anchor' ? t('Excluded by design', 'Tasarım gereği hariç') : t('No completed trials', 'Tamamlanan deneme yok')}</span>}</td>
    </tr>)}</tbody></table></div> : <p className="witness-scope">{t('This older report has no per-step witnesses. Run a new reduction to collect them.', 'Bu eski raporda adım bazında kanıt yok. Toplamak için yeni bir küçültme çalıştır.')}</p>}
    {report.status !== 'completed' && <p className="witness-scope partial-evidence">{t('Partial evidence. Unfinished checks remain unchecked; no reproduction capsule is available.', 'Kısmi kanıt. Bitmeyen kontroller tamamlanmamış görünür; tekrarlanabilir kapsül indirilemez.')}</p>}
  </section>;
}
