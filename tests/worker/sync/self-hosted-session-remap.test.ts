import { afterEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SelfHostedSync } from '../../../src/services/sync/self-hosted/SelfHostedSync.js';
import { canonicalJson, sha256Base64Url } from '../../../src/services/sync/CanonicalContent.js';
import { TABLES, portablePayload, type Kind } from '../../../src/services/sync/self-hosted/protocol.js';
import type { BootstrapPlan } from '../../../src/services/sync/self-hosted/bootstrap.js';
import { MAX_SESSION_REMAP_BYTES } from '../../../src/services/sync/self-hosted/session-remap.js';
import type { SessionRemapPlan } from '../../../src/services/sync/self-hosted/session-remap.js';
const stores: SessionStore[] = [];
const hash = (v: unknown) => sha256Base64Url(canonicalJson(v));
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function rows(store: SessionStore, kind: Kind): Array<Record<string, any>> {
  return store.db.query(kind === 'prompt' ? `SELECT p.*,s.memory_session_id,s.project,s.platform_source FROM user_prompts p JOIN sdk_sessions s ON s.id=p.session_db_id ORDER BY p.id` : `SELECT * FROM ${TABLES[kind]} ORDER BY id`).all();
}
function portable(store: SessionStore) { return Object.fromEntries(Object.keys(TABLES).map(k => [k, rows(store, k as Kind).map(r => portablePayload(k as Kind, r))])); }
function native(store: SessionStore) { return Object.values(TABLES).map(t => store.db.query(`SELECT * FROM ${t} ORDER BY id`).all()); }
function makeFixture(combined = false, originalCompletion: string | null = null, otherSession = false) {
  const a = new SessionStore(':memory:', { syncOpsEnabled: false }), b = new SessionStore(':memory:', { syncOpsEnabled: false }); stores.push(a, b);
  for (const s of [a, b]) {
    s.db.exec(`INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status) VALUES('shared','old','project','2026-10-12T00:00:00.000Z',1791763200000,'completed')`);
    for (let i = 0; i < 13; i++) s.db.query(`INSERT INTO observations(memory_session_id,project,type,title,narrative,created_at,created_at_epoch) VALUES('old','project','discovery',?,'preserved','2026-10-12T00:00:00.000Z',1791763200000)`).run(`observation ${i}`);
    for (let i = 0; i < 6; i++) s.db.query(`INSERT INTO session_summaries(memory_session_id,project,request,created_at,created_at_epoch) VALUES('old','project',?,'2026-10-12T00:00:00.000Z',1791763200000)`).run(`summary ${i}`);
    for (let i = 0; i < 8; i++) s.db.query(`INSERT INTO user_prompts(session_db_id,content_session_id,prompt_number,prompt_text,created_at,created_at_epoch) VALUES(1,'shared',?,'preserved','2026-10-12T00:00:00.000Z',1791763200000)`).run(i+1);
  }
  for (const s of [a, b]) {
    if (originalCompletion) s.db.query('UPDATE sdk_sessions SET completed_at=?,completed_at_epoch=? WHERE id=1').run(originalCompletion, Date.parse(originalCompletion));
    if (otherSession) s.db.exec("INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status) VALUES('other','other-memory','project','2026-10-12T00:00:00.000Z',1791763200000,'completed')");
  }
  const left = new SelfHostedSync(a.db), right = new SelfHostedSync(b.db), baseline = left.baseline();
  const old = portable(a);
  a.updateMemorySessionId(1, 'codex-shared-1791849600000');
  const plan: SessionRemapPlan = {
    protocol: baseline.protocol, namespace: baseline.namespace, schema: baseline.schema, manifestHash: hash(baseline),
    sessionLocal: '1', oldMemorySessionId: 'old', newMemorySessionId: 'codex-shared-1791849600000', reason: 'Reviewed provider reference change with complete graph', independentRows: [],
    rows: baseline.rows.filter(r => r.kind !== 'session' || r.local === '1').map(r => ({ ...r, kind: r.kind as SessionRemapPlan['rows'][number]['kind'], expectedHash: r.hash, currentHash: hash(portablePayload(r.kind, rows(a, r.kind).find(row => String(row.id) === r.local)!)), baselinePayload: old[r.kind][Number(r.local)-1] })).map(({ hash: _, ...r }) => r),
  };
  if (combined) {
    const parent = plan.rows.find(r => r.kind === 'session')!;
    plan.parentCompletion = { mode: 'completion-pair-after-remap-v1', referenceOnlyHash: parent.currentHash, reason: 'Reviewed combined completion against original baseline' };
    a.db.query('UPDATE sdk_sessions SET completed_at=?,completed_at_epoch=? WHERE id=1').run('2026-10-13T00:00:00.000Z', Date.parse('2026-10-13T00:00:00.000Z'));
    parent.currentHash = hash(portablePayload('session', rows(a, 'session')[0]));
  }
  return { a, b, left, right, baseline, plan };
}
function settle(a: SelfHostedSync, b: SelfHostedSync) {
  for (let i=0;i<12;i++) { const request=a.prepare(b.status().device as string); a.accept(b.exchange(request),request); }
}
for (const combined of [false, true]) describe(`audited whole-session reference bootstrap (combined=${combined})`, () => {
  const fixture = () => makeFixture(combined);
  for (const order of ['old-root-first','remap-first']) it(`preserves 28 roots and causal deltas across page boundaries: ${order}`, () => {
    const f=fixture(), before=portable(f.a);
    f.left.setup({baseline:f.baseline,sessionRemapPlan:f.plan}); f.right.setup({baseline:f.baseline});
    expect(portable(f.a)).toEqual(before);
    const logs=f.a.db.query('SELECT body FROM self_sync_log ORDER BY seq').all().map((r:any)=>JSON.parse(r.body));
    expect(logs).toHaveLength(56);
    for (const root of logs.filter(r=>!r.parents.length)) {
      const child=logs.find(r=>r.parents.includes(root.id));
      expect(child).toBeDefined(); expect(child.owner).toBe(f.baseline.namespace); expect(child.local).toBe(root.local); expect(child.actor).toBe(f.left.status().device);
      expect(hash(root.payload)).toBe(f.baseline.rows.find(r=>r.kind===root.kind&&r.local===root.local)!.hash);
    }
    if(order==='old-root-first') settle(f.right,f.left); else settle(f.left,f.right);
    settle(f.left,f.right);
    for(const s of [f.a,f.b]) { expect(portable(s)).toEqual(before); expect(s.db.query('PRAGMA foreign_key_check').all()).toEqual([]); expect(s.db.query('SELECT DISTINCT owner FROM self_sync_map').all()).toEqual([{owner:f.baseline.namespace}]); }
    for(const sync of [f.left,f.right]) {expect(sync.status().conflicts).toEqual([]);expect(sync.status().projectionErrors).toEqual([]);expect(sync.head()).toBe(56);}
    const snapshots=[native(f.a),native(f.b)];settle(f.right,f.left);expect([native(f.a),native(f.b)]).toEqual(snapshots);expect([f.left.head(),f.right.head()]).toEqual([56,56]);
    expect(()=>f.left.setup({baseline:f.baseline,sessionRemapPlan:f.plan})).toThrow('already configured');
  });
  const cases: Array<[string,(f:ReturnType<typeof fixture>)=>void]> = [
    ['missing plan',f=>{ f.plan=undefined as any; }],
    ['manifest drift',f=>{f.plan.manifestHash=hash('drift');}],
    ['forged baseline',f=>{f.plan.rows[0].baselinePayload.project='other';}],
    ['wrong old reference',f=>{f.plan.oldMemorySessionId='wrong';}],
    ['wrong new reference',f=>{f.plan.newMemorySessionId='wrong';}],
    ['null reference',f=>{f.plan.oldMemorySessionId=null as any;}],
    ['same reference',f=>{f.plan.newMemorySessionId=f.plan.oldMemorySessionId;}],
    ['wrong parent',f=>{f.plan.sessionLocal='99';}],
    ['no parent',f=>{f.plan.rows=f.plan.rows.filter(r=>r.kind!=='session');}],
    ['partial graph',f=>{f.plan.rows.pop();}],
    ['duplicate graph entry',f=>{f.plan.rows.push(f.plan.rows[0]);}],
    ['unknown graph member',f=>{f.plan.rows[0].local='999';}],
    ['malformed extra authority',f=>{(f.plan as any).independent=true;}],
    ['work member',f=>{(f.plan.rows[0] as any).kind='work';}],
    ['stale current hash',f=>{f.a.db.exec("UPDATE observations SET narrative='changed' WHERE id=1");}],
    ['reviewed unrelated field',f=>{f.a.db.exec("UPDATE observations SET narrative='changed' WHERE id=1");f.plan.rows.find(r=>r.kind==='observation')!.currentHash=hash(portablePayload('observation',rows(f.a,'observation')[0]));}],
    ['deleted member',f=>{f.a.db.exec('DELETE FROM observations WHERE id=1');}],
    ['independent dependent',f=>{f.a.db.exec("INSERT INTO observations(memory_session_id,project,type,created_at,created_at_epoch) VALUES('codex-shared-1791849600000','project','discovery','2026-10-12T00:00:00.000Z',1791763200000)");}],
    ['old reference collision',f=>{f.a.db.exec("INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch) VALUES('other','old','project','2026-10-12T00:00:00.000Z',1791763200000)");}],
    ['prompt wrong parent',f=>{f.a.db.exec("UPDATE user_prompts SET content_session_id='wrong' WHERE id=1");f.plan.rows.find(r=>r.kind==='prompt')!.currentHash=hash(portablePayload('prompt',rows(f.a,'prompt')[0]));}],
  ];
  for(const [label,mutate]of cases)it(`rejects ${label} atomically`,()=>{
    const f=fixture();mutate(f);const before=native(f.a);
    expect(()=>f.left.setup({baseline:f.baseline,sessionRemapPlan:f.plan})).toThrow();
    expect(native(f.a)).toEqual(before);expect(f.left.configured()).toBe(false);expect(f.a.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'self_sync_%'").all()).toEqual([]);
  });
  it('requires hash-bound review of every independent dependent and preserves its device ownership',()=>{
    const f=fixture();
    f.a.db.exec("INSERT INTO observations(memory_session_id,project,type,narrative,created_at,created_at_epoch) VALUES('codex-shared-1791849600000','project','discovery','new local content','2026-10-13T00:00:00.000Z',1791849600000)");
    const row=rows(f.a,'observation').at(-1)!;
    f.plan.independentRows.push({kind:'observation',local:String(row.id),expectedHash:null,currentHash:hash(portablePayload('observation',row))});
    const before=portable(f.a); f.left.setup({baseline:f.baseline,sessionRemapPlan:f.plan}); f.right.setup({baseline:f.baseline});settle(f.left,f.right);
    for(const s of [f.a,f.b]) {expect(portable(s)).toEqual(before);expect(s.db.query("SELECT owner,local FROM self_sync_map WHERE kind='observation' AND local='14'").get()).toEqual({owner:f.left.status().device,local:'14'});}
    expect(f.left.status().conflicts).toEqual([]);expect(f.right.status().projectionErrors).toEqual([]);
  });
  for(const drift of ['missing','stale','duplicate','baseline','foreign-owner']) it(`rejects independent member ${drift}`,()=>{
    const f=fixture();f.a.db.exec("INSERT INTO observations(memory_session_id,project,type,narrative,created_at,created_at_epoch) VALUES('codex-shared-1791849600000','project','discovery','new local content','2026-10-13T00:00:00.000Z',1791849600000)");
    const row=rows(f.a,'observation').at(-1)!;f.plan.independentRows=[{kind:'observation',local:String(row.id),expectedHash:null,currentHash:hash(portablePayload('observation',row))}];
    if(drift==='missing')f.plan.independentRows=[];
    if(drift==='stale')f.a.db.exec("UPDATE observations SET narrative='later' WHERE id=14");
    if(drift==='duplicate')f.plan.independentRows.push(f.plan.independentRows[0]);
    if(drift==='baseline')f.plan.independentRows[0].local='1';
    if(drift==='foreign-owner')f.a.db.query('UPDATE observations SET origin_device_id=?,origin_local_id=? WHERE id=14').run(crypto.randomUUID(),'14');
    const before=native(f.a);expect(()=>f.left.setup({baseline:f.baseline,sessionRemapPlan:f.plan})).toThrow();expect(native(f.a)).toEqual(before);expect(f.left.configured()).toBe(false);
  });
  it('rolls back graph roots, provenance, and identity when later setup validation fails',()=>{
    const f=fixture(),before=native(f.a);
    expect(()=>f.left.setup({baseline:f.baseline,sessionRemapPlan:f.plan,workProjectAliases:[['only-one']]})).toThrow('invalid work project aliases');
    expect(native(f.a)).toEqual(before);expect(f.a.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'self_sync_%'").all()).toEqual([]);
  });
  for (const failFirst of [false,true]) it(`preserves local receipts and atomically carries exact old references (rollback=${failFirst})`,()=>{
    const f=fixture();
    for (const [id,ref] of [['old-receipt','old'],['unbound',null],['historic','historic-reference']] as const) f.b.db.query("INSERT INTO tool_uses(tool_use_id,content_session_id,memory_session_id,session_db_id,project,tool_name,tool_input,tool_response,created_at,created_at_epoch) VALUES(?,'shared',?,1,'project','Read','private input','private response','2026-10-12T00:00:00.000Z',1791763200000)").run(id,ref);
    const before=f.b.db.query('SELECT * FROM tool_uses ORDER BY id').all() as any[];
    f.left.setup({baseline:f.baseline,sessionRemapPlan:f.plan});f.right.setup({baseline:f.baseline});
    if(failFirst)f.b.db.exec("CREATE TRIGGER reject_receipt_reference BEFORE UPDATE OF memory_session_id ON tool_uses BEGIN SELECT RAISE(ABORT,'receipt fault'); END");
    settle(f.left,f.right);
    if(failFirst){
      expect(f.b.db.query('SELECT * FROM tool_uses ORDER BY id').all()).toEqual(before);
      expect((f.b.db.query('SELECT memory_session_id FROM sdk_sessions WHERE id=1').get() as any).memory_session_id).toBe('old');
      expect(f.right.status().projectionErrors.length).toBeGreaterThan(0);
      f.b.db.exec('DROP TRIGGER reject_receipt_reference');settle(f.left,f.right);
    }
    const after=f.b.db.query('SELECT * FROM tool_uses ORDER BY id').all();
    expect(after).toEqual(before.map(r=>({...r,memory_session_id:r.memory_session_id==='old'?f.plan.newMemorySessionId:r.memory_session_id})));
    expect(f.right.status().projectionErrors).toEqual([]);expect(f.right.status().conflicts).toEqual([]);
    const heads=[f.left.head(),f.right.head()];settle(f.left,f.right);expect([f.left.head(),f.right.head()]).toEqual(heads);
  });
  it('retains genuine concurrent session edits as conflicts',()=>{
    const f=fixture();f.right.setup({baseline:f.baseline});f.b.db.exec("UPDATE sdk_sessions SET custom_title='concurrent' WHERE id=1");f.right.capture();
    f.left.setup({baseline:f.baseline,sessionRemapPlan:f.plan});settle(f.left,f.right);
    expect(f.left.status().conflicts).toHaveLength(1);expect(f.right.status().conflicts).toHaveLength(1);
  });
});

type Fixture = ReturnType<typeof makeFixture>;
const parent = (f: Fixture) => f.plan.rows.find(r => r.kind === 'session')!;
function refreshCurrent(f: Fixture) {
  for (const entry of f.plan.rows) entry.currentHash = hash(portablePayload(entry.kind, rows(f.a, entry.kind).find(r => String(r.id) === entry.local)!));
}
function setCompletion(f: Fixture, at: string | null, epoch: number | null) {
  f.a.db.query('UPDATE sdk_sessions SET completed_at=?,completed_at_epoch=? WHERE id=1').run(at, epoch);
  refreshCurrent(f);
}
function completionPlan(f: Fixture, local: string, baselinePayload: Record<string, unknown>): BootstrapPlan {
  return { protocol: f.baseline.protocol, namespace: f.baseline.namespace, schema: f.baseline.schema, manifestHash: hash(f.baseline), sessions: [{ local, expectedHash: f.baseline.rows.find(r => r.kind === 'session' && r.local === local)!.hash, currentHash: hash(portablePayload('session', rows(f.a, 'session').find(r => String(r.id) === local)!)), baselinePayload, allowedFields: ['completed_at', 'completed_at_epoch'], reason: 'Separately reviewed completion' }] };
}
function addIndependent(f: Fixture) {
  f.a.db.query("INSERT INTO observations(memory_session_id,project,type,narrative,created_at,created_at_epoch) VALUES(?,'project','discovery','independent','2026-10-13T00:00:00.000Z',1791849600000)").run(f.plan.newMemorySessionId);
  f.a.db.query("INSERT INTO session_summaries(memory_session_id,project,request,created_at,created_at_epoch) VALUES(?,'project','independent','2026-10-13T00:00:00.000Z',1791849600000)").run(f.plan.newMemorySessionId);
  f.a.db.exec("INSERT INTO user_prompts(session_db_id,content_session_id,prompt_number,prompt_text,created_at,created_at_epoch) VALUES(1,'shared',9,'independent','2026-10-13T00:00:00.000Z',1791849600000)");
  for (const kind of ['observation', 'summary', 'prompt'] as const) {
    const row = rows(f.a, kind).at(-1)!;
    f.plan.independentRows.push({ kind, local: String(row.id), expectedHash: null, currentHash: hash(portablePayload(kind, row)) });
  }
}
function assertRejected(f: Fixture, bootstrapPlan?: BootstrapPlan) {
  const before = native(f.a), baseline = canonicalJson(f.baseline);
  expect(() => f.left.setup({ baseline: f.baseline, sessionRemapPlan: f.plan, bootstrapPlan })).toThrow();
  expect(native(f.a)).toEqual(before);
  expect(canonicalJson(f.baseline)).toBe(baseline);
  expect(f.left.configured()).toBe(false);
  expect(f.a.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'self_sync_%'").all()).toEqual([]);
}

describe('strict combined parent completion witness', () => {
  for (const original of [null, '2026-10-12T01:00:00.000Z']) {
    for (const order of ['old-root-first', 'remap-first']) it(`keeps B -> C only, other completion approvals and all independent kinds (${original}, ${order})`, () => {
      const f = makeFixture(true, original, true);
      const otherBaseline = portablePayload('session', rows(f.a, 'session')[1]);
      f.a.db.exec("UPDATE sdk_sessions SET completed_at='2026-10-13T00:00:00.000Z',completed_at_epoch=1791849600000 WHERE id=2");
      const other = completionPlan(f, '2', otherBaseline);
      addIndependent(f);
      const before = portable(f.a), manifest = canonicalJson(f.baseline), input = canonicalJson(f.plan);
      f.left.setup({ baseline: f.baseline, sessionRemapPlan: f.plan, bootstrapPlan: other });
      f.right.setup({ baseline: f.baseline });
      expect(portable(f.a)).toEqual(before);
      expect(canonicalJson(f.baseline)).toBe(manifest); expect(canonicalJson(f.plan)).toBe(input);
      const logs = f.a.db.query('SELECT body FROM self_sync_log ORDER BY seq').all().map((r: any) => JSON.parse(r.body));
      const history = logs.filter(r => r.kind === 'session' && r.local === '1');
      expect(history).toHaveLength(2);
      expect(history[0].payload).toEqual(parent(f).baselinePayload);
      expect(history[0].owner).toBe(f.baseline.namespace);
      expect(history[1].parents).toEqual([history[0].id]);
      expect(history[1].payload).toEqual(before.session[0]);
      expect(history.some(r => hash(r.payload) === f.plan.parentCompletion!.referenceOnlyHash)).toBe(false);
      expect(f.left.prepare(f.right.status().device as string).changes.length).toBeLessThan(logs.length);
      if (order === 'old-root-first') settle(f.right, f.left); else settle(f.left, f.right);
      settle(f.left, f.right);
      for (const store of [f.a, f.b]) {
        expect(portable(store)).toEqual(before);
        expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
        for (const entry of f.plan.independentRows) expect(store.db.query('SELECT owner FROM self_sync_map WHERE kind=? AND local=?').get(entry.kind, entry.local)).toEqual({ owner: f.left.status().device });
      }
      for (const sync of [f.left, f.right]) { expect(sync.status().conflicts).toEqual([]); expect(sync.status().projectionErrors).toEqual([]); expect(sync.head()).toBe(61); }
      const snapshots = [native(f.a), native(f.b)]; settle(f.right, f.left);
      expect([native(f.a), native(f.b)]).toEqual(snapshots); expect([f.left.head(), f.right.head()]).toEqual([61, 61]);
    });
  }

  const cases: Array<[string, (f: Fixture) => void]> = [
    ['absent exception', f => { delete f.plan.parentCompletion; }],
    ['unchanged pair / reference only', f => setCompletion(f, null, null)],
    ['only date changed', f => setCompletion(f, '2026-10-13T00:00:00.000Z', null)],
    ['only epoch changed', f => setCompletion(f, null, 1791849600000)],
    ['invalid date', f => setCompletion(f, 'not-a-date', 1791849600000)],
    ['inconsistent pair', f => setCompletion(f, '2026-10-13T00:00:00.000Z', 1)],
    ['negative epoch', f => setCompletion(f, '1969-12-31T23:59:59.999Z', -1)],
    ['fractional epoch', f => setCompletion(f, '2026-10-13T00:00:00.000Z', 1791849600000.5)],
    ['wrong B hash', f => { parent(f).expectedHash = hash('wrong'); }],
    ['forged B with refreshed B/I', f => { parent(f).baselinePayload.custom_title = 'forged'; parent(f).expectedHash = hash(parent(f).baselinePayload); f.plan.parentCompletion!.referenceOnlyHash = hash({ ...parent(f).baselinePayload, memory_session_id: f.plan.newMemorySessionId }); }],
    ['wrong I hash', f => { f.plan.parentCompletion!.referenceOnlyHash = hash('wrong'); }],
    ['C hash substituted for I', f => { f.plan.parentCompletion!.referenceOnlyHash = parent(f).currentHash; }],
    ['wrong C hash', f => { parent(f).currentHash = hash('wrong'); }],
    ['wrong manifest hash', f => { f.plan.manifestHash = hash('wrong'); }],
    ['namespace drift', f => { f.plan.namespace = crypto.randomUUID(); }],
    ['schema drift', f => { f.plan.schema++; }],
    ['later parent drift', f => { f.a.db.exec("UPDATE sdk_sessions SET completed_at='2026-10-14T00:00:00.000Z',completed_at_epoch=1791936000000 WHERE id=1"); }],
    ['later dependent drift', f => { f.a.db.exec("UPDATE session_summaries SET request='later' WHERE id=1"); }],
    ['unknown property', f => { (f.plan.parentCompletion as any).allowedFields = ['custom_title']; }],
    ['unknown mode', f => { (f.plan.parentCompletion as any).mode = 'completion-v2'; }],
    ['missing mode', f => { delete (f.plan.parentCompletion as any).mode; }],
    ['missing witness', f => { delete (f.plan.parentCompletion as any).referenceOnlyHash; }],
    ['missing reason', f => { delete (f.plan.parentCompletion as any).reason; }],
    ['empty reason', f => { f.plan.parentCompletion!.reason = ''; }],
    ['oversize reason', f => { f.plan.parentCompletion!.reason = 'x'.repeat(513); }],
    ['null exception', f => { f.plan.parentCompletion = null as any; }],
    ['malformed witness hash', f => { f.plan.parentCompletion!.referenceOnlyHash = '!'.repeat(43); }],
    ['malformed B hash', f => { parent(f).expectedHash = 'bad'; }],
    ['malformed C hash', f => { parent(f).currentHash = 'bad'; }],
    ['oversize plan', f => { f.plan.reason = 'x'.repeat(MAX_SESSION_REMAP_BYTES); }],
    ['duplicate baseline', f => { f.baseline.rows.push(f.baseline.rows[0]); f.plan.manifestHash = hash(f.baseline); }],
    ['baseline schema drift with refreshed manifest', f => { f.baseline.schema++; f.plan.schema = f.baseline.schema; f.plan.manifestHash = hash(f.baseline); }],
    ['unknown baseline payload field with refreshed hashes', f => { parent(f).baselinePayload.extra = 'unapproved'; parent(f).expectedHash = hash(parent(f).baselinePayload); f.baseline.rows[0].hash = parent(f).expectedHash; f.plan.manifestHash = hash(f.baseline); f.plan.parentCompletion!.referenceOnlyHash = hash({ ...parent(f).baselinePayload, memory_session_id: f.plan.newMemorySessionId }); }],
    ['missing baseline member', f => { f.baseline.rows.shift(); f.plan.manifestHash = hash(f.baseline); }],
    ['missing parent graph member', f => { f.plan.rows.shift(); }],
    ['oversize shared graph', f => { f.plan.rows = Array.from({ length: 4097 }, () => parent(f)); }],
    ['oversize independent graph', f => { f.plan.independentRows = Array.from({ length: 4097 }, () => ({ kind: 'observation', local: '99', expectedHash: null, currentHash: hash('independent') })); }],
    ['second graph parent', f => { f.plan.rows.push({ ...parent(f), local: '2' }); }],
    ['foreign key violation', f => { f.a.db.exec("PRAGMA foreign_keys=OFF; UPDATE observations SET memory_session_id='orphan' WHERE id=1; PRAGMA foreign_keys=ON"); refreshCurrent(f); }],
  ];
  for (const field of ['custom_title', 'project', 'content_session_id', 'platform_source', 'observed_model', 'observed_billing', 'user_prompt'] as const) {
    cases.push([`extra ${field} with refreshed C hash`, f => { f.a.db.query(`UPDATE sdk_sessions SET ${field}='unapproved' WHERE id=1`).run(); refreshCurrent(f); }]);
  }
  for (const [label, mutate] of cases) it(`rejects ${label} without state or mutation`, () => { const f = makeFixture(true); mutate(f); assertRejected(f); });

  for (const [label, at, epoch] of [
    ['backward', '2026-10-12T00:00:00.000Z', 1791763200000],
    ['null pair', null, null],
    ['unchanged pair', '2026-10-12T01:00:00.000Z', 1791766800000],
  ] as const) it(`rejects ${label} against original non-null completion`, () => {
    const f = makeFixture(true, '2026-10-12T01:00:00.000Z'); setCompletion(f, at, epoch); assertRejected(f);
  });
  it('rejects overlapping standalone completion approval for the same parent', () => {
    const f = makeFixture(true); assertRejected(f, completionPlan(f, '1', parent(f).baselinePayload));
  });
  it('requires the original baseline even with a fully populated exception', () => {
    const f = makeFixture(true), before = native(f.a);
    expect(() => f.left.setup({ independent: true, sessionRemapPlan: f.plan })).toThrow('requires a shared baseline');
    expect(native(f.a)).toEqual(before); expect(f.left.configured()).toBe(false);
  });
  it('rejects missing baseline rows outside the approved graph', () => {
    const f = makeFixture(true, null, true); f.a.db.exec('DELETE FROM sdk_sessions WHERE id=2'); assertRejected(f);
  });
  it('rejects unrelated foreign-key violations after validating the combined graph', () => {
    const f = makeFixture(true), before = native(f.a);
    f.a.db.exec("PRAGMA foreign_keys=OFF; INSERT INTO observations(memory_session_id,project,type,created_at,created_at_epoch) VALUES('orphan','project','discovery','2026-10-12T00:00:00.000Z',1791763200000); PRAGMA foreign_keys=ON");
    expect(() => f.left.setup({ baseline: f.baseline, sessionRemapPlan: f.plan })).toThrow('requires valid foreign keys');
    expect(f.left.configured()).toBe(false);
    expect(f.a.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'self_sync_%'").all()).toEqual([]);
    f.a.db.exec("DELETE FROM observations WHERE memory_session_id='orphan'"); expect(native(f.a)).toEqual(before);
  });
  it('rejects a remap exception supplied to the strict completion-only contract', () => {
    const f = makeFixture(true), plan = completionPlan(f, '1', parent(f).baselinePayload);
    (plan as any).parentCompletion = f.plan.parentCompletion;
    expect(() => f.left.setup({ baseline: f.baseline, bootstrapPlan: plan })).toThrow();
    expect(f.left.configured()).toBe(false);
  });
  for (const kind of ['observation', 'summary', 'prompt'] as const) {
    for (const drift of ['missing', 'baseline', 'foreign-owner', 'foreign-local', 'stale', 'duplicate', 'wrong-reference'] as const) it(`rejects combined independent ${kind} ${drift}`, () => {
      const f = makeFixture(true); addIndependent(f);
      const entry = f.plan.independentRows.find(r => r.kind === kind)!;
      if (drift === 'missing') f.plan.independentRows = f.plan.independentRows.filter(r => r !== entry);
      if (drift === 'baseline') entry.local = '1';
      if (drift === 'foreign-owner') f.a.db.query(`UPDATE ${TABLES[kind]} SET origin_device_id=? WHERE id=?`).run(crypto.randomUUID(), entry.local);
      if (drift === 'foreign-local') f.a.db.query(`UPDATE ${TABLES[kind]} SET origin_local_id='owned' WHERE id=?`).run(entry.local);
      if (drift === 'stale') entry.currentHash = hash('stale');
      if (drift === 'duplicate') f.plan.independentRows.push(entry);
      if (drift === 'wrong-reference') {
        if (kind === 'prompt') f.a.db.query("UPDATE user_prompts SET content_session_id='wrong' WHERE id=?").run(entry.local);
        else f.a.db.exec(`PRAGMA foreign_keys=OFF; UPDATE ${TABLES[kind]} SET memory_session_id='wrong' WHERE id=${Number(entry.local)}; PRAGMA foreign_keys=ON`);
        entry.currentHash = hash(portablePayload(kind, rows(f.a, kind).at(-1)!));
      }
      assertRejected(f);
    });
  }

  for (const fault of ['receipt', 'second-index-job']) it(`rolls back every native effect and job on combined ${fault} failure, then retries`, () => {
    const f = makeFixture(true);
    f.b.db.exec("INSERT INTO tool_uses(tool_use_id,content_session_id,memory_session_id,session_db_id,project,tool_name,tool_input,tool_response,created_at,created_at_epoch) VALUES('receipt','shared','old',1,'project','Read','private input','private response','2026-10-12T00:00:00.000Z',1791763200000)");
    f.left.setup({ baseline: f.baseline, sessionRemapPlan: f.plan }); f.right.setup({ baseline: f.baseline });
    const send = (limit: number) => {
      const request = f.left.prepare(f.right.status().device as string); request.changes = request.changes.slice(0, limit);
      f.left.accept(f.right.exchange(request), request);
    };
    send(24); send(4); // Deliver exactly B roots, leaving the combined parent C next.
    const before = native(f.b), receipts = f.b.db.query('SELECT * FROM tool_uses').all();
    const mappings = f.b.db.query('SELECT * FROM self_sync_map ORDER BY entity').all();
    const jobs = f.b.db.query('SELECT * FROM self_sync_jobs ORDER BY id').all();
    const capture = f.b.db.query('SELECT * FROM self_sync_capture').all();
    if (fault === 'receipt') f.b.db.exec("CREATE TRIGGER reject_combined BEFORE UPDATE ON tool_uses BEGIN SELECT RAISE(ABORT,'receipt fault'); END");
    else f.b.db.exec(`CREATE TRIGGER reject_combined BEFORE INSERT ON self_sync_jobs WHEN (SELECT COUNT(*) FROM self_sync_jobs)>${jobs.length} BEGIN SELECT RAISE(ABORT,'late job fault'); END`);
    send(1);
    expect(native(f.b)).toEqual(before); expect(f.b.db.query('SELECT * FROM tool_uses').all()).toEqual(receipts);
    expect(f.b.db.query('SELECT * FROM self_sync_map ORDER BY entity').all()).toEqual(mappings);
    expect(f.b.db.query('SELECT * FROM self_sync_jobs ORDER BY id').all()).toEqual(jobs);
    expect(f.b.db.query('SELECT * FROM self_sync_capture').all()).toEqual(capture);
    expect(f.right.status().projectionErrors).toHaveLength(1);
    f.b.db.exec('DROP TRIGGER reject_combined'); settle(f.left, f.right);
    expect(portable(f.b)).toEqual(portable(f.a));
    expect(f.b.db.query('SELECT * FROM tool_uses').all()).toEqual(receipts.map((r: any) => ({ ...r, memory_session_id: f.plan.newMemorySessionId })));
    expect(f.right.status().projectionErrors).toEqual([]); expect(f.right.status().conflicts).toEqual([]);
    expect(f.right.status().pendingIndexJobs).toBeGreaterThan(jobs.length);
    settle(f.right, f.left); expect([f.left.head(), f.right.head()]).toEqual([56, 56]);
  });
  it('keeps a competing independently approved completion delta as an explicit conflict', () => {
    const f = makeFixture(true);
    const other = completionPlan(f, '1', parent(f).baselinePayload);
    f.b.db.exec("UPDATE sdk_sessions SET completed_at='2026-10-14T00:00:00.000Z',completed_at_epoch=1791936000000 WHERE id=1");
    other.sessions[0].currentHash = hash(portablePayload('session', rows(f.b, 'session')[0]));
    f.right.setup({ baseline: f.baseline, bootstrapPlan: other });
    f.left.setup({ baseline: f.baseline, sessionRemapPlan: f.plan }); settle(f.left, f.right);
    for (const sync of [f.left, f.right]) expect(sync.status().conflicts).toHaveLength(1);
  });
});
