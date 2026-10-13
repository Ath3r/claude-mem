import { describe, it, expect, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SelfHostedSync } from '../../../src/services/sync/self-hosted/SelfHostedSync.js';
import { onContextInvalidation } from '../../../src/shared/context-invalidation.js';
import { foldWorkStateList } from '../../../src/services/context/sections/WorkStateRenderer.js';
import { canonicalJson, sha256Base64Url } from '../../../src/services/sync/CanonicalContent.js';
import { PROTOCOL, revision, parsePacket } from '../../../src/services/sync/self-hosted/protocol.js';

const stores: SessionStore[] = [];
function device(options: ConstructorParameters<typeof SelfHostedSync>[1] = {}) {
  const store = new SessionStore(':memory:', { syncOpsEnabled: false }); stores.push(store); new SessionSearch(store.db);
  const sync = new SelfHostedSync(store.db, options); sync.setup({ independent: true });
  return { store, sync };
}
function records(store: SessionStore, tag: string) {
  const t = '2026-10-12T00:00:00.000Z', epoch = Date.parse(t);
  const session = Number(store.db.query(`INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,platform_source,user_prompt,started_at,started_at_epoch,status,custom_title) VALUES(?,?,?,'claude-code',?,?,?,'active',?)`).run(`content-${tag}`, `memory-${tag}`, 'project', `prompt-${tag}`, t, epoch, `title-${tag}`).lastInsertRowid);
  const obs = Number(store.db.query(`INSERT INTO observations(memory_session_id,project,type,title,facts,concepts,files_read,files_modified,created_at,created_at_epoch) VALUES(?,'project','discovery',?,'[]','[]','[]','[]',?,?)`).run(`memory-${tag}`, `obs-${tag}`, t, epoch).lastInsertRowid);
  store.db.query(`INSERT INTO session_summaries(memory_session_id,project,request,created_at,created_at_epoch) VALUES(?,'project',?,?,?)`).run(`memory-${tag}`, `summary-${tag}`, t, epoch);
  store.db.query(`INSERT INTO user_prompts(session_db_id,content_session_id,prompt_number,prompt_text,created_at,created_at_epoch) VALUES(?,?,1,?,?,?)`).run(session, `content-${tag}`, `prompt-${tag}`, t, epoch);
  return obs;
}
function round(a: SelfHostedSync, b: SelfHostedSync) {
  const peers = a.status().peers as unknown[];
  const request = a.prepare(peers.length ? b.status().device as string : undefined);
  const response = b.exchange(request); a.accept(response, request);
  return { request, response };
}
function settle(a: SelfHostedSync, b: SelfHostedSync) { for (let i = 0; i < 8; i++) round(a, b); }
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('private SSH sync causal journal', () => {
  it('refuses ambiguous alias activation without reopening native completed work', () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false }); stores.push(store);
    store.appendWorkStateEntry({ project: 'z-old', listName: 'release', fields: { task: 'ship', status: 'todo' }, createdAtEpoch: 9000 });
    store.appendWorkStateEntry({ project: 'a-new', listName: 'release', fields: { task: 'ship', status: 'done' }, createdAtEpoch: 1000 });
    const sync = new SelfHostedSync(store.db);
    expect(foldWorkStateList(store.getWorkStateEntries(['z-old', 'a-new'], 'release')).tasks.get('ship')!.fields.status).toBe('done');
    expect(() => sync.setup({ independent: true })).toThrow('ambiguous work project aliases');
    expect(sync.configured()).toBe(false);
    expect(foldWorkStateList(store.getWorkStateEntries(['z-old', 'a-new'], 'release')).tasks.get('ship')!.fields.status).toBe('done');
  });

  it('canonicalizes reviewed historical aliases in native append order and preserves completion after exchange', () => {
    const aStore = new SessionStore(':memory:', { syncOpsEnabled: false }); stores.push(aStore);
    const bStore = new SessionStore(':memory:', { syncOpsEnabled: false }); stores.push(bStore);
    const aliases = [['z-old', 'middle', 'a-new']];
    for (const store of [aStore, bStore]) {
      store.appendWorkStateEntry({ project: 'z-old', listName: 'release', fields: { task: 'ship', status: 'todo', details: 'retained' }, createdAtEpoch: 9000 });
      store.appendWorkStateEntry({ project: 'middle', listName: 'release', fields: { task: 'ship', status: 'doing' }, createdAtEpoch: 7000 });
      store.appendWorkStateEntry({ project: 'a-new', listName: 'release', fields: { task: 'ship', status: 'done' }, createdAtEpoch: 1000 });
    }
    const a = new SelfHostedSync(aStore.db), b = new SelfHostedSync(bStore.db), baseline = a.baseline();
    a.setup({ baseline, workProjectAliases: aliases }); b.setup({ baseline, workProjectAliases: aliases });
    const status = (store: SessionStore) => foldWorkStateList(store.getWorkStateEntries(['z-old', 'middle', 'A-NEW'], 'release')).tasks.get('ship')!.fields;
    expect(status(aStore)).toEqual({ task: 'ship', status: 'done', details: 'retained' });
    expect(aStore.getWorkStateEntries(['z-old'], 'release')[0].fields.status).toBe('done');
    settle(a, b);
    aStore.appendWorkStateEntry({ project: 'middle', listName: 'release', fields: { task: 'ship', details: 'later' } });
    settle(a, b);
    for (const store of [aStore, bStore]) expect(status(store)).toEqual({ task: 'ship', status: 'done', details: 'later' });
    // A real concurrent reopen is still visible across aliases.
    aStore.appendWorkStateEntry({ project: 'z-old', listName: 'release', fields: { task: 'ship', status: 'todo' } });
    bStore.appendWorkStateEntry({ project: 'a-new', listName: 'release', fields: { task: 'ship', status: 'done' } });
    settle(a, b);
    for (const store of [aStore, bStore]) expect(String(status(store).status)).toContain('SYNC_CONFLICT');
    bStore.appendWorkStateEntry({ project: 'middle', listName: 'release', fields: { task: 'ship', status: 'done' } });
    settle(b, a);
    for (const store of [aStore, bStore]) expect(status(store).status).toBe('done');
  });

  it('rejects a mismatched alias plan without committing work or peer checkpoints', () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false }); stores.push(store);
    store.appendWorkStateEntry({ project: 'legacy', listName: 'release', fields: { task: 'ship', status: 'done' } });
    const a = new SelfHostedSync(store.db), b = device();
    a.setup({ independent: true, workProjectAliases: [['legacy', 'canonical']] });
    expect(() => b.sync.exchange(a.prepare())).toThrow('work project alias plan mismatch');
    expect(b.sync.head()).toBe(0);
    expect(b.sync.status().peers).toEqual([]);
    expect(b.store.getWorkStateEntries(['legacy', 'canonical'])).toEqual([]);
  });

  it('refuses to serve a projection or capture from an older private journal protocol', () => {
    const a = device();
    a.store.appendWorkStateEntry({ project: 'project', listName: 'release', fields: { task: 'ship', status: 'done' } });
    a.sync.capture();
    a.store.db.query('UPDATE self_sync_config SET protocol=?').run(PROTOCOL - 1);
    expect(() => a.store.getWorkStateEntries(['project'], 'release')).toThrow('protocol mismatch');
    expect(() => a.sync.prepare()).toThrow('protocol mismatch');
  });

  it('preserves a genuine prompt edit made between the session page and prompt page', () => {
    const a = device(), b = device(); const t = '2026-10-12T00:00:00.000Z';
    for (let i = 0; i < 24; i++) a.store.db.query(`INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,platform_source,started_at,started_at_epoch,status) VALUES(?,?,'old','claude-code',?,1,'completed')`).run(`page-${i}`, `mem-${i}`, t);
    a.store.db.query(`INSERT INTO user_prompts(session_db_id,content_session_id,prompt_number,prompt_text,created_at,created_at_epoch) VALUES(1,'page-0',1,'original',?,1)`).run(t);
    settle(a.sync, b.sync);
    a.store.db.query("UPDATE sdk_sessions SET project='renamed'").run();
    round(a.sync, b.sync);
    b.store.db.query("UPDATE user_prompts SET prompt_text='genuine local edit'").run();
    settle(a.sync, b.sync);
    for (const d of [a, b]) {
      const conflict = (d.sync.status().conflicts as Array<{ entity: string }>)[0];
      expect(conflict).toBeDefined();
      expect(d.sync.inspect(conflict.entity).map(r => r.payload?.prompt_text).sort()).toEqual(['genuine local edit', 'original']);
    }
  });

  it('does not author content edits from remote session projection across a 24-session page', async () => {
    const forwarded: string[] = [];
    const a = device(), b = device({ chromaSync: {
      syncObservation: async () => { forwarded.push('observation'); },
      syncSummary: async () => { forwarded.push('summary'); },
      syncUserPrompt: async () => { forwarded.push('prompt'); },
    } });
    const t = '2026-10-12T00:00:00.000Z';
    for (let i = 0; i < 24; i++) a.store.db.query(`INSERT INTO sdk_sessions(content_session_id,memory_session_id,project,platform_source,started_at,started_at_epoch,status) VALUES(?,?,'old','claude-code',?,1,'completed')`).run(`page-${i}`, `mem-${i}`, t);
    a.store.db.query(`INSERT INTO user_prompts(session_db_id,content_session_id,prompt_number,prompt_text,created_at,created_at_epoch) VALUES(1,'page-0',1,'original',?,1)`).run(t);
    a.store.db.query(`INSERT INTO observations(memory_session_id,project,type,title,created_at,created_at_epoch) VALUES('mem-0','old','discovery','original',?,1)`).run(t);
    a.store.db.query(`INSERT INTO session_summaries(memory_session_id,project,request,created_at,created_at_epoch) VALUES('mem-0','old','original',?,1)`).run(t);
    settle(a.sync, b.sync);
    await b.sync.flushIndexJobs(); forwarded.length = 0;
    a.store.db.query("UPDATE sdk_sessions SET project='renamed', memory_session_id=memory_session_id || '-new'").run();
    const update = round(a.sync, b.sync);
    expect(update.request.changes).toHaveLength(24);
    expect(update.request.changes.every(c => c.revision.kind === 'session')).toBe(true);
    // The cascades and joined prompt fields are reindexed before the writer's
    // content revisions arrive on the next page, without inventing local edits.
    await b.sync.flushIndexJobs();
    expect(forwarded.sort()).toEqual(['observation', 'prompt', 'summary']);
    settle(a.sync, b.sync);
    for (const d of [a, b]) {
      expect(d.sync.status().conflicts).toEqual([]);
      expect(d.sync.status().projectionErrors).toEqual([]);
      for (const kind of ['observation', 'summary', 'prompt']) {
        const changes = d.store.db.query("SELECT body FROM self_sync_log WHERE json_extract(body,'$.kind')=?").all(kind) as Array<{ body: string }>;
        expect(changes).toHaveLength(2); // original plus the writer's actual derived-field change
        expect(changes.map(r => JSON.parse(r.body).actor)).toEqual([a.sync.status().device, a.sync.status().device]);
      }
      expect(d.store.db.query('SELECT memory_session_id FROM observations').get()).toEqual({ memory_session_id: 'mem-0-new' });
      expect(d.store.db.query('SELECT memory_session_id FROM session_summaries').get()).toEqual({ memory_session_id: 'mem-0-new' });
    }
  });

  it('rolls back session-derived fingerprints and index jobs with an interrupted page', async () => {
    let fail = false;
    const a = device(), b = device({ beforeCheckpoint: () => { if (fail) throw new Error('projection checkpoint crash'); } });
    records(a.store, 'a'); settle(a.sync, b.sync); await b.sync.flushIndexJobs();
    const fingerprints = b.store.db.query('SELECT entity,snapshot FROM self_sync_map ORDER BY entity').all();
    const peers = b.sync.status().peers, head = b.sync.head();
    a.store.db.query("UPDATE sdk_sessions SET project='renamed',memory_session_id='memory-new'").run();
    const request = a.sync.prepare(b.sync.status().device as string);
    fail = true;
    expect(() => b.sync.exchange(request)).toThrow('projection checkpoint crash');
    expect(b.store.db.query('SELECT entity,snapshot FROM self_sync_map ORDER BY entity').all()).toEqual(fingerprints);
    expect(b.store.db.query('SELECT memory_session_id FROM observations').get()).toEqual({ memory_session_id: 'memory-a' });
    expect(b.sync.status().peers).toEqual(peers); expect(b.sync.head()).toBe(head);
    expect(b.sync.status().pendingIndexJobs).toBe(0);
    fail = false;
    a.sync.accept(b.sync.exchange(request), request); settle(a.sync, b.sync);
    expect(b.sync.status().conflicts).toEqual([]);
    expect(b.store.db.query('SELECT memory_session_id FROM observations').get()).toEqual({ memory_session_id: 'memory-new' });
  });

  it('defers native stub adoption until session metadata arrives without authoring other prompt edits', () => {
    const a = device(), b = device(), t = '2026-10-12T00:00:00.000Z';
    a.store.db.query(`INSERT INTO sdk_sessions(content_session_id,project,platform_source,started_at,started_at_epoch,status) VALUES('content-stub','project','claude',?,1,'completed')`).run(t);
    for (let number = 1; number <= 2; number++) a.store.db.query(`INSERT INTO user_prompts(session_db_id,content_session_id,prompt_number,prompt_text,created_at,created_at_epoch) VALUES(1,'content-stub',?,'original',?,1)`).run(number, t);
    settle(a.sync, b.sync);
    expect(b.sync.status().projectionErrors).toEqual([]);
    const stored = (kind: string) => JSON.parse((a.store.db.query("SELECT body FROM self_sync_log WHERE json_extract(body,'$.kind')=? ORDER BY seq LIMIT 1").get(kind) as { body: string }).body);
    const prompt = stored('prompt'), session = stored('session');
    const request = a.sync.prepare(b.sync.status().device as string);
    const registered = revision({ ...prompt, parents: [prompt.id], payload: { ...prompt.payload, memory_session_id: 'registered-memory' } });
    // A content association ahead of its portable session cannot silently invoke
    // native SyncApply stub adoption and rewrite every other joined prompt.
    b.sync.exchange({ ...request, head: request.head + 1, changes: [{ seq: request.head + 1, revision: registered }] });
    expect(b.store.db.query('SELECT memory_session_id FROM sdk_sessions').get()).toEqual({ memory_session_id: null });
    expect(b.sync.status().projectionErrors).toHaveLength(1);
    b.sync.prepare(a.sync.status().device as string);
    const metadata = revision({ ...session, parents: [session.id], payload: { ...session.payload, memory_session_id: 'registered-memory' } });
    b.sync.exchange({ ...request, head: request.head + 2, changes: [{ seq: request.head + 2, revision: metadata }] });
    b.sync.prepare(a.sync.status().device as string);
    expect(b.sync.status().projectionErrors).toEqual([]);
    expect(b.sync.status().conflicts).toEqual([]);
    expect(b.store.db.query('SELECT memory_session_id FROM sdk_sessions').get()).toEqual({ memory_session_id: 'registered-memory' });
    expect(b.store.db.query('SELECT COUNT(*) AS n FROM user_prompts').get()).toEqual({ n: 2 });
    expect(b.store.db.query("SELECT COUNT(*) AS n FROM self_sync_log WHERE json_extract(body,'$.actor')=?").get(b.sync.status().device as string)).toEqual({ n: 0 });
  });

  it('exchanges sessions, observations, summaries, prompts and work in both directions exactly once', () => {
    const a = device(), b = device(); records(a.store, 'a'); records(b.store, 'b');
    a.store.appendWorkStateEntry({ project: 'project', listName: 'release', fields: { task: 'a', status: 'todo' } });
    b.store.appendWorkStateEntry({ project: 'project', listName: 'release', fields: { task: 'b', status: 'doing' } });
    settle(a.sync, b.sync); const heads = [a.sync.head(), b.sync.head()]; settle(a.sync, b.sync);
    expect([a.sync.head(), b.sync.head()]).toEqual(heads);
    for (const d of [a, b]) {
      for (const table of ['sdk_sessions', 'observations', 'session_summaries', 'user_prompts', 'work_state_entries']) expect((d.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(2);
      expect(d.store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(d.store.db.query('SELECT COUNT(*) AS n FROM user_prompts WHERE session_db_id IS NOT NULL').get()).toEqual({ n: 2 });
      expect(d.sync.status().conflicts).toEqual([]);
      expect(d.sync.status().projectionErrors).toEqual([]);
      expect(d.store.db.query("SELECT title FROM observations_fts WHERE observations_fts MATCH 'obs'").all()).toHaveLength(2);
    }
  });
  it('preserves simultaneous edits and resolves by an explicit chosen revision', () => {
    const a = device(), b = device(); const id = records(a.store, 'shared'); settle(a.sync, b.sync);
    a.store.db.query('UPDATE observations SET title=? WHERE id=?').run('edited A', id);
    b.store.db.query("UPDATE observations SET title='edited B'").run();
    settle(a.sync, b.sync);
    const conflict = (a.sync.status().conflicts as Array<{ entity: string }>)[0]; expect(conflict).toBeDefined();
    expect(a.sync.inspect(conflict.entity).map(r => r.payload?.title).sort()).toEqual(['edited A', 'edited B']);
    const chosen = a.sync.inspect(conflict.entity).find(r => r.payload?.title === 'edited B')!;
    a.sync.resolve(conflict.entity, chosen.id); settle(a.sync, b.sync);
    expect(a.sync.status().conflicts).toEqual([]); expect(b.sync.status().conflicts).toEqual([]);
    expect(a.store.db.query('SELECT title FROM observations').get()).toEqual({ title: 'edited B' });
  });
  it('offline writes catch up and tombstones survive delayed replay without resurrection', () => {
    const a = device(), b = device(); const id = records(a.store, 'a'); const initial = round(a.sync, b.sync);
    a.store.db.query('DELETE FROM observations WHERE id=?').run(id);
    b.store.appendWorkStateEntry({ project: 'project', listName: 'offline', fields: { queued: true } });
    settle(a.sync, b.sync);
    b.sync.exchange(initial.request);
    expect(b.store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });
    expect(a.store.getWorkStateEntries(['project'], 'offline')[0].fields).toEqual({ queued: true });
  });
  it('rolls back incoming rows and checkpoints together on interruption and retries', () => {
    const a = device(); let fail = true;
    const b = device({ beforeCheckpoint: () => { if (fail) throw new Error('simulated crash'); } });
    records(a.store, 'a'); const request = a.sync.prepare();
    expect(() => b.sync.exchange(request)).toThrow('simulated crash');
    expect(b.store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });
    expect(b.sync.status().peers).toEqual([]); expect(b.sync.head()).toBe(0);
    fail = false; const response = b.sync.exchange(request); a.sync.accept(response, request); settle(a.sync, b.sync);
    expect(b.store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
  });
  it('causal completion beats delayed todo; concurrent completion/reopen stays explicit across three devices', () => {
    const a = device(), b = device(), c = device();
    a.store.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'ship', status: 'todo', details: 'original' }, createdAtEpoch: 9000 });
    const old = round(a.sync, b.sync).request;
    b.store.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'ship', status: 'done' }, createdAtEpoch: 1000 });
    settle(a.sync, b.sync); settle(b.sync, c.sync);
    b.sync.exchange(old);
    expect(foldWorkStateList(a.store.getWorkStateEntries(['project'], 'tasks')).tasks.get('ship')!.fields.status).toBe('done');
    a.store.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'ship', status: 'todo' } });
    c.store.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'ship', status: 'dropped' } });
    settle(a.sync, b.sync); settle(c.sync, b.sync); settle(a.sync, b.sync);
    for (const d of [a, b, c]) expect(String(foldWorkStateList(d.store.getWorkStateEntries(['project'], 'tasks')).tasks.get('ship')!.fields.status)).toContain('SYNC_CONFLICT');
    b.store.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'ship', status: 'done' } });
    settle(b.sync, a.sync); settle(b.sync, c.sync);
    for (const d of [a, b, c]) expect(foldWorkStateList(d.store.getWorkStateEntries(['project'], 'tasks')).tasks.get('ship')!.fields.status).toBe('done');
  });
  it('shared baseline identities avoid duplicates while preserving VPS-native rows', () => {
    const aStore = new SessionStore(':memory:', { syncOpsEnabled: false }), bStore = new SessionStore(':memory:', { syncOpsEnabled: false }); stores.push(aStore, bStore);
    records(aStore, 'baseline'); records(bStore, 'baseline');
    aStore.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'baseline', status: 'done' }, createdAtEpoch: 1000 });
    bStore.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'baseline', status: 'done' }, createdAtEpoch: 1000 });
    const a = new SelfHostedSync(aStore.db), b = new SelfHostedSync(bStore.db), manifest = a.baseline();
    records(bStore, 'vps-native');
    expect(b.reconcile(manifest)).toMatchObject({ matched: 5, independent: 4, ambiguous: [] });
    a.setup({ baseline: manifest }); b.setup({ baseline: manifest }); settle(a, b);
    for (const sync of [a, b]) { expect(sync.status().conflicts).toEqual([]); expect(sync.status().projectionErrors).toEqual([]); }
    expect(aStore.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 2 });
    expect(bStore.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 1 });
    const bad = structuredClone(manifest); bad.rows[0].hash = sha256Base64Url('different');
    expect(() => b.reconcile(bad)).not.toThrow(); expect(b.reconcile(bad).ambiguous).toHaveLength(1);
  });
  it('fails closed on schema, protocol, hash, extra SQL fields, missing causes and identity mismatch', () => {
    const a = device(), b = device(); records(a.store, 'a'); const p = a.sync.prepare();
    expect(() => b.sync.exchange({ ...p, schema: p.schema + 1 })).toThrow('schema mismatch');
    expect(() => b.sync.exchange({ ...p, protocol: 99 })).toThrow();
    expect(() => parsePacket({ ...p, arbitrary_sql: 'DROP TABLE observations' })).toThrow();
    const forged = structuredClone(p); forged.changes[0].revision.payload!.worker_port = 7;
    expect(() => b.sync.exchange(forged)).toThrow();
    const missing = structuredClone(p); const op = missing.changes[0].revision;
    missing.changes[0].revision = revision({ ...op, parents: [sha256Base64Url('missing') ] });
    expect(() => b.sync.exchange(missing)).toThrow('missing or foreign');
    expect(() => b.sync.exchange({ ...p, receiver: p.sender })).toThrow('wrong receiver');
    expect(b.sync.head()).toBe(0);
  });
  it('runs cache hooks after commit and retains failed index jobs for retry, including deletions', async () => {
    let forwards = 0, deletions = 0, fail = true, invalidations = 0;
    const chroma = { syncObservation: async () => { forwards++; if (fail) throw new Error('offline index'); }, syncSummary: async () => {}, syncUserPrompt: async () => {}, removeSyncedContent: async () => { deletions++; } };
    const a = device(), b = device({ chromaSync: chroma }); const id = records(a.store, 'a');
    const unsubscribe = onContextInvalidation(() => { invalidations++; });
    settle(a.sync, b.sync); await b.sync.flushIndexJobs();
    expect(Number(b.sync.status().pendingIndexJobs)).toBeGreaterThan(0); expect(invalidations).toBeGreaterThan(0);
    fail = false; await b.sync.flushIndexJobs(); expect(b.sync.status().pendingIndexJobs).toBe(0); expect(forwards).toBeGreaterThan(1);
    a.store.db.query('DELETE FROM observations WHERE id=?').run(id); settle(a.sync, b.sync); await b.sync.flushIndexJobs(); expect(deletions).toBe(1);
    unsubscribe();
  });
});

describe('private lane edge regressions', () => {
  it('pages an offline backlog without skipping events and rejects changed replay sequences', () => {
    const a = device(), b = device();
    for (let i = 0; i < 70; i++) a.store.appendWorkStateEntry({ project: 'project', listName: 'queue', fields: { task: `task-${i}`, status: 'todo' } });
    const first = round(a.sync, b.sync); settle(a.sync, b.sync);
    expect(b.store.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 70 });
    const swapped = structuredClone(first.request); [swapped.changes[0].revision, swapped.changes[1].revision] = [swapped.changes[1].revision, swapped.changes[0].revision];
    expect(() => b.sync.exchange(swapped)).toThrow('replay differs');
    expect(b.sync.status().workConflicts).toEqual([]);
  });
  it('preserves literal prototype-named work fields through canonical JSON and projection', () => {
    const a = device(), b = device();
    const fields = JSON.parse('{"__proto__":"literal","constructor":3,"prototype":false}');
    a.store.appendWorkStateEntry({ project: 'project', listName: 'literal', fields }); settle(a.sync, b.sync);
    for (const d of [a, b]) expect(d.store.getWorkStateEntries(['project'], 'literal')[0].fields).toEqual(fields);
    expect(canonicalJson(fields)).toBe('{"__proto__":"literal","constructor":3,"prototype":false}');
  });
  it('recovers an interrupted client accept without advancing its incoming checkpoint', () => {
    let fail = true;
    const a = device({ beforeCheckpoint: () => { if (fail) throw new Error('accept crash'); } }), b = device();
    records(b.store, 'b'); const request = a.sync.prepare(), response = b.sync.exchange(request);
    expect(() => a.sync.accept(response, request)).toThrow('accept crash');
    expect(a.sync.status().peers).toEqual([]); expect(a.sync.head()).toBe(0);
    fail = false; a.sync.accept(response, request); settle(a.sync, b.sync);
    expect(a.store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
  });
});

describe('portable session tombstones', () => {
  it('deletes history after its content tombstones and preserves independently added rows as an explicit conflict', () => {
    const a = device(), b = device(); records(a.store, 'a'); settle(a.sync, b.sync);
    a.store.db.query('DELETE FROM observations').run(); a.store.db.query('DELETE FROM session_summaries').run(); a.store.db.query('DELETE FROM user_prompts').run(); a.store.db.query('DELETE FROM sdk_sessions').run();
    settle(a.sync, b.sync);
    expect(b.store.db.query('SELECT COUNT(*) AS n FROM sdk_sessions').get()).toEqual({ n: 0 });
    expect(b.sync.status().projectionErrors).toEqual([]);
    const c = device(), d = device(); records(c.store, 'c'); settle(c.sync, d.sync);
    const t = '2026-10-12T00:00:00.000Z';
    d.store.db.query("INSERT INTO observations(memory_session_id,project,type,title,created_at,created_at_epoch) VALUES('memory-c','project','discovery','offline independent',?,?)").run(t, Date.parse(t));
    c.store.db.query('DELETE FROM observations').run(); c.store.db.query('DELETE FROM session_summaries').run(); c.store.db.query('DELETE FROM user_prompts').run(); c.store.db.query('DELETE FROM sdk_sessions').run();
    settle(c.sync, d.sync);
    expect(d.store.db.query('SELECT title FROM observations').get()).toEqual({ title: 'offline independent' });
    expect((d.sync.status().projectionErrors as unknown[]).length).toBeGreaterThan(0);
    expect(c.store.db.query('SELECT COUNT(*) AS n FROM sdk_sessions').get()).toEqual({ n: 0 });
    expect((c.sync.status().projectionErrors as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('upstream work task identity', () => {
  it('normalizes primitive task names exactly as the renderer and keeps empty task keys as list state', () => {
    const a = device(), b = device();
    a.store.appendWorkStateEntry({ project: 'project', listName: 'identity', fields: { task: 1, status: 'todo' } }); settle(a.sync, b.sync);
    b.store.appendWorkStateEntry({ project: 'project', listName: 'identity', fields: { task: '1', status: 'done' } });
    b.store.appendWorkStateEntry({ project: 'project', listName: 'identity', fields: { task: '', state: 'list metadata' } }); settle(a.sync, b.sync);
    for (const d of [a, b]) {
      const folded = foldWorkStateList(d.store.getWorkStateEntries(['project'], 'identity'));
      expect(folded.tasks.size).toBe(1); expect(folded.tasks.get('1')!.fields.status).toBe('done'); expect(folded.state.state).toBe('list metadata');
    }
  });
});
