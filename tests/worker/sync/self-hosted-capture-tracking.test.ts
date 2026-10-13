import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SelfHostedSync } from '../../../src/services/sync/self-hosted/SelfHostedSync.js';
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cmem-capture-tracking-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db'); const store = new SessionStore(path, { syncOpsEnabled: false }); cleanup.push(() => store.close());
  const sync = new SelfHostedSync(store.db); sync.setup({ independent: true });
  const other = new Database(path); cleanup.push(() => other.close());
  return { db: store.db, other, sync };
}
const insert = (db: Database) => db.query("INSERT INTO sdk_sessions(content_session_id,project,started_at,started_at_epoch,status) VALUES('cross-connection','p','2026-10-13T00:00:00.000Z',1,'completed')").run();
it('observes other SQLite connections, rollback, restart, updates and deletes while skipping unchanged scans', () => {
  const { db, other, sync } = fixture();
  // A no-op capture cannot rebuild the projection or scan source rows.
  const before = db.query('SELECT total_changes() AS n').get(); sync.capture(); expect(db.query('SELECT total_changes() AS n').get()).toEqual(before);
  insert(other); sync.capture(); expect(sync.head()).toBe(1);
  other.query("UPDATE sdk_sessions SET custom_title='offline edit'").run();
  new SelfHostedSync(db).capture(); expect(sync.head()).toBe(2);
  const state = db.query('SELECT * FROM self_sync_capture').get();
  expect(() => other.transaction(() => { other.query("UPDATE sdk_sessions SET custom_title='rolled back'").run(); throw Error('rollback'); })()).toThrow();
  expect(db.query('SELECT * FROM self_sync_capture').get()).toEqual(state);
  expect(() => db.transaction(() => { db.query("UPDATE sdk_sessions SET custom_title='captured then rolled back'").run(); sync.capture(); throw Error('rollback'); })()).toThrow();
  expect(sync.head()).toBe(2); expect(db.query('SELECT * FROM self_sync_capture').get()).toEqual(state);
  other.query('DELETE FROM sdk_sessions').run(); sync.capture(); expect(sync.head()).toBe(3);
  expect(JSON.parse((db.query('SELECT body FROM self_sync_log ORDER BY seq DESC LIMIT 1').get() as any).body).deleted).toBe(true);
});
it('captures writes made while disabled and retains a conservative fallback for older journals', () => {
  const { db, other, sync } = fixture(); sync.setEnabled(false); insert(other); sync.setEnabled(true); sync.capture(); expect(sync.head()).toBe(1);
  for (const row of db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'self_sync_dirty_%'").all() as any[]) db.exec('DROP TRIGGER '+row.name);
  db.exec('DROP TABLE self_sync_capture'); other.query("UPDATE sdk_sessions SET custom_title='legacy journal'").run(); sync.capture(); expect(sync.head()).toBe(2);
});
it('indexes work journal selection without scanning content payloads', () => {
  const { db } = fixture();
  const plan = db.query("EXPLAIN QUERY PLAN SELECT body FROM self_sync_log WHERE json_extract(body,'$.kind')='work' ORDER BY seq").all();
  expect(JSON.stringify(plan)).toContain('self_sync_log_kind_seq');
});

// Exercise the production guard with retained history, without clock thresholds.
function historyFixture() {
  const { db, sync } = fixture();
  const entity = 'session:guard-fixture';
  db.query("INSERT INTO self_sync_map VALUES(?, 'session', 'owner', '1', NULL, 'snapshot')").run(entity);
  const append = (id: string, deleted: boolean, memory: string | null) => db.query('INSERT INTO self_sync_log(id,body) VALUES(?,?)').run(id, JSON.stringify({ kind: 'session', entity, deleted, payload: memory === null ? null : { memory_session_id: memory } }));
  const heads = (...ids: string[]) => { db.query('DELETE FROM self_sync_heads').run(); for (const id of ids) db.query('INSERT INTO self_sync_heads VALUES(?,?)').run(entity, id); };
  const blocked = (memory: string) => (sync as unknown as { hasDeletedSession(id: string): boolean }).hasDeletedSession(memory);
  return { db, append, heads, blocked };
}
it('never inspects session history behind a live head when checking incoming content', () => {
  const { db, append, heads, blocked } = historyFixture();
  for (let i = 0; i < 50; i++) append(`revision-${i}`, false, `memory-${i}`);
  heads('revision-49');
  // A view makes an unused history row raise if SQLite evaluates its payload.
  // Looking up the actual live head remains valid. This catches history scans
  // before the deletion guard without clock thresholds or SQLite opcode offsets.
  db.exec(`ALTER TABLE self_sync_log RENAME TO retained_log;
    CREATE VIEW self_sync_log AS SELECT seq,id,
      CASE WHEN id='revision-0' THEN json_extract('invalid-history-probe','$') ELSE body END AS body
      FROM retained_log`);
  expect(blocked('absent-memory')).toBe(false);
  expect(blocked('memory-0')).toBe(false);
});
it('checks all prior identities for deleted or conflicted heads while allowing resolved live heads', () => {
  const { db, append, heads, blocked } = historyFixture();
  append('original', false, 'old-memory'); append('renamed', false, 'new-memory'); append('deleted', true, null); append('restored', false, 'new-memory');
  heads('deleted');
  expect(blocked('old-memory')).toBe(true);
  expect(blocked('new-memory')).toBe(true);
  expect(blocked('unrelated')).toBe(false);
  heads('restored');
  expect(blocked('old-memory')).toBe(false);
  heads('restored', 'deleted');
  expect(blocked('old-memory')).toBe(true);
  // Pre-compat stores may lack the kind index; safety does not depend on it.
  db.exec('DROP INDEX self_sync_log_kind_seq');
  expect(blocked('new-memory')).toBe(true);
  expect(blocked('unrelated')).toBe(false);
});
