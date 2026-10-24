import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fields, HttpError } from './http.ts';
import type { Store } from './store.ts';
import type { Mailer } from './mail.ts';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export interface TeamView { id: string; name: string; role: Role }
export interface SessionView { setupRequired: boolean; user?: { id: string; email: string; name: string; instanceOwner: boolean }; team?: TeamView; teams?: TeamView[]; csrf?: string; legacyRuns?: number; email?: { enabled: true; required: boolean; verified?: boolean }; demo?: { ttlMinutes: number; maxOperations: number; expiresAt?: string } }
export interface Principal { userId: string; teamId: string; role: Role; sessionHash: string; token: string }
type User = { id: string; email: string; name: string; password: string };
type Invite = { id: string; team_id: string; email: string; role: Exclude<Role, 'owner'>; created_by: string; expires_at: number; used_at: number | null; name: string };
const ID = /^[a-f0-9-]{36}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const csrf = (session: string) => createHmac('sha256', session).update('repropack-csrf-v1').digest('hex');
const SESSION_MS = 12 * 60 * 60_000;
const IDLE_MS = 60 * 60_000;
function text(value: unknown, label: string, max = 80) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f]/u.test(value)) throw new HttpError(400, `Invalid ${label}`);
  return value.trim();
}
function email(value: unknown) {
  const result = text(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(result)) throw new HttpError(400, 'Invalid email');
  return result;
}
function password(value: unknown, creating = true) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 256 || [...value].length < (creating ? 15 : 1)) throw new HttpError(400, 'Use a password of at least 15 characters and at most 256 UTF-8 bytes');
  return value;
}
function role(value: unknown): Exclude<Role, 'owner'> {
  if (value !== 'admin' && value !== 'member' && value !== 'viewer') throw new HttpError(400, 'Choose admin, member or viewer');
  return value;
}
async function derive(value: string, salt: string) {
  return await new Promise<Buffer>((resolve, reject) => scrypt(value, salt, 64, { N: 131_072, r: 8, p: 1, maxmem: 160 * 1024 ** 2 }, (error, key) => error ? reject(error) : resolve(key)));
}
async function encode(value: string) { const salt = randomBytes(16).toString('hex'); return `scrypt$${salt}$${(await derive(value, salt)).toString('hex')}`; }
async function verify(value: string, encoded?: string) {
  const parts = encoded?.split('$');
  const valid = parts?.length === 3 && parts[0] === 'scrypt' && /^[a-f0-9]{32}$/u.test(parts[1]!) && /^[a-f0-9]{128}$/u.test(parts[2]!);
  const candidate = await derive(value, valid ? parts[1]! : '00000000000000000000000000000000');
  return timingSafeEqual(candidate, valid ? Buffer.from(parts[2]!, 'hex') : Buffer.alloc(64)) && Boolean(valid);
}

/** Opaque sessions and team authorization. No identity, role or tenant comes from a capsule. */
export class Identity {
  readonly store: Store;
  readonly bootstrapPath: string;
  onAccessChanged: (userId: string, teamId: string, force?: boolean) => void = () => undefined;
  #hashing = 0;
  readonly demoMode: boolean;
  readonly mailer: Mailer | undefined;
  readonly requireVerifiedEmail: boolean;
  #emailTasks = new Set<Promise<void>>();
  constructor(store: Store, directory: string, bootstrapToken?: string, demoMode = false, mailer?: Mailer, requireVerifiedEmail = false) {
    this.store = store; this.bootstrapPath = join(directory, 'bootstrap-token');
    this.demoMode = demoMode;
    this.mailer = demoMode ? undefined : mailer; this.requireVerifiedEmail = requireVerifiedEmail;
    if (requireVerifiedEmail && (!this.mailer || demoMode)) throw new Error('Required email verification needs SMTP on a private instance');
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (team_id TEXT NOT NULL REFERENCES teams(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')), created_at INTEGER NOT NULL, PRIMARY KEY(team_id,user_id));
      CREATE UNIQUE INDEX IF NOT EXISTS one_team_owner ON memberships(team_id) WHERE role = 'owner';
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), team_id TEXT NOT NULL REFERENCES teams(id), created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, team_id TEXT NOT NULL REFERENCES teams(id), email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member','viewer')), created_by TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE INDEX IF NOT EXISTS invitations_team ON invitations(team_id, used_at, expires_at);
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_team ON audit(team_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
    if (!store.db.prepare('PRAGMA table_info(users)').all().some(row => row.name === 'email_verified_at')) store.db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
    store.db.exec("CREATE TABLE IF NOT EXISTS account_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')), email TEXT NOT NULL, credential_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(user_id,purpose)); CREATE INDEX IF NOT EXISTS account_tokens_expiry ON account_tokens(expires_at)");
    store.db.prepare('DELETE FROM account_tokens WHERE expires_at <= ?').run(Date.now());
    const mode = demoMode ? 'demo' : 'private';
    if (this.setting('instance_mode') && this.setting('instance_mode') !== mode) throw new Error('Private and disposable demo databases cannot be interchanged');
    store.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('instance_mode', mode);
    if (demoMode) store.db.exec('CREATE TABLE demo_visitors (user_id TEXT PRIMARY KEY REFERENCES users(id), team_id TEXT NOT NULL UNIQUE REFERENCES teams(id), expires_at INTEGER NOT NULL, operations INTEGER NOT NULL DEFAULT 0)');
    if (!demoMode && this.setupRequired) {
      const key = bootstrapToken ?? (existsSync(this.bootstrapPath) ? readFileSync(this.bootstrapPath, 'utf8').trim() : token());
      if (!TOKEN.test(key)) throw new Error('Invalid local bootstrap key');
      const saved = this.setting('bootstrap_hash');
      if (saved && !equal(saved, hash(key))) throw new Error('Bootstrap key does not match this data directory');
      if (!existsSync(this.bootstrapPath)) writeFileSync(this.bootstrapPath, `${key}\n`, { flag: 'wx', mode: 0o600 });
      store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run('bootstrap_hash', hash(key));
    }
    store.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen <= ?').run(Date.now(), Date.now() - IDLE_MS);
  }
  setting(key: string) { return this.store.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value as string | undefined; }
  get setupRequired() { return !this.demoMode && !this.store.db.prepare('SELECT id FROM users LIMIT 1').get(); }
  event(teamId: string, actor: string, action: string, target = '', detail: Record<string, string | number | boolean> = {}) {
    this.store.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?)').run(randomUUID(), teamId, actor, action, target, JSON.stringify(detail), Date.now());
  }
  canWrite(userId: string, teamId: string) {
    const row = this.store.db.prepare('SELECT role FROM memberships WHERE user_id = ? AND team_id = ?').get(userId, teamId);
    return Boolean(row && row.role !== 'viewer' && (!this.requireVerifiedEmail || this.#verified(userId)) && (!this.demoMode || this.store.db.prepare('SELECT 1 FROM demo_visitors WHERE user_id = ? AND team_id = ? AND expires_at > ?').get(userId, teamId, Date.now())));
  }
  #verified(userId: string) { return Boolean(this.store.db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(userId)?.email_verified_at); }
  requireVerified(person: Principal) { if (this.requireVerifiedEmail && !this.#verified(person.userId)) throw new HttpError(403, 'Verify your email before opening the workspace'); }
  #cookie(origin: string) { const url = new URL(origin); return { secure: url.protocol === 'https:', name: url.protocol === 'https:' ? '__Host-repropack-session' : `repropack-session-${url.port}` }; }
  #readToken(req: IncomingMessage, origin: string) {
    const name = this.#cookie(origin).name;
    const values = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
    const value = values.length === 1 ? values[0]!.slice(name.length + 1) : '';
    return TOKEN.test(value) ? value : undefined;
  }
  #setCookie(res: ServerResponse, origin: string, value: string) {
    const policy = this.#cookie(origin);
    res.setHeader('set-cookie', `${policy.name}=${value}; Path=/; HttpOnly; SameSite=Strict${policy.secure ? '; Secure' : ''}${value ? '' : '; Max-Age=0'}`);
  }
  optional(req: IncomingMessage, origin: string): Principal | undefined {
    const value = this.#readToken(req, origin); if (!value) return;
    const row = this.store.db.prepare('SELECT s.*, m.role FROM sessions s JOIN memberships m ON m.user_id = s.user_id AND m.team_id = s.team_id WHERE s.hash = ?').get(hash(value));
    if (!row || Number(row.expires_at) <= Date.now() || Number(row.last_seen) <= Date.now() - IDLE_MS || (this.demoMode && !this.store.db.prepare('SELECT 1 FROM demo_visitors WHERE user_id = ? AND expires_at > ?').get(row.user_id!, Date.now()))) {
      this.store.db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash(value)); return;
    }
    if (Number(row.last_seen) < Date.now() - 60_000) this.store.db.prepare('UPDATE sessions SET last_seen = ? WHERE hash = ?').run(Date.now(), hash(value));
    return { userId: row.user_id as string, teamId: row.team_id as string, role: row.role as Role, sessionHash: hash(value), token: value };
  }
  require(req: IncomingMessage, origin: string, write = false): Principal {
    const person = this.optional(req, origin);
    if (!person) throw new HttpError(401, 'Sign in to continue');
    if (write && (typeof req.headers['x-repropack-csrf'] !== 'string' || !equal(req.headers['x-repropack-csrf'], csrf(person.token)))) throw new HttpError(403, 'Invalid session CSRF token');
    return person;
  }
  fresh(person: Principal, permission: 'read' | 'write' | 'manage' | 'owner' = 'read'): Principal {
    const row = this.store.db.prepare('SELECT m.role FROM sessions s JOIN memberships m ON s.user_id = m.user_id AND s.team_id = m.team_id WHERE s.hash = ? AND s.user_id = ? AND s.team_id = ? AND s.expires_at > ? AND s.last_seen > ?').get(person.sessionHash, person.userId, person.teamId, Date.now(), Date.now() - IDLE_MS);
    if (!row || (this.demoMode && !this.store.db.prepare('SELECT 1 FROM demo_visitors WHERE user_id = ? AND expires_at > ?').get(person.userId, Date.now()))) throw new HttpError(401, 'Session expired. Sign in again');
    const current = { ...person, role: row.role as Role };
    if ((permission === 'write' && current.role === 'viewer') || (permission === 'manage' && !['owner', 'admin'].includes(current.role)) || (permission === 'owner' && current.role !== 'owner')) throw new HttpError(403, 'Your team role does not permit this action');
    return current;
  }
  #teams(userId: string): TeamView[] { return this.store.db.prepare('SELECT t.id,t.name,m.role FROM teams t JOIN memberships m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.created_at,t.id').all(userId) as unknown as TeamView[]; }
  view(person?: Principal): SessionView {
    const demo = this.demoMode ? { ttlMinutes: 60, maxOperations: 10 } : undefined;
    const email = this.mailer ? { enabled: true as const, required: this.requireVerifiedEmail, ...(person ? { verified: this.#verified(person.userId) } : {}) } : undefined;
    if (!person) return { setupRequired: this.setupRequired, ...(demo ? { demo } : {}), ...(email ? { email } : {}) };
    const user = this.store.db.prepare('SELECT id,email,name FROM users WHERE id = ?').get(person.userId) as unknown as Omit<User, 'password'>;
    const teams = this.#teams(person.userId);
    return { setupRequired: false, user: { ...user, instanceOwner: user.id === this.setting('instance_owner') }, team: teams.find(team => team.id === person.teamId)!, teams, csrf: csrf(person.token), legacyRuns: user.id === this.setting('instance_owner') ? this.store.legacyCount : 0, ...(email ? { email } : {}), ...(demo ? { demo: { ...demo, expiresAt: new Date(Number(this.store.db.prepare('SELECT expires_at FROM demo_visitors WHERE user_id = ?').get(person.userId)!.expires_at)).toISOString() } } : {}) };
  }
  #newSession(userId: string, teamId: string, previous?: string, lifetime = SESSION_MS) {
    if (previous) this.store.db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash(previous));
    this.store.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen <= ?').run(Date.now(), Date.now() - IDLE_MS);
    this.store.db.prepare('DELETE FROM sessions WHERE user_id = ? AND hash NOT IN (SELECT hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 9)').run(userId, userId);
    const value = token(); const now = Date.now();
    this.store.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(hash(value), userId, teamId, now, now, now + lifetime);
    return value;
  }
  #team(userId: string, name: string) {
    if (this.#teams(userId).length >= 25) throw new HttpError(409, 'A user can belong to at most 25 teams');
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO teams VALUES (?,?,?)').run(id, name, Date.now());
    this.store.db.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(id, userId, 'owner', Date.now());
    this.event(id, userId, 'team.created', id); return id;
  }
  #throttle(req: IncomingMessage, account: string) {
    const now = Date.now(); this.store.db.prepare('DELETE FROM auth_limits WHERE expires_at <= ?').run(now);
    for (const [scope, value, limit] of [['ip', req.socket.remoteAddress ?? '', 60], ['account', account, 10]] as const) {
      const key = hash(`${scope}:${value}`);
      const row = this.store.db.prepare('SELECT attempts FROM auth_limits WHERE key = ?').get(key);
      if ((row && Number(row.attempts) >= limit) || (!row && Number(this.store.db.prepare('SELECT count(*) AS count FROM auth_limits').get()!.count) >= 10_000)) throw new HttpError(429, 'Too many authentication attempts. Try again in 15 minutes');
      this.store.db.prepare('INSERT INTO auth_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1').run(key, now + 15 * 60_000);
    }
  }
  async #work<T>(work: () => Promise<T>) {
    if (this.#hashing >= 2) throw new HttpError(429, 'Authentication is busy. Try again shortly');
    this.#hashing++;
    try { return await work(); } finally { this.#hashing--; }
  }
  #invite(value: unknown): Invite {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new HttpError(410, 'Invitation is invalid or expired');
    const row = this.store.db.prepare('SELECT i.*,t.name FROM invitations i JOIN teams t ON t.id = i.team_id WHERE i.hash = ? AND i.used_at IS NULL AND i.expires_at > ?').get(hash(value), Date.now()) as unknown as Invite | undefined;
    if (!row) throw new HttpError(410, 'Invitation is invalid or expired');
    const issuer = this.store.db.prepare('SELECT role FROM memberships WHERE team_id = ? AND user_id = ?').get(row.team_id, row.created_by)?.role;
    if (!['owner', 'admin'].includes(issuer as string) || (row.role === 'admin' && issuer !== 'owner')) throw new HttpError(410, 'Invitation is invalid or expired');
    return row;
  }
  #invalidate(userId: string, teamId: string) {
    this.store.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.store.db.prepare('UPDATE invitations SET used_at = ? WHERE team_id = ? AND created_by = ? AND used_at IS NULL').run(Date.now(), teamId, userId);
  }
  #queueEmail(work: () => Promise<void>) {
    if (this.#emailTasks.size >= 8) throw new HttpError(429, 'Account email is busy. Try again shortly');
    // Respond before lookup/delivery, so SMTP latency cannot enumerate accounts.
    const task = new Promise<void>(resolve => setImmediate(resolve)).then(work).catch(() => { console.error('Account email delivery failed; request a new link after checking SMTP.'); });
    this.#emailTasks.add(task);
    void task.finally(() => { this.#emailTasks.delete(task); });
  }
  async settleEmail() { await Promise.allSettled([...this.#emailTasks]); }
  #accountEvent(userId: string, action: string) {
    for (const team of this.#teams(userId)) this.event(team.id, userId, action);
  }
  async #sendLink(userId: string, purpose: 'verify' | 'reset', origin: string) {
    const user = this.store.db.prepare('SELECT email,password,email_verified_at FROM users WHERE id = ?').get(userId);
    if (!user || (purpose === 'verify' && user.email_verified_at)) return;
    const value = token(), digest = hash(value), expires = Date.now() + (purpose === 'reset' ? 30 * 60_000 : 24 * 60 * 60_000);
    this.store.db.prepare('DELETE FROM account_tokens WHERE expires_at <= ?').run(Date.now());
    this.store.db.prepare('INSERT INTO account_tokens VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,purpose) DO UPDATE SET hash=excluded.hash,email=excluded.email,credential_hash=excluded.credential_hash,expires_at=excluded.expires_at').run(digest, userId, purpose, user.email!, hash(user.password as string), expires);
    const link = origin + '/#' + (purpose === 'reset' ? 'reset' : 'verify') + '=' + value;
    try {
      await this.mailer!.send({
        to: user.email as string,
        subject: purpose === 'reset' ? 'ReproPack — Reset your password / Parolanı sıfırla' : 'ReproPack — Verify your email / E-postanı doğrula',
        text: [
          purpose === 'reset' ? 'Reset your ReproPack password. This one-use link expires in 30 minutes.' : 'Verify your ReproPack email. This one-use link expires in 24 hours.',
          purpose === 'reset' ? 'ReproPack parolanı sıfırla. Tek kullanımlık bağlantı 30 dakika geçerlidir.' : 'ReproPack e-postanı doğrula. Tek kullanımlık bağlantı 24 saat geçerlidir.',
          '', link, '', 'If you did not request this, ignore this email. / Bu işlemi sen istemediysen bu e-postayı yok say.',
        ].join('\n'),
      });
    } catch {
      this.store.db.prepare('DELETE FROM account_tokens WHERE hash = ?').run(digest);
      throw new Error('Account email delivery failed');
    }
  }
  #accountToken(value: unknown, purpose: 'verify' | 'reset') {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new HttpError(410, 'This account link is invalid or expired');
    const row = this.store.db.prepare('SELECT t.*,u.password FROM account_tokens t JOIN users u ON u.id=t.user_id AND u.email=t.email WHERE t.hash=? AND t.purpose=? AND t.expires_at>?').get(hash(value), purpose, Date.now());
    if (!row || !equal(row.credential_hash as string, hash(row.password as string))) throw new HttpError(410, 'This account link is invalid or expired');
    return row;
  }
  async #emailRoute(req: IncomingMessage, res: ServerResponse, origin: string, path: string, method: string, json: (status: number, value: unknown) => void) {
    if (!['/api/auth/email/request', '/api/auth/email/confirm', '/api/auth/password/forgot', '/api/auth/password/reset'].includes(path)) return false;
    if (method !== 'POST') throw new HttpError(405, 'Use POST for account links');
    if (!this.mailer || this.demoMode) throw new HttpError(503, 'Account email is not configured on this instance');
    if (path === '/api/auth/email/request') {
      const person = this.require(req, origin, true);
      await fields(req, []); this.fresh(person); this.#throttle(req, 'verify:' + person.userId);
      this.#queueEmail(() => this.#sendLink(person.userId, 'verify', origin));
      json(202, { accepted: true }); return true;
    }
    if (path === '/api/auth/password/forgot') {
      const input = await fields(req, ['email']); const address = email(input.email);
      this.#throttle(req, 'forgot:' + address);
      this.#queueEmail(async () => {
        const user = this.store.db.prepare('SELECT id FROM users WHERE email=?').get(address);
        if (user) await this.#sendLink(user.id as string, 'reset', origin);
      });
      json(202, { accepted: true }); return true;
    }
    if (path === '/api/auth/email/confirm') {
      const input = await fields(req, ['token']); this.#throttle(req, 'confirm:' + hash(typeof input.token === 'string' ? input.token : 'invalid'));
      this.store.transaction(() => {
        const row = this.#accountToken(input.token, 'verify');
        this.store.db.prepare('UPDATE users SET email_verified_at=? WHERE id=?').run(Date.now(), row.user_id!);
        this.store.db.prepare("DELETE FROM account_tokens WHERE user_id=? AND purpose='verify'").run(row.user_id!);
        this.#accountEvent(row.user_id as string, 'email.verified');
      });
      json(200, { verified: true }); return true;
    }
    const input = await fields(req, ['token', 'password']);
    const row = this.#accountToken(input.token, 'reset'), secret = password(input.password);
    this.#throttle(req, 'reset:' + row.user_id);
    const encoded = await this.#work(() => encode(secret));
    const userId = this.store.transaction(() => {
      const fresh = this.#accountToken(input.token, 'reset');
      this.store.db.prepare('UPDATE users SET password=?,email_verified_at=? WHERE id=?').run(encoded, Date.now(), fresh.user_id!);
      this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(fresh.user_id!);
      this.store.db.prepare('DELETE FROM account_tokens WHERE user_id=?').run(fresh.user_id!);
      this.store.db.prepare('UPDATE invitations SET used_at=? WHERE created_by=? AND used_at IS NULL').run(Date.now(), fresh.user_id!);
      this.#accountEvent(fresh.user_id as string, 'password.reset');
      return fresh.user_id as string;
    });
    for (const team of this.#teams(userId)) this.onAccessChanged(userId, team.id, true);
    this.#setCookie(res, origin, ''); json(200, { reset: true }); return true;
  }
  consumeDemoOperation(teamId: string) {
    if (this.demoMode && this.store.db.prepare('UPDATE demo_visitors SET operations = operations + 1 WHERE team_id = ? AND expires_at > ? AND operations < 10').run(teamId, Date.now()).changes !== 1) throw new HttpError(429, 'This demo allows ten reductions/fix checks per workspace');
  }
  expiredDemoTeams() {
    return this.demoMode ? this.store.db.prepare('SELECT team_id FROM demo_visitors WHERE expires_at <= ?').all(Date.now()).map(row => row.team_id as string) : [];
  }
  deleteDemoTeam(teamId: string) {
    if (!this.demoMode) throw new Error('Demo deletion cannot operate in a private workbench');
    this.store.transaction(() => {
      const visitor = this.store.db.prepare('SELECT user_id FROM demo_visitors WHERE team_id = ? AND expires_at <= ?').get(teamId, Date.now());
      if (!visitor) return;
      this.store.db.prepare('DELETE FROM audit WHERE team_id = ?').run(teamId);
      this.store.db.prepare('DELETE FROM runs WHERE team_id = ?').run(teamId);
      this.store.db.prepare('DELETE FROM sessions WHERE team_id = ?').run(teamId);
      this.store.db.prepare('DELETE FROM account_tokens WHERE user_id = ?').run(visitor.user_id!);
      this.store.db.prepare('DELETE FROM memberships WHERE team_id = ?').run(teamId);
      this.store.db.prepare('DELETE FROM demo_visitors WHERE team_id = ?').run(teamId);
      this.store.db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      this.store.db.prepare('DELETE FROM users WHERE id = ?').run(visitor.user_id!);
    });
  }
  async route(req: IncomingMessage, res: ServerResponse, origin: string, path: string, method: string, json: (status: number, value: unknown) => void): Promise<boolean> {
    if (method === 'GET' && path === '/api/session') { json(200, this.view(this.optional(req, origin))); return true; }
    if (this.demoMode && method === 'POST' && path === '/api/demo/session') {
      await fields(req, []);
      const current = this.optional(req, origin);
      if (current) { this.require(req, origin, true); json(200, { started: true }); return true; }
      this.#throttle(req, `demo:${req.socket.remoteAddress ?? ''}`);
      const value = this.store.transaction(() => {
        if (Number(this.store.db.prepare('SELECT count(*) AS count FROM demo_visitors').get()!.count) >= 30) throw new HttpError(429, 'The demo is at capacity. Try again later');
        const id = randomUUID(); this.store.db.prepare('INSERT INTO users(id,email,name,password) VALUES (?,?,?,?)').run(id, `demo-${id}@example.invalid`, 'Demo visitor', 'disabled-demo-account');
        const teamId = this.#team(id, 'Private demo');
        this.store.db.prepare("UPDATE memberships SET role = 'member' WHERE team_id = ? AND user_id = ?").run(teamId, id);
        this.store.db.prepare('INSERT INTO demo_visitors VALUES (?,?,?,0)').run(id, teamId, Date.now() + 60 * 60_000);
        return this.#newSession(id, teamId, undefined, 60 * 60_000);
      });
      this.#setCookie(res, origin, value); json(201, { started: true }); return true;
    }
    if (this.demoMode && (path.startsWith('/api/auth/') || path.startsWith('/api/team') || path.startsWith('/api/invites/')) && !(method === 'POST' && path === '/api/auth/logout')) throw new HttpError(403, 'Account and team administration are disabled in the public demo');
    if (await this.#emailRoute(req, res, origin, path, method, json)) return true;
    if (method === 'POST' && path === '/api/auth/setup') {
      const input = await fields(req, ['token', 'name', 'email', 'password', 'teamName']);
      if (!this.setupRequired) throw new HttpError(409, 'This instance is already initialized');
      this.#throttle(req, 'bootstrap');
      if (typeof input.token !== 'string' || !TOKEN.test(input.token) || !equal(hash(input.token), this.setting('bootstrap_hash') ?? '')) throw new HttpError(403, 'Invalid local setup key');
      const name = text(input.name, 'name'), address = email(input.email), secret = password(input.password), teamName = text(input.teamName, 'team name');
      const encoded = await this.#work(() => encode(secret));
      const value = this.store.transaction(() => {
        if (!this.setupRequired) throw new HttpError(409, 'This instance is already initialized');
        const id = randomUUID(); this.store.db.prepare('INSERT INTO users(id,email,name,password) VALUES (?,?,?,?)').run(id, address, name, encoded);
        this.store.db.prepare('INSERT INTO settings VALUES (?,?)').run('instance_owner', id);
        this.store.db.prepare('DELETE FROM settings WHERE key = ?').run('bootstrap_hash');
        const teamId = this.#team(id, teamName); this.event(teamId, id, 'instance.initialized', teamId);
        return this.#newSession(id, teamId);
      });
      try { unlinkSync(this.bootstrapPath); } catch { /* The consumed key is inactive even if a local file lock prevents deletion. */ }
      this.#setCookie(res, origin, value); json(201, { initialized: true }); return true;
    }
    if (method === 'POST' && path === '/api/auth/login') {
      const input = await fields(req, ['email', 'password']);
      const address = email(input.email), secret = password(input.password, false); this.#throttle(req, address);
      const user = this.store.db.prepare('SELECT * FROM users WHERE email = ?').get(address) as unknown as User | undefined;
      if (!await this.#work(() => verify(secret, user?.password)) || !user) throw new HttpError(401, 'Email or password is incorrect');
      const value = this.store.transaction(() => {
        if (this.store.db.prepare('SELECT password FROM users WHERE id = ?').get(user.id)?.password !== user.password) throw new HttpError(401, 'Email or password is incorrect');
        const teamId = this.#teams(user.id)[0]?.id ?? this.#team(user.id, `${user.name.slice(0, 60)} workspace`);
        this.event(teamId, user.id, 'session.signed_in');
        return this.#newSession(user.id, teamId, this.#readToken(req, origin));
      });
      this.#setCookie(res, origin, value); json(200, { signedIn: true }); return true;
    }
    if (method === 'POST' && path === '/api/invites/inspect') {
      const input = await fields(req, ['token']); const invite = this.#invite(input.token);
      json(200, { email: invite.email, teamName: invite.name, role: invite.role }); return true;
    }
    if (method === 'POST' && path === '/api/invites/accept') {
      const input = await fields(req, ['token', 'name', 'password']); const invite = this.#invite(input.token);
      const current = this.optional(req, origin); if (current) this.require(req, origin, true);
      const existing = this.store.db.prepare('SELECT id FROM users WHERE email = ?').get(invite.email);
      if (existing && current?.userId !== existing.id) throw new HttpError(409, 'Sign in with the invited account before accepting');
      if (current && this.store.db.prepare('SELECT email FROM users WHERE id = ?').get(current.userId)?.email !== invite.email) throw new HttpError(403, 'This invitation belongs to a different account');
      let encoded: string | undefined, name: string | undefined;
      if (!existing) { this.#throttle(req, invite.email); name = text(input.name, 'name'); const secret = password(input.password); encoded = await this.#work(() => encode(secret)); }
      const value = this.store.transaction(() => {
        const fresh = this.#invite(input.token); if (current) this.fresh(current);
        if (!existing && this.store.db.prepare('SELECT id FROM users WHERE email = ?').get(fresh.email)) throw new HttpError(409, 'Sign in with the invited account before accepting');
        const userId = existing?.id as string | undefined ?? randomUUID();
        if (!existing) this.store.db.prepare('INSERT INTO users(id,email,name,password) VALUES (?,?,?,?)').run(userId, fresh.email, name!, encoded!);
        if (this.#teams(userId).length >= 25) throw new HttpError(409, 'A user can belong to at most 25 teams');
        if (Number(this.store.db.prepare('SELECT count(*) AS count FROM memberships WHERE team_id = ?').get(fresh.team_id)!.count) >= 100) throw new HttpError(409, 'Team member limit reached');
        if (this.store.db.prepare('SELECT role FROM memberships WHERE team_id = ? AND user_id = ?').get(fresh.team_id, userId)) throw new HttpError(409, 'You already belong to this team');
        this.store.db.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(fresh.team_id, userId, fresh.role, Date.now());
        this.store.db.prepare('UPDATE invitations SET used_at = ? WHERE id = ?').run(Date.now(), fresh.id);
        this.event(fresh.team_id, userId, 'invitation.accepted', fresh.id, { role: fresh.role });
        return this.#newSession(userId, fresh.team_id, current?.token);
      });
      this.#setCookie(res, origin, value); json(200, { joined: true }); return true;
    }
    if (!path.startsWith('/api/auth/') && !path.startsWith('/api/team')) return false;
    const person = this.require(req, origin, method === 'POST');
    if (!['/api/auth/logout', '/api/auth/password'].includes(path)) this.requireVerified(person);
    if (method === 'POST' && path === '/api/auth/logout') {
      this.store.transaction(() => {
        this.event(person.teamId, person.userId, 'session.signed_out'); this.store.db.prepare('DELETE FROM sessions WHERE hash = ?').run(person.sessionHash);
        if (this.demoMode) this.store.db.prepare('UPDATE demo_visitors SET expires_at = 0 WHERE team_id = ?').run(person.teamId);
      });
      if (this.demoMode) this.onAccessChanged(person.userId, person.teamId);
      this.#setCookie(res, origin, ''); json(200, { signedOut: true }); return true;
    }
    if (method === 'POST' && path === '/api/auth/password') {
      const input = await fields(req, ['currentPassword', 'password']); const currentPassword = password(input.currentPassword, false), nextPassword = password(input.password);
      this.#throttle(req, person.userId); const encoded = this.store.db.prepare('SELECT password FROM users WHERE id = ?').get(person.userId)!.password as string;
      const next = await this.#work(async () => { if (!await verify(currentPassword, encoded)) throw new HttpError(403, 'Current password is incorrect'); return encode(nextPassword); });
      const value = this.store.transaction(() => {
        this.fresh(person); if (this.store.db.prepare('SELECT password FROM users WHERE id = ?').get(person.userId)?.password !== encoded) throw new HttpError(409, 'Password changed. Sign in again');
        this.store.db.prepare('UPDATE users SET password = ? WHERE id = ?').run(next, person.userId);
        this.store.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(person.userId);
        this.store.db.prepare('DELETE FROM account_tokens WHERE user_id = ?').run(person.userId);
        this.event(person.teamId, person.userId, 'password.changed'); return this.#newSession(person.userId, person.teamId);
      });
      this.#setCookie(res, origin, value); json(200, { changed: true }); return true;
    }
    if (method === 'POST' && path === '/api/teams') {
      const input = await fields(req, ['name']); const name = text(input.name, 'team name');
      const value = this.store.transaction(() => { this.fresh(person); return this.#newSession(person.userId, this.#team(person.userId, name), person.token); });
      this.#setCookie(res, origin, value); json(201, { created: true }); return true;
    }
    if (method === 'POST' && path === '/api/teams/switch') {
      const input = await fields(req, ['teamId']);
      if (typeof input.teamId !== 'string' || !ID.test(input.teamId)) throw new HttpError(400, 'Invalid team');
      const value = this.store.transaction(() => {
        this.fresh(person); if (!this.#teams(person.userId).some(team => team.id === input.teamId)) throw new HttpError(404, 'Team not found');
        return this.#newSession(person.userId, input.teamId as string, person.token);
      });
      this.#setCookie(res, origin, value); json(200, { switched: true }); return true;
    }
    if (method === 'GET' && path === '/api/team') {
      this.fresh(person, 'manage');
      json(200, {
        members: this.store.db.prepare('SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.created_at,u.id').all(person.teamId),
        invitations: this.store.db.prepare('SELECT id,email,role,expires_at AS expiresAt FROM invitations WHERE team_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC').all(person.teamId, Date.now()),
      }); return true;
    }
    if (method === 'GET' && path === '/api/team/audit') {
      this.fresh(person, 'manage');
      json(200, this.store.db.prepare('SELECT a.id,a.action,a.target,a.detail,a.created_at AS createdAt,u.name AS actor FROM audit a JOIN users u ON u.id = a.actor_id WHERE a.team_id = ? ORDER BY a.created_at DESC,a.id DESC LIMIT 100').all(person.teamId).map(row => ({ ...row, detail: JSON.parse(row.detail as string) as unknown }))); return true;
    }
    if (method === 'POST' && path === '/api/team/invites') {
      const input = await fields(req, ['email', 'role']); const address = email(input.email), granted = role(input.role); const actor = this.fresh(person, 'manage');
      if (granted === 'admin' && actor.role !== 'owner') throw new HttpError(403, 'Only an owner can grant admin access');
      const value = token(), id = randomUUID(), expiresAt = Date.now() + 24 * 60 * 60_000;
      this.store.transaction(() => {
        const count = Number(this.store.db.prepare('SELECT count(*) AS count FROM invitations WHERE team_id = ? AND used_at IS NULL AND expires_at > ?').get(actor.teamId, Date.now())!.count);
        if (count >= 25) throw new HttpError(409, 'At most 25 pending invitations are allowed');
        if (this.store.db.prepare('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.email = ?').get(actor.teamId, address)) throw new HttpError(409, 'This user already belongs to the team');
        this.store.db.prepare('UPDATE invitations SET used_at = ? WHERE team_id = ? AND email = ? AND used_at IS NULL').run(Date.now(), actor.teamId, address);
        this.store.db.prepare('INSERT INTO invitations VALUES (?,?,?,?,?,?,?,NULL)').run(id, hash(value), actor.teamId, address, granted, actor.userId, expiresAt);
        this.event(actor.teamId, actor.userId, 'invitation.created', id, { role: granted });
      });
      json(201, { id, url: `${origin}/#invite=${value}`, expiresAt }); return true;
    }
    const revoke = /^\/api\/team\/invites\/([a-f0-9-]{36})\/revoke$/u.exec(path);
    if (method === 'POST' && revoke) {
      this.fresh(person, 'manage');
      this.store.transaction(() => {
        const invite = this.store.db.prepare('SELECT role,created_by FROM invitations WHERE id = ? AND team_id = ? AND used_at IS NULL').get(revoke[1]!, person.teamId);
        if (!invite) throw new HttpError(404, 'Invitation not found');
        if (person.role !== 'owner' && invite.role === 'admin') throw new HttpError(403, 'Only an owner can manage admin invitations');
        this.store.db.prepare('UPDATE invitations SET used_at = ? WHERE id = ? AND team_id = ?').run(Date.now(), revoke[1]!, person.teamId);
        this.event(person.teamId, person.userId, 'invitation.revoked', revoke[1]!);
      }); json(200, { revoked: true }); return true;
    }
    const member = /^\/api\/team\/members\/([a-f0-9-]{36})\/(role|remove)$/u.exec(path);
    if (method === 'POST' && member) {
      const input = await fields(req, member[2] === 'role' ? ['role'] : []); const actor = this.fresh(person, 'manage');
      const granted = member[2] === 'role' ? role(input.role) : undefined;
      this.store.transaction(() => {
        const target = this.store.db.prepare('SELECT role FROM memberships WHERE team_id = ? AND user_id = ?').get(actor.teamId, member[1]!);
        if (!target) throw new HttpError(404, 'Member not found');
        if (member[1] === actor.userId || target.role === 'owner' || (actor.role !== 'owner' && (target.role === 'admin' || granted === 'admin'))) throw new HttpError(403, 'Only the owner can manage admins; use ownership transfer for the owner');
        if (granted) this.store.db.prepare('UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?').run(granted, actor.teamId, member[1]!);
        else this.store.db.prepare('DELETE FROM memberships WHERE team_id = ? AND user_id = ?').run(actor.teamId, member[1]!);
        this.#invalidate(member[1]!, actor.teamId);
        this.event(actor.teamId, actor.userId, granted ? 'member.role_changed' : 'member.removed', member[1]!, granted ? { role: granted } : {});
      });
      this.onAccessChanged(member[1]!, actor.teamId); json(200, { updated: true }); return true;
    }
    if (method === 'POST' && (path === '/api/team/transfer' || path === '/api/team/import-local-history')) {
      const input = await fields(req, path.endsWith('/transfer') ? ['userId', 'currentPassword'] : ['currentPassword']); this.fresh(person, 'owner');
      this.#throttle(req, person.userId); const encoded = this.store.db.prepare('SELECT password FROM users WHERE id = ?').get(person.userId)!.password as string;
      if (!await this.#work(() => verify(password(input.currentPassword, false), encoded))) throw new HttpError(403, 'Current password is incorrect');
      let claimed = 0;
      this.store.transaction(() => {
        this.fresh(person, 'owner');
        if (path.endsWith('/transfer')) {
          if (typeof input.userId !== 'string' || input.userId === person.userId || !this.#teams(input.userId).some(team => team.id === person.teamId)) throw new HttpError(404, 'Choose another existing team member');
          this.store.db.prepare("UPDATE memberships SET role = 'admin' WHERE team_id = ? AND user_id = ?").run(person.teamId, person.userId);
          this.store.db.prepare("UPDATE memberships SET role = 'owner' WHERE team_id = ? AND user_id = ?").run(person.teamId, input.userId);
          this.#invalidate(input.userId, person.teamId); this.#invalidate(person.userId, person.teamId);
          this.event(person.teamId, person.userId, 'team.ownership_transferred', input.userId);
        } else {
          if (person.userId !== this.setting('instance_owner')) throw new HttpError(403, 'Only the original instance administrator can import local history');
          claimed = this.store.claimLegacy(person.teamId, person.userId); this.event(person.teamId, person.userId, 'history.imported', person.teamId, { runs: claimed });
        }
      });
      if (path.endsWith('/transfer')) this.#setCookie(res, origin, '');
      json(200, { updated: true, imported: claimed }); return true;
    }
    return false;
  }
}
