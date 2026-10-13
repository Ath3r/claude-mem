import { afterEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SelfHostedSync } from '../../../src/services/sync/self-hosted/SelfHostedSync.js';
import { canonicalJson, sha256Base64Url } from '../../../src/services/sync/CanonicalContent.js';
import { TABLES, portablePayload, type Kind } from '../../../src/services/sync/self-hosted/protocol.js';
import type { SessionRemapPlan } from '../../../src/services/sync/self-hosted/session-remap.js';
const stores: SessionStore[] = [];
const hash = (v: unknown) => sha256Base64Url(canonicalJson(v));
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function rows(store: SessionStore, kind: Kind): Array<Record<string, any>> {
  return store.db.query(kind === 'prompt' ? `SELECT p.*,s.memory_session_id,s.project,s.platform_source FROM user_prompts p JOIN sdk_sessions s ON s.id=p.session_db_id ORDER BY p.id` : `SELECT * FROM ${TABLES[kind]} ORDER BY id`).all();
}
function portable(store: SessionStore) { return Object.fromEntries(Object.keys(TABLES).map(k => [k, rows(store, k as Kind).map(r => portablePayload(k as Kind, r))])); }
function native(store: SessionStore) { return Object.values(TABLES).map(t => store.db.query(`SELECT * FROM ${t} ORDER BY id`).all()); }
function fixture() {
  const a = new SessionStore(':memory:', { syncOpsEnabled: false }), b = new SessionStore(':memory:', { syncOpsEnabled: false }); stores.push(a, b);
  for (const s of [a, b]) {
    s.db.exec(`INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,started_at,started_at_epoch,status) VALUES('shared','old','project','2026-10-12T00:00:00.000Z',1791763200000,'completed')`);
    for (let i = 0; i < 13; i++) s.db.query(`INSERT INTO observations(memory_session_id,project,type,title,narrative,created_at,created_at_epoch) VALUES('old','project','discovery',?,'preserved','2026-10-12T00:00:00.000Z',1791763200000)`).run(`observation ${i}`);
    for (let i = 0; i < 6; i++) s.db.query(`INSERT INTO session_summaries(memory_session_id,project,request,created_at,created_at_epoch) VALUES('old','project',?,'2026-10-12T00:00:00.000Z',1791763200000)`).run(`summary ${i}`);
    for (let i = 0; i < 8; i++) s.db.query(`INSERT INTO user_prompts(session_db_id,content_session_id,prompt_number,prompt_text,created_at,created_at_epoch) VALUES(1,'shared',?,'preserved','2026-10-12T00:00:00.000Z',1791763200000)`).run(i+1);
  }
  const left = new SelfHostedSync(a.db), right = new SelfHostedSync(b.db), baseline = left.baseline();
  const old = portable(a);
  a.updateMemorySessionId(1, 'codex-shared-1791849600000');
  const plan: SessionRemapPlan = {
    protocol: baseline.protocol, namespace: baseline.namespace, schema: baseline.schema, manifestHash: hash(baseline),
    sessionLocal: '1', oldMemorySessionId: 'old', newMemorySessionId: 'codex-shared-1791849600000', reason: 'Reviewed provider reference change with complete graph', independentRows: [],
    rows: baseline.rows.map(r => ({ ...r, kind: r.kind as SessionRemapPlan['rows'][number]['kind'], expectedHash: r.hash, currentHash: hash(portablePayload(r.kind, rows(a, r.kind).find(row => String(row.id) === r.local)!)), baselinePayload: old[r.kind][Number(r.local)-1] })).map(({ hash: _, ...r }) => r),
  };
  return { a, b, left, right, baseline, plan };
}
function settle(a: SelfHostedSync, b: SelfHostedSync) {
  for (let i=0;i<12;i++) { const request=a.prepare(b.status().device as string); a.accept(b.exchange(request),request); }
}
describe('audited whole-session reference bootstrap', () => {
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
  it('retains genuine concurrent session edits as conflicts',()=>{
    const f=fixture();f.right.setup({baseline:f.baseline});f.b.db.exec("UPDATE sdk_sessions SET custom_title='concurrent' WHERE id=1");f.right.capture();
    f.left.setup({baseline:f.baseline,sessionRemapPlan:f.plan});settle(f.left,f.right);
    expect(f.left.status().conflicts).toHaveLength(1);expect(f.right.status().conflicts).toHaveLength(1);
  });
});
