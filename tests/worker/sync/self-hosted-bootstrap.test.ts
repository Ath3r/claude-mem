import { afterEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SelfHostedSync } from '../../../src/services/sync/self-hosted/SelfHostedSync.js';
import { canonicalJson, sha256Base64Url } from '../../../src/services/sync/CanonicalContent.js';
import { portablePayload, entityId } from '../../../src/services/sync/self-hosted/protocol.js';
import type { BootstrapPlan } from '../../../src/services/sync/self-hosted/bootstrap.js';
const stores: SessionStore[] = [];
const hash = (v: unknown) => sha256Base64Url(canonicalJson(v));
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function fixture() {
  const a = new SessionStore(':memory:', { syncOpsEnabled: false }), b = new SessionStore(':memory:', { syncOpsEnabled: false }); stores.push(a, b);
  for (const s of [a, b]) s.db.query("INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status) VALUES('shared','memory','project','2026-10-12T00:00:00.000Z',1791763200000,'completed')").run();
  const left = new SelfHostedSync(a.db), right = new SelfHostedSync(b.db), baseline = left.baseline();
  const payload = () => portablePayload('session', a.db.query('SELECT * FROM sdk_sessions WHERE id=1').get() as Record<string, unknown>);
  const baselinePayload = payload();
  a.db.query('UPDATE sdk_sessions SET completed_at=?,completed_at_epoch=? WHERE id=1').run('2026-10-13T00:00:00.000Z', Date.parse('2026-10-13T00:00:00.000Z'));
  const plan: BootstrapPlan = { protocol: baseline.protocol, namespace: baseline.namespace, schema: baseline.schema, manifestHash: hash(baseline), sessions: [{ local: '1', expectedHash: baseline.rows[0].hash, currentHash: hash(payload()), allowedFields: ['completed_at', 'completed_at_epoch'], baselinePayload, reason: 'Reviewed completion advance against immutable baseline' }] };
  return { a, b, left, right, baseline, plan, payload };
}
function settle(a: SelfHostedSync, b: SelfHostedSync) {
  for (let i = 0; i < 6; i++) { const request = a.prepare(b.status().device as string); a.accept(b.exchange(request), request); }
}
describe('audited shared session completion bootstrap', () => {
  it('preserves identity and advanced completion, with a shared root and causal local delta, retaining native rows', () => {
    const f = fixture();
    f.b.db.query("INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status) VALUES('vps-native','vps-memory','project','2026-10-13T00:00:00.000Z',1791849600000,'completed')").run();
    const before = f.payload();
    f.left.setup({ baseline: f.baseline, bootstrapPlan: f.plan }); f.right.setup({ baseline: f.baseline });
    expect(f.payload()).toEqual(before);
    const ops = f.a.db.query('SELECT body FROM self_sync_log ORDER BY seq').all().map((r: any) => JSON.parse(r.body));
    const root = JSON.parse((f.b.db.query('SELECT body FROM self_sync_log ORDER BY seq LIMIT 1').get() as any).body);
    expect(ops[0]).toEqual(root); expect(ops[1].parents).toEqual([root.id]);
    expect(ops[1].actor).toBe(f.left.status().device);
    settle(f.right, f.left); // unchanged peer sends its older root first
    settle(f.left, f.right);
    for (const s of [f.a, f.b]) {
      expect(s.db.query('SELECT COUNT(*) AS n FROM sdk_sessions').get()).toEqual({ n: 2 });
      expect(portablePayload('session', s.db.query("SELECT * FROM sdk_sessions WHERE content_session_id='shared'").get() as any)).toEqual(before);
      const mapping = s.db.query('SELECT owner,local FROM self_sync_map WHERE entity=?').get(entityId('session', f.baseline.namespace, '1'));
      expect(mapping).toEqual({ owner: f.baseline.namespace, local: '1' });
    }
    expect(f.left.status().conflicts).toEqual([]); expect(f.right.status().projectionErrors).toEqual([]);
    const heads = [f.left.head(), f.right.head()]; settle(f.left, f.right); expect([f.left.head(), f.right.head()]).toEqual(heads);
  });
  const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['missing approval', f => { f.plan = undefined as any; }],
    ['wrong manifest', f => { f.plan.manifestHash = hash('wrong'); }],
    ['wrong namespace', f => { f.plan.namespace = crypto.randomUUID(); }],
    ['wrong baseline hash', f => { f.plan.sessions[0].expectedHash = hash('wrong'); }],
    ['wrong current hash', f => { f.plan.sessions[0].currentHash = hash('wrong'); }],
    ['unknown row', f => { f.plan.sessions[0].local = '9'; }],
    ['duplicate approval', f => { f.plan.sessions.push(f.plan.sessions[0]); }],
    ['unreviewed identity drift', f => { f.a.db.query("UPDATE sdk_sessions SET content_session_id='other' WHERE id=1").run(); f.plan.sessions[0].currentHash = hash(f.payload()); }],
    ['forged baseline identity', f => { f.plan.sessions[0].baselinePayload.content_session_id = 'other'; }],
    ['unreviewed title change', f => { f.a.db.query("UPDATE sdk_sessions SET custom_title='changed' WHERE id=1").run(); f.plan.sessions[0].currentHash = hash(f.payload()); }],
    ['expanded fields', f => { f.plan.sessions[0].allowedFields.push('custom_title' as any); }],
    ['inconsistent completion', f => { f.a.db.query('UPDATE sdk_sessions SET completed_at_epoch=1 WHERE id=1').run(); f.plan.sessions[0].currentHash = hash(f.payload()); }],
    ['stale reviewed row', f => { f.a.db.query('UPDATE sdk_sessions SET completed_at_epoch=2 WHERE id=1').run(); }],
    ['unapproved extra row change', f => { f.a.db.query("INSERT INTO sdk_sessions(content_session_id,project,started_at,started_at_epoch) VALUES('extra','p','2026-10-12T00:00:00.000Z',1)").run(); f.baseline.rows.push({ kind: 'session', local: '2', hash: hash('prior') }); f.plan.manifestHash = hash(f.baseline); }],
  ];
  for (const [label, mutate] of mutations) it(`rejects ${label} without sync state or row mutation`, () => {
    const f = fixture(); mutate(f); const before = f.a.db.query('SELECT * FROM sdk_sessions').all();
    expect(() => f.left.setup({ baseline: f.baseline, bootstrapPlan: f.plan })).toThrow();
    expect(f.left.configured()).toBe(false);
    expect(f.a.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'self_sync_%'").all()).toEqual([]);
    expect(f.a.db.query('SELECT * FROM sdk_sessions').all()).toEqual(before);
  });
  it('keeps concurrent separately approved completion advances as explicit conflicts', () => {
    const f = fixture(); const otherPlan = structuredClone(f.plan);
    f.b.db.query('UPDATE sdk_sessions SET completed_at=?,completed_at_epoch=?').run('2026-10-14T00:00:00.000Z', Date.parse('2026-10-14T00:00:00.000Z'));
    otherPlan.sessions[0].currentHash = hash(portablePayload('session', f.b.db.query('SELECT * FROM sdk_sessions').get() as any));
    f.left.setup({ baseline: f.baseline, bootstrapPlan: f.plan }); f.right.setup({ baseline: f.baseline, bootstrapPlan: otherPlan }); settle(f.left, f.right);
    expect(f.left.status().conflicts).toHaveLength(1); expect(f.right.status().conflicts).toHaveLength(1);
  });
});
