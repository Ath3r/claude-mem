import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kind, Revision } from '../../../src/services/sync/self-hosted/protocol.js';
import type { SyncOp } from '../../../src/services/sync/SyncApply.js';

// Set isolation before any runtime application imports, even without preload.
process.env.CLAUDE_MEM_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'cmem-empty-project-'));
const { SessionStore } = await import('../../../src/services/sqlite/SessionStore.js');
const { SelfHostedSync } = await import('../../../src/services/sync/self-hosted/SelfHostedSync.js');
const { SyncApply } = await import('../../../src/services/sync/SyncApply.js');
const { revision, validateRevision, parsePacket, portablePayload, nativePayload, entityId } = await import('../../../src/services/sync/self-hosted/protocol.js');
const { buildContentOperation, parseCanonicalOperation, canonicalJson, sha256Base64Url } = await import('../../../src/services/sync/CanonicalContent.js');

const ISO = '2026-10-12T00:00:00.000Z';
const EPOCH = Date.parse(ISO);
const OWNER = '11111111-1111-4111-8111-111111111111';
const stores: InstanceType<typeof SessionStore>[] = [];
function device() {
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  stores.push(store);
  return { store, sync: new SelfHostedSync(store.db) };
}
type Device = ReturnType<typeof device>;
function seed(d: Device, tag: string) {
  for (const registered of [true, false]) {
    const content = `${tag}-${registered}`, memory = registered ? `memory-${tag}` : null;
    const session = d.store.db.query(`INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,platform_source,started_at,started_at_epoch,status) VALUES(?,?,'','claude',?,?,'completed')`).run(content, memory, ISO, EPOCH).lastInsertRowid;
    d.store.db.query(`INSERT INTO user_prompts(session_db_id,content_session_id,prompt_number,prompt_text,created_at,created_at_epoch) VALUES(?,?,1,'original prompt',?,?)`).run(session, content, ISO, EPOCH);
  }
  d.store.db.query(`INSERT INTO observations(memory_session_id,project,type,title,created_at,created_at_epoch) VALUES(?,'','discovery','original observation',?,?)`).run(`memory-${tag}`, ISO, EPOCH);
  d.store.db.query(`INSERT INTO session_summaries(memory_session_id,project,request,created_at,created_at_epoch) VALUES(?,'','original summary',?,?)`).run(`memory-${tag}`, ISO, EPOCH);
}
function payload(d: Device, kind: Exclude<Kind, 'work'>) {
  const sql = kind === 'prompt'
    ? 'SELECT p.*,s.memory_session_id,s.project,s.platform_source FROM user_prompts p JOIN sdk_sessions s ON s.id=p.session_db_id ORDER BY p.id DESC LIMIT 1'
    : `SELECT * FROM ${kind === 'session' ? 'sdk_sessions' : kind === 'observation' ? 'observations' : 'session_summaries'} LIMIT 1`;
  return portablePayload(kind, d.store.db.query(sql).get() as Record<string, unknown>);
}
function makeRevision(kind: Kind, value: Record<string, unknown>): Revision {
  return revision({ kind, owner: OWNER, actor: OWNER, local: '1', entity: entityId(kind, OWNER, '1'), parents: [], causes: [], deleted: false, payload: value });
}
function op(kind: SyncOp['kind'], value: Record<string, unknown>, seq = '1'): SyncOp {
  return { kind, seq, origin_device: OWNER, origin_id: '1', rev: '1', body: canonicalJson(nativePayload(value)), server_ts: 0 };
}
function settle(a: Device, b: Device) {
  for (let i = 0; i < 4; i++) {
    const request = a.sync.prepare((a.sync.status().peers as unknown[]).length ? b.sync.status().device as string : undefined);
    const response = b.sync.exchange(request);
    a.sync.accept(response, request);
  }
}
function assertRows(d: Device, copies: number) {
  expect(d.sync.status().projectionErrors).toEqual([]);
  for (const [table, n] of [['sdk_sessions', copies * 2], ['observations', copies], ['session_summaries', copies]] as const) {
    expect(d.store.db.query(`SELECT project FROM ${table}`).all()).toEqual(Array.from({ length: n }, () => ({ project: '' })));
  }
  expect(d.store.db.query('SELECT s.project FROM user_prompts p LEFT JOIN sdk_sessions s ON s.id=p.session_db_id').all())
    .toEqual(Array.from({ length: copies * 2 }, () => ({ project: '' })));
  expect(d.store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(d.sync.status().conflicts).toEqual([]);
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('private sync legacy empty projects', () => {
  it('sets up existing legacy rows and validates packets without rewriting payloads or hashes', () => {
    const a = device(); seed(a, 'a');
    a.sync.setup({ independent: true });
    const packet = a.sync.prepare();
    expect(packet.changes).toHaveLength(6);
    expect(parsePacket(packet)).toEqual(packet);
    for (const { revision: r } of packet.changes) {
      expect(r.payload!.project).toBe('');
      const original = canonicalJson(r);
      expect(validateRevision(r)).toEqual(r);
      expect(canonicalJson(r)).toBe(original);
      const { id, ...body } = r;
      expect(id).toBe(sha256Base64Url(canonicalJson(body)));
      expect(() => validateRevision({ ...r, payload: { ...r.payload, project: 'changed' } })).toThrow('hash mismatch');
    }
    assertRows(a, 1);
  });

  it('reconciles a shared legacy baseline without duplicating empty-project content', () => {
    const a = device(), b = device(); seed(a, 'shared'); seed(b, 'shared');
    const baseline = a.sync.baseline();
    expect(b.sync.reconcile(baseline)).toEqual({ matched: 6, independent: 0, ambiguous: [] });
    a.sync.setup({ baseline }); b.sync.setup({ baseline });
    settle(a, b);
    assertRows(a, 1); assertRows(b, 1);
  });

  it('roundtrips independent legacy rows and reverse edits with joined prompts and no echo', () => {
    const a = device(), b = device(); seed(a, 'a'); seed(b, 'b');
    a.sync.setup({ independent: true }); b.sync.setup({ independent: true });
    settle(a, b);
    for (const d of [a, b]) assertRows(d, 2);
    b.store.db.query("UPDATE observations SET title='reverse edit' WHERE memory_session_id='memory-a'").run();
    b.store.db.query("UPDATE session_summaries SET request='reverse edit' WHERE memory_session_id='memory-a'").run();
    b.store.db.query("UPDATE user_prompts SET prompt_text='reverse edit' WHERE content_session_id LIKE 'a-%'").run();
    b.store.db.query("UPDATE sdk_sessions SET custom_title='reverse edit' WHERE content_session_id LIKE 'a-%'").run();
    settle(b, a);
    for (const d of [a, b]) {
      assertRows(d, 2);
      expect(d.store.db.query("SELECT title FROM observations WHERE memory_session_id='memory-a'").get()).toEqual({ title: 'reverse edit' });
      expect(d.store.db.query("SELECT request FROM session_summaries WHERE memory_session_id='memory-a'").get()).toEqual({ request: 'reverse edit' });
      expect(d.store.db.query("SELECT prompt_text FROM user_prompts WHERE content_session_id LIKE 'a-%'").all()).toEqual([{ prompt_text: 'reverse edit' }, { prompt_text: 'reverse edit' }]);
      expect(d.store.db.query("SELECT custom_title FROM sdk_sessions WHERE content_session_id LIKE 'a-%'").all()).toEqual([{ custom_title: 'reverse edit' }, { custom_title: 'reverse edit' }]);
    }
    const heads = [a.sync.head(), b.sync.head()];
    settle(a, b); settle(b, a);
    expect([a.sync.head(), b.sync.head()]).toEqual(heads);
  });

  it('only permits exactly empty project in private content, keeping all other validation', () => {
    const a = device(); seed(a, 'a');
    for (const kind of ['observation', 'summary', 'prompt'] as const) {
      const p = payload(a, kind);
      expect(makeRevision(kind, p).payload).toEqual(p);
      for (const project of [null, 0, false, ' ', 'x'.repeat(4097)]) expect(() => makeRevision(kind, { ...p, project })).toThrow();
      const { project: _project, ...missing } = p;
      expect(() => makeRevision(kind, missing)).toThrow();
      expect(() => makeRevision(kind, { ...p, extra: true })).toThrow();
      expect(() => makeRevision(kind, { ...p, created_at_epoch: '9007199254740992' })).toThrow();
      expect(() => buildContentOperation({ kind, originDeviceId: OWNER, originLocalId: '1', entityRev: '1', payload: p })).toThrow();
      const valid = buildContentOperation({ kind, originDeviceId: OWNER, originLocalId: '1', entityRev: '1', payload: { ...p, project: 'valid' } });
      const body = JSON.parse(valid.body);
      body.payload = p; body.payload_sha256 = sha256Base64Url(canonicalJson(p));
      const wire = canonicalJson(body);
      expect(() => parseCanonicalOperation({ body: wire, operation_sha256: sha256Base64Url(wire) })).toThrow();
    }
    const p = payload(a, 'session');
    expect(makeRevision('session', p).payload).toEqual(p);
    for (const project of [null, 0, false, 'x'.repeat(4097)]) expect(() => makeRevision('session', { ...p, project })).toThrow();
    for (const field of ['content_session_id', 'memory_session_id', 'platform_source']) expect(() => makeRevision('session', { ...p, [field]: '' })).toThrow();
    const work = { scope_project: 'project', project: 'project', list_name: 'release', fields: { task: 'ship' }, created_at: ISO, created_at_epoch: EPOCH };
    expect(makeRevision('work', work).payload).toEqual(work);
    for (const field of ['scope_project', 'project', 'list_name']) expect(() => makeRevision('work', { ...work, [field]: '' })).toThrow();
    expect(() => makeRevision('work', { ...work, fields: { '': 'invalid' } })).toThrow();
  });

  it('preserves private prompt fallback while leaving nonprivate rejection and orphan behavior unchanged', () => {
    const source = device(); seed(source, 'source');
    const privateDevice = device(), cloudDevice = device();
    const privateApply = new SyncApply(privateDevice.store.db, { deviceId: 'private' });
    const cloudApply = new SyncApply(cloudDevice.store.db, { deviceId: 'cloud' });
    for (const [i, kind] of (['observation', 'summary', 'prompt'] as const).entries()) {
      const p = payload(source, kind);
      const validated = makeRevision(kind, p);
      expect(privateApply.applySelfHostedRow(op(kind, validated.payload!))).not.toBeNull();
      const result = cloudApply.applyOps([op(kind, p, String(i + 1))]);
      expect(result.quarantined).toBe(kind === 'prompt' ? 0 : 1);
    }
    expect(privateDevice.store.db.query('SELECT s.project FROM user_prompts p JOIN sdk_sessions s ON s.id=p.session_db_id').all()).toEqual([{ project: '' }]);
    expect(cloudDevice.store.db.query('SELECT session_db_id FROM user_prompts').get()).toEqual({ session_db_id: null });
    expect(cloudDevice.store.db.query('SELECT COUNT(*) AS n FROM sdk_sessions').get()).toEqual({ n: 0 });
  });
});
