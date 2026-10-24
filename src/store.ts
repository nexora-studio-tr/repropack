import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Capsule } from './core/model.ts';
import type { Reduction, TrialEvent } from './core/minimize.ts';
import type { AdapterEvidence } from './adapters/sessions.ts';

export interface FixVerification { passed: boolean; attempts: number; adapter: 'demo-cart-fixed' | 'configured-node-module'; checkedAt: string; reason: string }
export interface Run {
  id: string;
  teamId: string;
  createdBy: string;
  createdAt: string;
  status: 'queued' | 'running' | 'completed' | 'budget_exhausted' | 'inconclusive' | 'cancelled' | 'failed' | 'interrupted';
  source: Capsule;
  events: TrialEvent[];
  report?: Reduction;
  error?: string;
  verification?: FixVerification;
  environment?: AdapterEvidence;
  fixAvailable?: boolean;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'runs.sqlite'));
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL, team_id TEXT);');
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some(row => row.name === 'team_id')) this.db.exec('ALTER TABLE runs ADD COLUMN team_id TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS runs_team_history ON runs(team_id, created_at DESC, id DESC)');
    for (const row of this.db.prepare("SELECT id, payload FROM runs WHERE json_extract(payload, '$.status') IN ('running','queued')").all()) {
      const run = JSON.parse(row.payload as string) as Run;
      if (run.status === 'running' || run.status === 'queued') {
        run.status = 'interrupted';
        run.error = 'The server stopped during this run. It was not automatically replayed.';
        this.db.prepare('UPDATE runs SET payload = ? WHERE id = ?').run(JSON.stringify(run), row.id!);
      }
    }
  }
  save(run: Run) {
    if (!run.teamId || !run.createdBy) throw new Error('A run requires a team and actor');
    const result = this.db.prepare('INSERT INTO runs (id, created_at, payload, team_id) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload WHERE runs.team_id = excluded.team_id').run(run.id, run.createdAt, JSON.stringify(run), run.teamId);
    if (result.changes !== 1) throw new Error('Run ownership is immutable');
  }
  get(id: string, teamId: string): Run | undefined {
    const row = this.db.prepare('SELECT payload FROM runs WHERE id = ? AND team_id = ?').get(id, teamId);
    return row ? JSON.parse(row.payload as string) as Run : undefined;
  }
  list(teamId: string) {
    return this.db.prepare('SELECT payload FROM runs WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT 30').all(teamId).map(row => {
      const run = JSON.parse(row.payload as string) as Run;
      return { id: run.id, createdAt: run.createdAt, status: run.status, title: run.source.title, originalSteps: run.source.steps.length, reducedSteps: run.report?.reducedSteps ?? null };
    });
  }
  get legacyCount() { return Number(this.db.prepare('SELECT count(*) AS count FROM runs WHERE team_id IS NULL').get()!.count); }
  claimLegacy(teamId: string, userId: string) {
    return Number(this.db.prepare("UPDATE runs SET team_id = ?, payload = json_set(payload, '$.teamId', ?, '$.createdBy', ?) WHERE team_id IS NULL").run(teamId, teamId, userId).changes);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
