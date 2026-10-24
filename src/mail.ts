import nodemailer from 'nodemailer';

export interface AccountMessage { to: string; subject: string; text: string }
/** Only the operator supplies the transport. Never accept mail settings from a request. */
export interface Mailer { send(message: AccountMessage): Promise<void>; close?(): void }
export function mailFromEnvironment(env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  const keys = ['REPROPACK_SMTP_HOST', 'REPROPACK_SMTP_PORT', 'REPROPACK_SMTP_USER', 'REPROPACK_SMTP_PASSWORD', 'REPROPACK_MAIL_FROM', 'REPROPACK_SMTP_SECURE'];
  if (!keys.some(key => Boolean(env[key]))) return;
  const host = env.REPROPACK_SMTP_HOST, from = env.REPROPACK_MAIL_FROM;
  const port = Number(env.REPROPACK_SMTP_PORT || 587);
  const secureValue = env.REPROPACK_SMTP_SECURE || (port === 465 ? '1' : '0');
  if (!host || /[\s/@:]/u.test(host) || !from || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(from) || !Number.isInteger(port) || port < 1 || port > 65535 || !['0', '1'].includes(secureValue) || !env.REPROPACK_SMTP_USER || !env.REPROPACK_SMTP_PASSWORD) throw new Error('Configure SMTP host, port, user, password and a plain sender email address');
  const transport = nodemailer.createTransport({
    host, port, secure: secureValue === '1', requireTLS: true,
    auth: { user: env.REPROPACK_SMTP_USER, pass: env.REPROPACK_SMTP_PASSWORD },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10_000, dnsTimeout: 5000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  });
  return {
    async send(message) {
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(message.to) || /[\r\n]/u.test(message.subject)) throw new Error('Invalid account message');
      const result = await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text, disableFileAccess: true, disableUrlAccess: true });
      if (!result.accepted.length || result.rejected.length) throw new Error('SMTP did not accept the account message');
    },
    close() { transport.close(); },
  };
}
