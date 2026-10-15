// Минимальная совместимая с D1 обёртка над node:sqlite — чтобы гонять весь API в тестах без облака.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: unknown[] = []) {}
  bind(...params: unknown[]) { return new Stmt(this.db, this.sql, params); }
  private conv() {
    return this.params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];
  }
  _exec() {
    const st = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)|RETURNING/i.test(this.sql)) {
      const rows = st.all(...this.conv()).map((r) => ({ ...r }));
      return { results: rows, success: true, meta: { changes: /^\s*(SELECT|WITH)/i.test(this.sql) ? 0 : rows.length } };
    }
    const r = st.run(...this.conv());
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first<T>(col?: string): Promise<T | null> {
    const r = this._exec().results[0] as any;
    if (!r) return null;
    return col ? r[col] : r;
  }
  async all<T>() { return this._exec() as unknown as { results: T[]; success: true; meta: any }; }
  async run() { return this._exec(); }
}

export function createD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  const api = {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) { db.exec(sql); return { count: 0, duration: 0 }; },
  };
  return api as any;
}
