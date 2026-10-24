import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Capsule } from '../src/core/model.ts';
import type { Run, FixVerification } from '../src/store.ts';
import type { SessionView } from '../src/auth.ts';
import { AccessGate, AccountPanel, IdentityBar, loadingText } from './identity.tsx';
import { AccountLinkPage, EmailVerificationGate } from './security.tsx';
import type { AccountLink } from './security.tsx';
import { DemoBar, DemoWelcome } from './demo.tsx';
import './app.css';

const words = {
  en: {
    workspace: 'REPRODUCTION WORKSPACE', local: 'LOCAL ALPHA', history: 'Recent runs', noHistory: 'Your first reproduction starts here.',
    localNote: 'Stored on this machine. No cloud connection.', newRun: 'New reproduction', eyebrow: 'LESS NOISE. SAME FAILURE.',
    title1: 'Make the failure', title2: 'easier to understand.', intro: 'Keep what causes the bug. Remove what gets in the way. Every reduction comes with the evidence behind it.',
    isolated: 'Disposable HTTP demo', isolatedDetail: 'Each trial starts with a fresh cart. No production capture or external targets.',
    nativeMode: 'Trusted local execution', nativeNote: 'Application code runs with your OS permissions.', dockerMode: 'Docker sandbox configured', dockerNote: 'External network disabled; memory, CPU, process and time quotas enforced by the runtime. Fresh containers can take up to 5 minutes per reduction.', execution: 'Execution boundary',
    postgres: 'Node.js + PostgreSQL', postgresDetail: 'Fresh process and database clone per trial. Selected rows only; configured text fields masked locally.', adapterLabel: 'Application', snapshot: 'Snapshot evidence', rows: 'selected rows', masked: 'masked fields', postgresFix: 'Check configured fix', postgresFixNote: 'Runs the registered fixed module against the same frozen snapshot.', postgresFixPassed: 'Configured fix: expected success observed in 3 fresh trials.',
    reduce: 'Reduce scenario', reducing: 'Reducing…', cancel: 'Cancel run', export: 'Export capsule', evidence: 'Evidence JSON', verify: 'Check demo fix', verifying: 'Checking…', readOnly: 'Read-only access',
    original: 'Original steps', retained: 'Retained steps', trials: 'Replay trials', result: 'Failure preserved', yes: 'Verified', no: 'Not checked',
    scenario: '01 / SCENARIO', flow: 'The path to the failure', originalTag: 'Original', reducedTag: 'Retained', removed: 'removed',
    signature: '02 / ORACLE', expectation: 'Two explicit outcomes.', failure: 'Original failure', success: 'Expected success',
    signatureNote: 'Other errors and unexpected responses are inconclusive. They never count as the same bug or as a verified fix.',
    engine: '03 / EVIDENCE', observations: 'What the engine observed', empty: 'Start a reduction to inspect actual replay evidence.', trial: 'TRIAL', phase: 'PHASE', size: 'STEPS', verdict: 'OUTCOME',
    latest: 'Latest 10 completed trials', details: 'Inspect', preserved: 'Exact failure preserved in fresh replays.',
    minimal: 'Single-deletion minimality verified.', uncertain: 'Minimality is inconclusive; invalid deletions are listed in the evidence.',
    fixPassed: 'Built-in demo fix: expected success observed in 3 fresh trials.', fixFailed: 'The built-in demo fix did not pass consistently.',
    fixNote: 'This checks the included patched fixture, not a change to your application.', source: 'Capsule source', sourceNote: 'Edit or import a schema v1/v2 capsule. PostgreSQL applications must be registered locally. Review HAR drafts before importing.', import: 'Import JSON',
    error: 'Something needs attention', dismiss: 'Dismiss', loading: 'Loading reproduction…', budget: 'Replay budget', footer: 'Failure-preserving reduction. Evidence before confidence.',
    status: { queued: 'Queued', running: 'Running', completed: 'Reduced', budget_exhausted: 'Budget reached', inconclusive: 'Inconclusive', cancelled: 'Cancelled', failed: 'Failed', interrupted: 'Interrupted' },
    phases: { baseline: 'Baseline', reduce: 'Reduction', verify: 'Fresh verification', minimality: 'Deletion check' },
    verdicts: { fail: 'SAME FAILURE', pass: 'EXPECTED SUCCESS', unresolved: 'INCONCLUSIVE' },
  },
  tr: {
    workspace: 'HATA TEKRARLAMA ATÖLYESİ', local: 'YEREL ALFA', history: 'Son çalıştırmalar', noHistory: 'İlk hata senaryon burada başlayacak.',
    localNote: 'Bu bilgisayarda saklanır. Bulut bağlantısı yok.', newRun: 'Yeni çalıştırma', eyebrow: 'DAHA AZ GÜRÜLTÜ. AYNI HATA.',
    title1: 'Hatayı anlamayı', title2: 'kolaylaştır.', intro: 'Hataya neden olan adımlar kalsın. Gereksiz olanlar elensin. Her küçültme, arkasındaki deneylerin kanıtını taşır.',
    isolated: 'Temiz HTTP demosu', isolatedDetail: 'Her denemede temiz sepet açılır. Üretim kaydı veya harici hedef desteği yok.',
    nativeMode: 'Güvenilir yerel çalıştırma', nativeNote: 'Uygulama kodu işletim sistemi izinlerinle çalışır.', dockerMode: 'Docker sandbox yapılandırıldı', dockerNote: 'Dış ağ kapalıdır; bellek, CPU, süreç ve süre kotaları çalışma ortamında uygulanır. Yeni konteynerlerle küçültme 5 dakikaya kadar sürebilir.', execution: 'Çalıştırma sınırı',
    postgres: 'Node.js + PostgreSQL', postgresDetail: 'Her denemede yeni süreç ve veritabanı kopyası. Seçili kayıtlar alınır; belirtilen metin alanları yerelde maskelenir.', adapterLabel: 'Uygulama', snapshot: 'Snapshot kanıtı', rows: 'seçili kayıt', masked: 'maskelenmiş alan', postgresFix: 'Tanımlı düzeltmeyi sına', postgresFixNote: 'Tanımlanan düzeltilmiş modülü aynı dondurulmuş snapshot ile çalıştırır.', postgresFixPassed: 'Tanımlı düzeltme: 3 taze denemede beklenen başarı gözlendi.',
    reduce: 'Senaryoyu küçült', reducing: 'Küçültülüyor…', cancel: 'İptal et', export: 'Kapsülü indir', evidence: 'Kanıt JSON', verify: 'Demo düzeltmesini sına', verifying: 'Sınanıyor…', readOnly: 'Salt okunur erişim',
    original: 'Başlangıç adımı', retained: 'Kalan adım', trials: 'Tekrar denemesi', result: 'Hata korundu mu?', yes: 'Doğrulandı', no: 'Doğrulanmadı',
    scenario: '01 / SENARYO', flow: 'Hataya giden yol', originalTag: 'Başlangıç', reducedTag: 'Kalan', removed: 'elendi',
    signature: '02 / HATA ÖLÇÜTÜ', expectation: 'İki açık sonuç.', failure: 'Asıl hata', success: 'Beklenen başarı',
    signatureNote: 'Başka hatalar ve beklenmeyen yanıtlar belirsiz sayılır. Aynı hata veya doğrulanmış düzeltme olarak kabul edilmez.',
    engine: '03 / KANIT', observations: 'Motorun gözlemledikleri', empty: 'Gerçek denemeleri görmek için küçültmeyi başlat.', trial: 'DENEY', phase: 'AŞAMA', size: 'ADIM', verdict: 'SONUÇ',
    latest: 'Tamamlanan son 10 deneme', details: 'İncele', preserved: 'Aynı hata, taze denemelerde yeniden oluştu.',
    minimal: 'Tek adım silme ile minimal olma doğrulandı.', uncertain: 'En küçük olma durumu belirsiz; geçersiz silmeler kanıtlarda yer alır.',
    fixPassed: 'Dahili demo düzeltmesi: 3 taze denemede beklenen başarı gözlendi.', fixFailed: 'Dahili demo düzeltmesi tutarlı biçimde geçmedi.',
    fixNote: 'Bu işlem kendi uygulamanı değil, dahil edilen düzeltilmiş demoyu sınar.', source: 'Kapsül kaynağı', sourceNote: 'Şema v1/v2 kapsülünü düzenle veya içe aktar. PostgreSQL uygulaması yerelde tanımlanmış olmalı. HAR taslağını önce incele.', import: 'JSON içe aktar',
    error: 'Bir sorun oluştu', dismiss: 'Kapat', loading: 'Çalıştırma yükleniyor…', budget: 'Deneme sınırı', footer: 'Hatayı koruyan küçültme. Önce kanıt, sonra güven.',
    status: { queued: 'Sırada', running: 'Çalışıyor', completed: 'Küçültüldü', budget_exhausted: 'Sınıra ulaşıldı', inconclusive: 'Belirsiz', cancelled: 'İptal edildi', failed: 'Başarısız', interrupted: 'Yarıda kaldı' },
    phases: { baseline: 'Başlangıç', reduce: 'Küçültme', verify: 'Taze doğrulama', minimality: 'Silme kontrolü' },
    verdicts: { fail: 'AYNI HATA', pass: 'BEKLENEN BAŞARI', unresolved: 'BELİRSİZ' },
  },
} as const;
type Language = keyof typeof words;
interface History { id: string; title: string; status: Run['status']; createdAt: string; originalSteps: number; reducedSteps: number | null }
const isActive = (run?: Run) => run?.status === 'running' || run?.status === 'queued';
let sessionCsrf = '';
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'content-type': 'application/json', 'x-repropack-local': '1', 'x-repropack-csrf': sessionCsrf, ...options.headers } });
  const result: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event('repropack-session-expired'));
    throw new Error((result as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  return result as T;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
function Workbench({ session, language, setLanguage, onReady }: { session: SessionView; language: Language; setLanguage: (language: Language) => void; onReady: () => Promise<void> }) {
  const t = words[language];
  const [accountOpen, setAccountOpen] = useState(false);
  const writable = session.team?.role !== 'viewer';
  const [demo, setDemo] = useState<Capsule>();
  const [source, setSource] = useState('');
  const [history, setHistory] = useState<History[]>([]);
  const [selected, setSelected] = useState<string>();
  const [run, setRun] = useState<Run>();
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [budget, setBudget] = useState(160);
  const [runtimeModes, setRuntimeModes] = useState<Record<string, 'trusted-native' | 'docker'>>({});
  const runtime = runtimeModes[demo?.application ?? ''];
  const executionMode = run?.environment ? run.environment.execution?.kind ?? 'trusted-native' : runtime;
  const fileInput = useRef<HTMLInputElement>(null);
  const refreshHistory = () => api<History[]>('/api/runs').then(setHistory);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<Capsule>('/api/example', { signal: controller.signal }).then(capsule => { setDemo(capsule); setSource(JSON.stringify(capsule, null, 2)); }),
      api<History[]>('/api/runs', { signal: controller.signal }).then(setHistory),
      api<{ applications: Record<string, 'trusted-native' | 'docker'> }>('/api/runtime', { signal: controller.signal }).then(value => setRuntimeModes(value.applications)),
    ]).catch(error => { if (!controller.signal.aborted) setMessage(errorMessage(error)); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
    try { localStorage.setItem('repropack-language', language); } catch { /* Storage is optional. */ }
  }, [language]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let firstResponse = true;
    setLoading(true);
    async function poll() {
      try {
        const next = await api<Run>(`/api/runs/${selected}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (firstResponse) { setDemo(next.source); setSource(JSON.stringify(next.source, null, 2)); firstResponse = false; }
        setRun(next); setLoading(false);
        if (isActive(next)) timer = setTimeout(() => { void poll(); }, 400);
        else await refreshHistory();
      } catch (error) { if (!controller.signal.aborted) { setMessage(errorMessage(error)); setLoading(false); } }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selected]);
  const capsule = run?.source ?? demo;
  const postgres = capsule?.adapter === 'node-http-postgres';
  const report = run?.report;
  const events = run?.events ?? [];
  const retained = report ? new Set(report.reducedStepIds) : null;
  const running = isActive(run);
  const exportable = report?.status === 'completed' && report.finalVerified;
  async function start() {
    setSubmitting(true); setMessage('');
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(source); } catch { throw new Error(language === 'tr' ? 'Kapsül geçerli JSON olmalı.' : 'The capsule must be valid JSON.'); }
      const next = await api<{ id: string }>('/api/runs', { method: 'POST', body: JSON.stringify({ capsule: parsed, maxTrials: budget }) });
      setRun(undefined); setSelected(next.id); setLoading(true); await refreshHistory();
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setSubmitting(false); }
  }
  async function cancel() {
    if (!run) return;
    try { await api(`/api/runs/${run.id}/cancel`, { method: 'POST' }); }
    catch (error) { setMessage(errorMessage(error)); }
  }
  async function verify() {
    if (!run) return;
    setVerifying(true); const id = run.id;
    try {
      const verification = await api<FixVerification>(`/api/runs/${id}/verify`, { method: 'POST' });
      setRun(previous => previous?.id === id ? { ...previous, verification } : previous);
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setVerifying(false); }
  }
  function reset() {
    setSelected(undefined); setRun(undefined); setLoading(false); setMessage('');
    if (demo) setSource(JSON.stringify(demo, null, 2));
  }
  async function changeAdapter(value: string) {
    setLoading(true); setMessage(''); setRun(undefined); setSelected(undefined);
    try {
      const next = await api<Capsule>(value === 'postgres' ? '/api/examples/postgres' : '/api/example');
      setDemo(next); setSource(JSON.stringify(next, null, 2));
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setLoading(false); }
  }
  return <div className="workspace">
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="ReproPack home"><span className="brand-mark" aria-hidden="true">[<b>r</b>]</span>repropack<span className="alpha">α</span></a>
      <div className="sidebar-label">WORKBENCH / 001</div>
      <button className="new-run" onClick={reset}><span aria-hidden="true">＋</span>{t.newRun}</button>
      <div className="history-heading">{t.history}<span>{history.length.toString().padStart(2, '0')}</span></div>
      <nav className="history" aria-label={t.history}>
        {history.length ? history.map(item => <button key={item.id} className={`history-item ${item.id === selected ? 'selected' : ''}`} aria-current={item.id === selected ? 'true' : undefined} onClick={() => { if (selected === item.id) return; setRun(undefined); setSelected(item.id); setLoading(true); setMessage(''); }}>
          <span className="history-top"><span className={`status-dot ${item.status}`} />{t.status[item.status]}<span className="history-id">{item.id.slice(0, 6)}</span></span>
          <span className="history-title">{item.title}</span>
          <span className="history-bottom">{item.originalSteps}{item.reducedSteps !== null ? ` → ${item.reducedSteps}` : ''} · {new Intl.DateTimeFormat(language === 'tr' ? 'tr-TR' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(item.createdAt))}</span>
        </button>) : <p className="empty-history">{t.noHistory}</p>}
      </nav>
      <div className="sidebar-footer"><span className="local-dot" /> {session.demo ? 'SAMPLE WORKSPACE' : 'LOCAL ENGINE'}<span className="local-description">{session.demo ? (language === 'tr' ? 'Geçici örnek veri. Diğer ziyaretçilerden ayrı.' : 'Temporary sample data. Separate from other visitors.') : t.localNote}</span><code>v0.5.0-alpha.1</code></div>
    </aside>
    <main id="main" className="main">
      <header className="topbar"><span>{t.workspace}</span><div className="topbar-right"><span className="alpha-label">{session.demo ? "DEMO" : t.local}</span><div className="language" aria-label="Language">{(['en', 'tr'] as const).map(lang => <button key={lang} aria-pressed={language === lang} onClick={() => setLanguage(lang)}>{lang.toUpperCase()}</button>)}</div></div></header>
      {session.demo ? <DemoBar session={session} language={language} api={api} onReady={onReady} /> : <IdentityBar session={session} language={language} api={api} onReady={onReady} onAccount={() => setAccountOpen(value => !value)} />}
      {accountOpen && <AccountPanel session={session} language={language} api={api} onReady={onReady} onClose={() => setAccountOpen(false)} />}
      {!accountOpen && <><section className="hero">
        <div><p className="eyebrow"><span className="small-line" />{t.eyebrow}</p><h1>{t.title1}<br /><span>{t.title2}</span></h1><p className="intro">{t.intro}</p></div>
        <div className="hero-aside"><div className="reduction-graphic" aria-hidden="true"><span /><span /><span /><span /><span className="keep" /><span className="keep" /><span className="keep" /></div><span className="graphic-label">SIGNAL / NOISE</span></div>
      </section>
      {message && <div className="notice error" role="alert"><div><strong>{t.error}</strong><p>{message}</p></div><button onClick={() => setMessage('')}>{t.dismiss}</button></div>}
      <section className="run-toolbar" aria-label={t.isolated}>
        <div className="adapter"><span className="adapter-icon" aria-hidden="true">↳</span><div><label className="adapter-picker">{t.adapterLabel}<select aria-label={t.adapterLabel} value={postgres ? 'postgres' : 'demo'} disabled={running || submitting || loading || !demo} onChange={event => { void changeAdapter(event.target.value); }}><option value="demo">{t.isolated}</option>{!session.demo && <option value="postgres">{t.postgres}</option>}</select></label><p>{postgres ? t.postgresDetail : t.isolatedDetail}</p></div></div>
        <div className="run-controls"><label className="budget-label">{t.budget}<select value={budget} disabled={!writable || running || submitting} onChange={event => setBudget(Number(event.target.value))}><option value={80}>80</option><option value={160}>160</option>{!session.demo && <option value={300}>300</option>}</select></label>{running && writable ? <button className="button secondary" onClick={() => { void cancel(); }}>{t.cancel}</button> : <button className="button primary" disabled={!writable || !demo || submitting || loading} onClick={() => { void start(); }}>{!writable ? t.readOnly : submitting ? t.reducing : t.reduce}<span aria-hidden="true">↗</span></button>}</div>
      </section>
      <section className="metrics" aria-label="Run summary" aria-busy={loading}>
        <div><span>{t.original}</span><strong>{capsule?.steps.length ?? '—'}<small> / input</small></strong></div>
        <div><span>{t.retained}</span><strong className={report?.finalVerified ? 'accent-text' : ''}>{report?.reducedSteps ?? '—'}<small>{report ? ` / ${Math.round((1 - report.reducedSteps / report.originalSteps) * 100)}% ${t.removed}` : ' / output'}</small></strong></div>
        <div><span>{t.trials}</span><strong>{events.length.toString().padStart(2, '0')}<small> / {report?.limits.maxTrials ?? budget}</small></strong></div>
        <div><span>{t.result}</span><strong className={`text-metric ${report?.finalVerified ? 'success-text' : ''}`}>{report?.finalVerified ? t.yes : t.no}</strong><span className="run-status" aria-live="polite">{loading ? t.loading : run ? t.status[run.status] : 'READY'}</span></div>
      </section>
      <div className="inspection-grid">
        <section className="flow-panel"><div className="section-heading"><p className="eyebrow">{t.scenario}</p><div className="flow-legend"><span><i />{t.originalTag}</span><span><i className="retained" />{t.reducedTag}</span></div></div><h2>{t.flow}</h2><p className="capsule-title">{capsule?.title ?? '…'}</p>
          <ol className="steps">{capsule?.steps.map((step, index) => { const removed = retained !== null && !retained.has(step.id); const anchor = step.id === capsule.oracle.stepId; return <li key={step.id} className={`${removed ? 'removed' : 'kept'} ${anchor ? 'anchor' : ''}`}><span className="step-number">{(index + 1).toString().padStart(2, '0')}</span><div className="step-track"><span /></div><span className={`method ${step.method.toLowerCase()}`}>{step.method}</span><code>{step.path}</code><span className="step-name">{step.id}</span>{anchor && <span className="oracle-badge">ORACLE</span>}{removed && <span className="removed-mark" aria-label={t.removed}>−</span>}</li>; })}</ol>
        </section>
        <aside className="oracle-panel"><p className="eyebrow">{t.signature}</p><h2>{t.expectation}</h2><p className="oracle-intro">HTTP {capsule?.oracle.status ?? 200} · <code>{capsule?.oracle.stepId ?? 'checkout'}</code></p>
          <div className="signature failure"><div><span className="status-dot failed" />{t.failure}<span className="mono">FAIL</span></div><pre>{JSON.stringify(capsule?.oracle.failure ?? {}, null, 2)}</pre></div>
          <div className="signature success"><div><span className="status-dot completed" />{t.success}<span className="mono">PASS</span></div><pre>{JSON.stringify(capsule?.oracle.success ?? {}, null, 2)}</pre></div>
          <p className="oracle-note">{t.signatureNote}</p>
          {report && <div className={`verification-note ${report.finalVerified ? 'good' : ''}`}><strong>{report.finalVerified ? t.preserved : t.status[report.status]}</strong><p>{report.oneMinimal ? t.minimal : report.finalVerified ? t.uncertain : report.reason}</p></div>}
          {postgres && executionMode && <div className="snapshot-evidence"><strong>{t.execution}</strong><p>{executionMode === 'docker' ? t.dockerMode : t.nativeMode}</p><small>{executionMode === 'docker' ? t.dockerNote : t.nativeNote}</small>{run?.environment?.execution?.kind === 'docker' && <p>{run.environment.execution.quotas.memoryMiB} MiB · {run.environment.execution.quotas.cpus} CPU · {run.environment.execution.quotas.pids} PID · {run.environment.execution.quotas.wallMs / 1000} s</p>}</div>}
          {run?.environment?.snapshotSha256 && <div className="snapshot-evidence"><strong>{t.snapshot}</strong><p>{run.environment.totalRows} {t.rows} · {run.environment.redactedCells} {t.masked}</p>{Object.entries(run.environment.rowCounts ?? {}).map(([table, count]) => <p key={table}><code>{table}</code><span>{count}</span></p>)}<code className="snapshot-hash">SHA-256 / {run.environment.snapshotSha256}</code></div>}
          {exportable && run && <div className="export-actions"><a className="button secondary" href={`/api/runs/${run.id}/capsule`}>{t.export}<span aria-hidden="true">↓</span></a><a className="text-link" href={`/api/runs/${run.id}/report`}>{t.evidence} ↗</a></div>}
          {exportable && run?.fixAvailable !== false && <div className="fix-check"><button className="button dark" disabled={!writable || verifying} onClick={() => { void verify(); }}>{verifying ? t.verifying : postgres ? t.postgresFix : t.verify}<span aria-hidden="true">↗</span></button><p>{postgres ? t.postgresFixNote : t.fixNote}</p>{run?.verification && <p className={run.verification.passed ? 'success-text' : 'error-text'} role="status">{run.verification.passed ? postgres ? t.postgresFixPassed : t.fixPassed : t.fixFailed}</p>}</div>}
          {run?.error && <p className="error-text" role="alert">{run.error}</p>}
        </aside>
      </div>
      <section className="evidence-panel"><div className="evidence-heading"><div><p className="eyebrow">{t.engine}</p><h2>{t.observations}</h2></div><span className="subtle mono">{t.latest}</span></div>
        {events.length ? <div className="table-scroll"><table><thead><tr><th>{t.trial}</th><th>{t.phase}</th><th>{t.size}</th><th>{t.verdict}</th><th><span className="sr-only">{t.details}</span></th></tr></thead><tbody>{events.slice(-10).reverse().map(event => <tr key={event.trial}><td className="mono">{event.trial.toString().padStart(3, '0')}</td><td>{t.phases[event.phase as keyof typeof t.phases] ?? event.phase}</td><td className="mono">{event.stepIds.length}</td><td><span className={`verdict ${event.verdict}`}>{t.verdicts[event.verdict]}</span></td><td><details className="trial-detail"><summary>{t.details} +</summary><div><p>{event.reason}</p><code>{event.stepIds.join(' → ')}</code><p>{event.durationMs} ms</p></div></details></td></tr>)}</tbody></table></div> : <div className="empty-evidence"><span aria-hidden="true">[ · · · ]</span><p>{t.empty}</p></div>}
      </section>
      {!session.demo && <details className="source-editor"><summary>{t.source}<span className="mono">JSON / v{capsule?.schemaVersion ?? 1} ＋</span></summary><div className="source-content"><div className="source-heading"><label htmlFor="capsule-source">{t.sourceNote}</label><button className="button secondary small" disabled={!writable || running || submitting} onClick={() => fileInput.current?.click()}>{t.import}</button><input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 262_144) { setMessage('File exceeds 256 KiB.'); return; } void file.text().then(setSource).catch(error => setMessage(errorMessage(error))); event.target.value = ''; }} /></div><textarea id="capsule-source" spellCheck={false} value={source} readOnly={!writable} disabled={!writable || running || submitting} onChange={event => setSource(event.target.value)} /></div></details>}
      <footer className="footer"><span className="footer-brand">[r] repropack</span><span>{t.footer}</span><span className="mono">{session.demo ? "DEMO" : "LOCAL"} / {postgres ? 'POSTGRESQL' : 'HTTP'}</span></footer></>}
    </main>
  </div>;
}
function readAccountEntry() {
  const params = new URLSearchParams(location.hash.slice(1)), value = params.get('invite') ?? '';
  const kind = params.has('reset') ? 'reset' : 'verify', account = params.get(kind) ?? '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return { invite: /^[a-f0-9]{64}$/u.test(value) ? value : '', account: /^[a-f0-9]{64}$/u.test(account) ? { kind, token: account } as AccountLink : undefined };
}
function App() {
  const [language, setLanguage] = useState<Language>(() => { try { return localStorage.getItem('repropack-language') === 'tr' ? 'tr' : 'en'; } catch { return 'en'; } });
  const [session, setSession] = useState<SessionView>(); const [error, setError] = useState('');
  const [entry] = useState(readAccountEntry);
  const [inviteToken, setInviteToken] = useState(entry.invite);
  const [accountLink, setAccountLink] = useState(entry.account);
  useEffect(() => {
    const changed = () => { const next = readAccountEntry(); setInviteToken(next.invite); setAccountLink(next.account); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  async function refresh() { const view = await api<SessionView>('/api/session'); sessionCsrf = view.csrf ?? ''; setSession(view); setError(''); }
  useEffect(() => {
    void refresh().catch(error => setError(errorMessage(error)));
    const expired = () => { sessionCsrf = ''; setSession(previous => ({ setupRequired: false, ...(previous?.demo ? { demo: { ttlMinutes: previous.demo.ttlMinutes, maxOperations: previous.demo.maxOperations } } : {}) })); };
    window.addEventListener('repropack-session-expired', expired);
    return () => window.removeEventListener('repropack-session-expired', expired);
  }, []);
  useEffect(() => { document.documentElement.lang = language; try { localStorage.setItem('repropack-language', language); } catch { /* Optional preference only. */ } }, [language]);
  if (!session) return <main className="access-loading"><span className="brand-mark">[r]</span><p role="status">{loadingText(language)}</p>{error && <><p role="alert">{error}</p><button className="button secondary" onClick={() => { void refresh().catch(error => setError(errorMessage(error))); }}>↻</button></>}</main>;
  if (session.demo && !session.user) return <DemoWelcome language={language} setLanguage={setLanguage} api={api} onReady={refresh} />;
  if (!session.demo && accountLink) return <AccountLinkPage key={accountLink.kind + accountLink.token} link={accountLink} language={language} setLanguage={setLanguage} api={api} onDone={async () => { await refresh(); setAccountLink(undefined); }} />;
  if (session.user && session.email?.required && !session.email.verified) return <EmailVerificationGate session={session} language={language} setLanguage={setLanguage} api={api} onReady={refresh} />;
  if (!session.user || (!session.demo && inviteToken)) return <AccessGate session={session} language={language} setLanguage={setLanguage} api={api} inviteToken={inviteToken} clearInvite={() => setInviteToken('')} onReady={refresh} />;
  return <Workbench key={session.team?.id} session={session} language={language} setLanguage={setLanguage} onReady={refresh} />;
}
createRoot(document.getElementById('root')!).render(<App />);
