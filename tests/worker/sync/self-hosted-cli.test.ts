import { describe, it, expect, afterEach } from 'bun:test';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Server } from 'node:http';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SelfHostedSync } from '../../../src/services/sync/self-hosted/SelfHostedSync.js';
import { SelfHostedSyncRoutes } from '../../../src/services/worker/http/routes/SelfHostedSyncRoutes.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { sshRequest, loopbackWorker } from '../../../src/services/sync/self-hosted/transport.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
async function worker(directory: string, label: string, host = '127.0.0.1') {
  const store = new SessionStore(join(directory, `${label}.db`), { syncOpsEnabled: false }); new SessionSearch(store.db); cleanup.push(() => store.close());
  const sync = new SelfHostedSync(store.db);
  const manager = { getSelfHostedSync: () => sync, getCloudSync: () => null } as unknown as DatabaseManager;
  const app = express(); app.use(express.json({ limit: '16mb' }));
  new SelfHostedSyncRoutes(manager, { allowSetup: true, host: () => host }).setupRoutes(app);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: error.name }));
  const server = await new Promise<Server>(resolveServer => { const server = app.listen(0, '127.0.0.1', () => resolveServer(server)); }); cleanup.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  return { store, sync, url: `http://127.0.0.1:${port}`, port };
}
async function cli(directory: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, resolve('scripts/self-hosted/cli.ts'), ...args], { cwd: process.cwd(), env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

describe('self-hosted worker routes and manual CLI', () => {
  it('runs two disposable workers through the real CLI and SSH-command path, retries offline, and remains a no-op on replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-private-sync-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    // Simulate SSH's remote exec only: execute the fixed remote curl command.
    // This exercises actual HTTP and CLI without connecting to a user's VPS.
    writeFileSync(join(dir, 'ssh'), '#!/bin/sh\nfor arg do command="$arg"; done\nexec /bin/sh -c "$command"\n', { mode: 0o700 });
    const a = await worker(dir, 'a'), b = await worker(dir, 'b');
    a.store.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'mac', status: 'doing' } });
    b.store.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'vps', status: 'done' } });
    const ac = join(dir, 'a.json'), bc = join(dir, 'b.json');
    expect((await cli(dir, 'setup', '--worker', a.url, '--config', ac, '--independent')).code).toBe(0);
    expect((await cli(dir, 'setup', '--worker', b.url, '--config', bc, '--independent')).code).toBe(0);
    expect((await cli(dir, 'attach', '--config', ac, '--ssh', 'fixture@localhost', '--port', String(b.port), '--remote-token-file', bc)).code).toBe(0);
    const synced = await cli(dir, 'sync', '--config', ac); expect(synced.stderr).toBe(''); expect(synced.code).toBe(0);
    expect(a.store.getWorkStateEntries(['project'], 'tasks')).toHaveLength(2); expect(b.store.getWorkStateEntries(['project'], 'tasks')).toHaveLength(2);
    const heads = [a.sync.head(), b.sync.head()]; expect((await cli(dir, 'sync', '--config', ac)).code).toBe(0); expect([a.sync.head(), b.sync.head()]).toEqual(heads);
    writeFileSync(join(dir, 'ssh'), '#!/bin/sh\nexit 255\n', { mode: 0o700 });
    a.store.appendWorkStateEntry({ project: 'project', listName: 'tasks', fields: { task: 'mac', status: 'done' } });
    const offline = await cli(dir, 'sync', '--config', ac); expect(offline.code).toBe(1); expect(offline.stderr).toContain('retry sync later');
    expect(a.store.getWorkStateEntries(['project'], 'tasks').some(e => e.fields.task === 'mac' && e.fields.status === 'done')).toBe(true);
    writeFileSync(join(dir, 'ssh'), '#!/bin/sh\nfor arg do command="$arg"; done\nexec /bin/sh -c "$command"\n', { mode: 0o700 });
    expect((await cli(dir, 'sync', '--config', ac)).code).toBe(0);
    expect(b.store.getWorkStateEntries(['project'], 'tasks').find(e => e.fields.task === 'mac')!.fields.status).toBe('done');
    expect((await cli(dir, 'disable', '--config', ac)).code).toBe(0); expect((await cli(dir, 'sync', '--config', ac)).code).toBe(1); expect((await cli(dir, 'enable', '--config', ac)).code).toBe(0);
    const secret = JSON.parse(readFileSync(ac, 'utf8')).token; expect(synced.stdout).not.toContain(secret);
    const recovered = await cli(dir, 'recover-config', '--database', join(dir, 'a.db'), '--worker', a.url, '--config', join(dir, 'recovered.json'));
    expect(recovered.code).toBe(0); expect(recovered.stdout).not.toContain(secret);
    expect(JSON.parse(readFileSync(join(dir, 'recovered.json'), 'utf8')).token).toBe(secret);
    chmodSync(ac, 0o644); expect((await cli(dir, 'status', '--config', ac)).stderr).toContain('private');
  });
  it('rejects browser origins, bad/missing bearer tokens and non-loopback binds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-sync-auth-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const a = await worker(dir, 'a');
    const origin = await fetch(`${a.url}/api/self-hosted-sync/setup`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"independent":true}' }); expect(origin.status).toBe(403);
    expect((await fetch(`${a.url}/api/self-hosted-sync/status`)).status).toBe(401);
    const setup = await fetch(`${a.url}/api/self-hosted-sync/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"independent":true}' }); expect(setup.status).toBe(200);
    expect((await fetch(`${a.url}/api/self-hosted-sync/status`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const publicBind = await worker(dir, 'public', '0.0.0.0'); expect((await fetch(`${publicBind.url}/api/self-hosted-sync/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"independent":true}' })).status).toBe(403);
  });
  it('rejects unsafe SSH/worker targets before launching a process', () => {
    expect(() => loopbackWorker('https://public.example')).toThrow(); expect(() => loopbackWorker('http://localhost:37777/path')).toThrow();
    expect(() => sshRequest({ target: 'host; touch /tmp/unsafe', port: 37778, token: 'x'.repeat(43) }, 'status')).toThrow('unsafe SSH');
    expect(() => sshRequest({ target: '-oProxyCommand=evil', port: 37778, token: 'x'.repeat(43) }, 'status')).toThrow();
  });
  it('baseline and reconcile CLI read explicit disposable stores without enabling or migrating them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-baseline-cli-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const a = await worker(dir, 'a');
    a.store.appendWorkStateEntry({ project: 'project', listName: 'history', fields: { task: 'shared', status: 'done' }, createdAtEpoch: 1000 });
    const before = a.store.db.query('SELECT version FROM schema_versions ORDER BY version').all();
    const manifest = join(dir, 'baseline.json');
    expect((await cli(dir, 'baseline', '--database', join(dir, 'a.db'), '--output', manifest)).code).toBe(0);
    const dryRun = await cli(dir, 'reconcile', '--database', join(dir, 'a.db'), '--manifest', manifest);
    expect(dryRun.code).toBe(0); expect(JSON.parse(dryRun.stdout)).toEqual({ matched: 1, independent: 0, ambiguous: [] });
    expect(a.store.db.query('SELECT version FROM schema_versions ORDER BY version').all()).toEqual(before);
    expect(a.store.db.query("SELECT name FROM sqlite_master WHERE name='self_sync_config'").get()).toBeNull();
    expect((await cli(dir, 'baseline', '--database', join(dir, 'a.db'), '--output', manifest)).code).toBe(1);
  });
});
