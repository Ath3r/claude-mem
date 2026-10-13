import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Request, Response } from 'express';

// Set this before any project helper is evaluated, including paths/logger.
const dataDir = mkdtempSync(join(tmpdir(), 'cmem-private-delete-'));
const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = dataDir;
const { SessionStore } = await import('../../../../src/services/sqlite/SessionStore.js');
const { SelfHostedSync } = await import('../../../../src/services/sync/self-hosted/SelfHostedSync.js');
const { DataRoutes } = await import('../../../../src/services/worker/http/routes/DataRoutes.js');
const { PROTOCOL } = await import('../../../../src/services/sync/self-hosted/protocol.js');

const stores: InstanceType<typeof SessionStore>[] = [];
function device(configured = true) {
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  stores.push(store);
  const sync = new SelfHostedSync(store.db);
  if (configured) sync.setup({ independent: true });
  return { store, sync };
}
type Device = ReturnType<typeof device>;

function observation({ store }: Device) {
  store.db.query(`INSERT INTO sdk_sessions
    (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES ('content-delete', 'memory-delete', 'project', '2026-10-13T00:00:00.000Z', 1791849600000, 'completed')`).run();
  return String(store.db.query(`INSERT INTO observations
    (memory_session_id, project, type, title, created_at, created_at_epoch)
    VALUES ('memory-delete', 'project', 'discovery', 'delete me', '2026-10-13T00:00:00.000Z', 1791849600000)`)
    .run().lastInsertRowid);
}

function route(d: Device, cloudSync: unknown = null) {
  const broadcasts: unknown[] = [];
  const handlers = new Map<string, (req: Request, res: Response) => void>();
  const routes = new DataRoutes({} as any, {
    getSessionStore: () => d.store, getCloudSync: () => cloudSync, getSelfHostedSync: () => d.sync,
  } as any, {} as any, { broadcast: (event: unknown) => broadcasts.push(event) } as any, {} as any, Date.now());
  routes.setupRoutes({
    get() {}, post() {},
    delete(path: string, handler: (req: Request, res: Response) => void) { handlers.set(path, handler); },
  } as any);
  return {
    broadcasts,
    delete(id: string) {
      let status = 200;
      let body: any;
      const res = {
        status(value: number) { status = value; return this; },
        json(value: unknown) { body = value; return this; },
      } as Response;
      handlers.get('/api/observation/:id')!({ params: { id }, path: `/api/observation/${id}` } as Request, res);
      return { status, body };
    },
  };
}

function round(a: Device, b: Device) {
  const request = a.sync.prepare(b.sync.status().device as string);
  const response = b.sync.exchange(request);
  a.sync.accept(response, request);
  return request;
}

const journal = (d: Device) => d.store.db.query('SELECT seq, id, body FROM self_sync_log ORDER BY seq').all() as Array<{ seq: number; id: string; body: string }>;
const row = (d: Device, id: string) => d.store.db.query('SELECT * FROM observations WHERE id=?').get(id);

afterEach(() => { for (const store of stores.splice(0)) store.close(); });
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('public observation DELETE private-sync ownership', () => {
  for (const configured of [false, true]) {
    it(`deletes an uncaptured local observation (private configured: ${configured})`, () => {
      const d = device(configured), id = observation(d), api = route(d);
      expect(api.delete(id)).toEqual({ status: 200, body: { success: true, id, kind: 'observation', entity_rev: null } });
      expect(row(d, id)).toBeNull();
      expect(api.broadcasts).toEqual([{ type: 'item_deleted', itemType: 'observation', id: Number(id) }]);
      expect(api.delete(id).status).toBe(404);
    });
  }

  it('deletes self-owned captured content, retains history, and replicates a causal tombstone without resurrection', () => {
    const a = device(), b = device(), id = observation(a);
    const staleRequest = round(a, b);
    const before = journal(a);
    const original = before.map(r => JSON.parse(r.body)).find(r => r.kind === 'observation');
    expect(row(a, id)).toMatchObject({ origin_device_id: a.sync.status().device });
    expect(row(b, id)).not.toBeNull();

    const api = route(a);
    expect(api.delete(id).status).toBe(200);
    expect(row(a, id)).toBeNull();
    // The normal exchange capture owns journaling; the route never rewrites history.
    expect(journal(a)).toEqual(before);
    round(a, b);
    const after = journal(a);
    expect(after.slice(0, before.length)).toEqual(before);
    const tombstones = after.map(r => JSON.parse(r.body)).filter(r => r.kind === 'observation' && r.deleted);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ entity: original.entity, owner: original.owner, parents: [original.id], payload: null });
    expect(row(b, id)).toBeNull();
    b.sync.exchange(staleRequest);
    round(b, a);
    round(a, b);
    expect(row(a, id)).toBeNull();
    expect(row(b, id)).toBeNull();
    expect(journal(a)).toEqual(after);
    expect(api.broadcasts).toHaveLength(1);
  });

  it('denies a private peer-owned observation without changing the row or journal', () => {
    const a = device(), b = device(), id = observation(a);
    round(a, b);
    const before = journal(b), original = row(b, id), api = route(b);
    expect(api.delete(id).status).toBe(404);
    expect(row(b, id)).toEqual(original);
    expect(journal(b)).toEqual(before);
    expect(api.broadcasts).toEqual([]);
  });

  it('denies shared-baseline ownership even when the observation already existed locally', () => {
    const d = device(false), id = observation(d);
    d.sync.setup({ baseline: d.sync.baseline() });
    const original = row(d, id), before = journal(d), api = route(d);
    expect(api.delete(id).status).toBe(404);
    expect(row(d, id)).toEqual(original);
    expect(journal(d)).toEqual(before);
    expect(api.broadcasts).toEqual([]);
  });

  for (const configured of [false, true]) {
    it(`denies Pro-imported origins (private configured: ${configured})`, () => {
      const d = device(configured), id = observation(d), api = route(d);
      d.store.db.query("UPDATE observations SET origin_device_id='24dcda89-a89e-487d-b9b9-4d3ae507ba17', origin_local_id='27', synced_at=1 WHERE id=?").run(id);
      // Private capture must not turn another origin into local ownership.
      if (configured) d.sync.capture();
      const original = row(d, id);
      expect(api.delete(id).status).toBe(404);
      expect(row(d, id)).toEqual(original);
      expect(api.broadcasts).toEqual([]);
    });
  }

  for (const damage of ['missing-map', 'wrong-owner', 'wrong-local', 'disabled', 'old-protocol'] as const) {
    it(`refuses self-stamped rows without complete private ownership proof: ${damage}`, () => {
      const d = device(), id = observation(d);
      d.sync.capture();
      if (damage === 'missing-map') d.store.db.query("DELETE FROM self_sync_map WHERE kind='observation'").run();
      if (damage === 'wrong-owner') d.store.db.query("UPDATE self_sync_map SET owner='another-owner' WHERE kind='observation'").run();
      if (damage === 'wrong-local') d.store.db.query("UPDATE observations SET origin_local_id='999' WHERE id=?").run(id);
      if (damage === 'disabled') d.sync.setEnabled(false);
      if (damage === 'old-protocol') d.store.db.query('UPDATE self_sync_config SET protocol=?').run(PROTOCOL - 1);
      const original = row(d, id), before = journal(d), api = route(d);
      expect(api.delete(id).status).toBe(404);
      expect(row(d, id)).toEqual(original);
      expect(journal(d)).toEqual(before);
      expect(api.broadcasts).toEqual([]);
    });
  }

  it('does not send private-owned deletions into the Pro outbox if both lanes appear configured', () => {
    const d = device(), id = observation(d);
    d.sync.capture();
    const queueDelete = mock(() => { throw new Error('wrong sync lane'); });
    const api = route(d, { isConfigured: () => true, queueDelete });
    expect(api.delete(id).status).toBe(404);
    expect(queueDelete).not.toHaveBeenCalled();
    expect(row(d, id)).not.toBeNull();
    expect(api.broadcasts).toEqual([]);
  });
});
