import { randomBytes } from 'node:crypto';
import type { SessionView } from '../../src/auth.ts';

export const testPassword = 'test-only correct horse battery staple';
export const testBootstrap = () => randomBytes(32).toString('hex');
export const localHeaders = (origin: string) => ({ origin, 'content-type': 'application/json', 'x-repropack-local': '1' });
export class Client {
  origin: string;
  cookie = '';
  csrf = '';
  constructor(origin: string) { this.origin = origin; }
  async request(path: string, value?: unknown, extras: Record<string, string> = {}) {
    const response = await fetch(`${this.origin}${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { ...localHeaders(this.origin), cookie: this.cookie, 'x-repropack-csrf': this.csrf, ...extras }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const cookie = response.headers.get('set-cookie'); if (cookie) this.cookie = cookie.split(';')[0]!;
    return response;
  }
  async session() {
    const response = await this.request('/api/session'); const view = await response.json() as SessionView; this.csrf = view.csrf ?? ''; return view;
  }
  async setup(key: string) {
    const response = await this.request('/api/auth/setup', { token: key, name: 'Workspace owner', email: 'owner@example.test', password: testPassword, teamName: 'Research team' });
    if (response.status !== 201) throw new Error(`Fixture setup failed: ${response.status}`);
    return this.session();
  }
  async login(address = 'owner@example.test', secret = testPassword) {
    const response = await this.request('/api/auth/login', { email: address, password: secret });
    if (response.status === 200) await this.session(); return response;
  }
}
