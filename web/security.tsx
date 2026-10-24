import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { SessionView } from '../src/auth.ts';
import type { Api, Language } from './identity.tsx';

const copy = {
  en: {
    title: 'Keep access in your hands.', intro: 'A private link, a clear next step.', email: 'Email', password: 'New password', repeat: 'Repeat new password', note: 'At least 15 characters. Use a unique passphrase.', forgot: 'Recover your account', request: 'Send recovery link', sent: 'If this address has an account, a recovery link will arrive shortly. Check spam too. A new request replaces the previous link.', back: 'Back to sign in', verify: 'Verify your email', confirm: 'Confirm email address', resend: 'Send verification link', verifySent: 'If your email still needs verification, a new link will arrive shortly. It replaces the previous link.', verified: 'Email verified', unverified: 'Email not verified', required: 'Confirm ownership of your email to open the workspace.', refresh: 'I have verified my email', logout: 'Sign out', done: 'Email confirmed. You can return to your workspace.', reset: 'Choose a new password', resetDone: 'Password reset. All previous sessions have been signed out. Sign in with your new password.', save: 'Reset password & sign out', mismatch: 'The passwords must match.', working: 'Working…', continue: 'Continue', configuration: 'Email verification and recovery need SMTP configuration by the instance operator. This instance keeps local password sign-in available.',
  },
  tr: {
    title: 'Hesabının kontrolü sende.', intro: 'Sana özel bağlantı, anlaşılır bir sonraki adım.', email: 'E-posta', password: 'Yeni parola', repeat: 'Yeni parolayı tekrar yaz', note: 'En az 15 karakter. Benzersiz bir parola kullan.', forgot: 'Hesabını kurtar', request: 'Kurtarma bağlantısı gönder', sent: 'Bu adresle bir hesap varsa kurtarma bağlantısı kısa süre içinde ulaşacak. Spam klasörünü de kontrol et. Yeni istek önceki bağlantıyı geçersiz kılar.', back: 'Girişe dön', verify: 'E-postanı doğrula', confirm: 'E-posta adresini doğrula', resend: 'Doğrulama bağlantısı gönder', verifySent: 'E-postan henüz doğrulanmadıysa yeni bağlantı kısa süre içinde ulaşacak. Önceki bağlantı geçersiz olur.', verified: 'E-posta doğrulandı', unverified: 'E-posta doğrulanmadı', required: 'Çalışma alanını açmak için e-posta adresini doğrula.', refresh: 'E-postamı doğruladım', logout: 'Çıkış yap', done: 'E-posta doğrulandı. Çalışma alanına dönebilirsin.', reset: 'Yeni parolanı belirle', resetDone: 'Parola sıfırlandı. Önceki tüm oturumlar kapatıldı. Yeni parolanla giriş yap.', save: 'Parolayı sıfırla ve oturumları kapat', mismatch: 'Parolalar aynı olmalı.', working: 'İşleniyor…', continue: 'Devam et', configuration: 'E-posta doğrulaması ve kurtarma için kurulumu yapan kişinin SMTP ayarlarını eklemesi gerekir. Bu kurulumda yerel parolayla giriş kullanılabilir.',
  },
};
const post = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function Frame({ language, setLanguage, title, children }: { language: Language; setLanguage: (language: Language) => void; title: string; children: ReactNode }) {
  const t = copy[language];
  return <main className="access-page"><div className="access-story"><a className="brand" href="/"><span className="brand-mark">[<b>r</b>]</span>repropack<span className="alpha">α</span></a><p className="eyebrow">ACCOUNT / SECURITY</p><h1>{t.title}</h1><p>{t.intro}</p></div><div className="access-form-wrap"><div className="language">{(['en', 'tr'] as const).map(lang => <button key={lang} aria-pressed={language === lang} onClick={() => setLanguage(lang)}>{lang.toUpperCase()}</button>)}</div><section className="access-card"><h2>{title}</h2>{children}</section></div></main>;
}
export function RecoveryRequest({ language, setLanguage, api, onBack }: { language: Language; setLanguage: (language: Language) => void; api: Api; onBack: () => void }) {
  const t = copy[language], [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError('');
    try { await api('/api/auth/password/forgot', post({ email: data.get('email') })); setSent(true); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <Frame language={language} setLanguage={setLanguage} title={t.forgot}>{error && <p className="notice error" role="alert">{error === 'passwordMismatch' ? t.mismatch : error}</p>}{sent ? <p role="status">{t.sent}</p> : <form className="identity-form" onSubmit={event => { void submit(event); }}><label>{t.email}<input name="email" type="email" required maxLength={254} autoComplete="username" /></label><button className="button primary" disabled={busy}>{busy ? t.working : t.request} ↗</button></form>}<button className="text-link auth-toggle" disabled={busy} onClick={onBack}>{t.back}</button></Frame>;
}
export interface AccountLink { kind: 'verify' | 'reset'; token: string }
export function AccountLinkPage({ link, language, setLanguage, api, onDone }: { link: AccountLink; language: Language; setLanguage: (language: Language) => void; api: Api; onDone: () => Promise<void> }) {
  const t = copy[language], [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      if (link.kind === 'reset' && data.get('password') !== data.get('repeat')) throw new Error('passwordMismatch');
      await api(link.kind === 'verify' ? '/api/auth/email/confirm' : '/api/auth/password/reset', post({ token: link.token, ...(link.kind === 'reset' ? { password: data.get('password') } : {}) }));
      setDone(true);
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <Frame language={language} setLanguage={setLanguage} title={link.kind === 'verify' ? t.verify : t.reset}>{error && <p className="notice error" role="alert">{error === 'passwordMismatch' ? t.mismatch : error}</p>}{done ? <p role="status">{link.kind === 'verify' ? t.done : t.resetDone}</p> : <form className="identity-form" onSubmit={event => { void submit(event); }}>{link.kind === 'reset' && <><label>{t.password}<input name="password" aria-label={t.password} type="password" required minLength={15} maxLength={256} autoComplete="new-password" aria-describedby="reset-password-note" /><small id="reset-password-note">{t.note}</small></label><label>{t.repeat}<input name="repeat" aria-label={t.repeat} type="password" required minLength={15} maxLength={256} autoComplete="new-password" /></label></>}<button className="button primary" disabled={busy}>{busy ? t.working : link.kind === 'verify' ? t.confirm : t.save} ↗</button></form>}<button className="text-link auth-toggle" disabled={busy} onClick={() => { void onDone().catch(error => setError(errorText(error))); }}>{done && link.kind === 'verify' ? t.continue : t.back}</button></Frame>;
}
export function EmailSecurity({ session, language, api }: { session: SessionView; language: Language; api: Api }) {
  const t = copy[language], [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState('');
  async function send() {
    setBusy(true); setError('');
    try { await api('/api/auth/email/request', post({})); setSent(true); } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  if (!session.email) return <p className="account-note">{t.configuration}</p>;
  return <div className="email-security"><p className="account-note">{session.email.verified ? t.verified : t.unverified} · {session.user?.email}</p>{!session.email.verified && <button className="button secondary" disabled={busy} onClick={() => { void send(); }}>{busy ? t.working : t.resend} ↗</button>}{sent && <p className="notice" role="status">{t.verifySent}</p>}{error && <p className="notice error" role="alert">{error === 'passwordMismatch' ? t.mismatch : error}</p>}</div>;
}
export function EmailVerificationGate({ session, language, setLanguage, api, onReady }: { session: SessionView; language: Language; setLanguage: (language: Language) => void; api: Api; onReady: () => Promise<void> }) {
  const t = copy[language], [error, setError] = useState('');
  async function action(logout = false) { try { if (logout) await api('/api/auth/logout', post({})); await onReady(); } catch (error) { setError(errorText(error)); } }
  return <Frame language={language} setLanguage={setLanguage} title={t.verify}><p>{t.required}</p><EmailSecurity session={session} language={language} api={api} />{error && <p role="alert">{error === 'passwordMismatch' ? t.mismatch : error}</p>}<button className="text-link auth-toggle" onClick={() => { void action(); }}>{t.refresh}</button><button className="text-link auth-toggle" onClick={() => { void action(true); }}>{t.logout}</button></Frame>;
}
export const recoveryLabel = (language: Language) => copy[language].forgot;
