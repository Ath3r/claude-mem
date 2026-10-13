#!/usr/bin/env bun
/** Source checkout CLI: no timers, daemons or live activation by default. */
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { SelfHostedSync, type Baseline } from '../../src/services/sync/self-hosted/SelfHostedSync.js';
import { workerRequest, sshRequest, loopbackWorker, validateToken, type SshConnection } from '../../src/services/sync/self-hosted/transport.js';
import { parsePacket } from '../../src/services/sync/self-hosted/protocol.js';

interface Config { version: 1; worker: string; token: string; ssh?: SshConnection; peer?: string }
const args = process.argv.slice(2), command = args.shift();
function option(name: string): string | undefined { const i = args.indexOf(`--${name}`); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) throw new Error(`--${name} requires a value`); args.splice(i, 2); return v; }
function flag(name: string): boolean { const i = args.indexOf(`--${name}`); if (i < 0) return false; args.splice(i, 1); return true; }
function noExtras() { if (args.length) throw new Error('unknown CLI argument'); }
function safePath(path: string) { const value = resolve(path); if (existsSync(value) && lstatSync(value).isSymbolicLink()) throw new Error('refusing symlink config/output path'); return value; }
function save(path: string, value: unknown) { path = safePath(path); const tmp = `${path}.${process.pid}.tmp`; const fd = openSync(tmp, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); } finally { closeSync(fd); } renameSync(tmp, path); }
function config(path: string): Config { path = safePath(path); if ((lstatSync(path).mode & 0o077) !== 0) throw new Error('sync config must be private (chmod600)'); const c = JSON.parse(readFileSync(path, 'utf8')); if (c.version !== 1) throw new Error('unsupported CLI config version'); loopbackWorker(c.worker); validateToken(c.token); return c; }
function output(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

async function main() {
  if (!command || command === 'help') {
    process.stdout.write(`Self-hosted sync (manual; no schedule enabled)\n\n  baseline --database COPY.db --output baseline.json\n  reconcile --database COPY.db --manifest baseline.json\n  recover-config --database COPY.db --worker http://127.0.0.1:37777 --config recovered.json\n  setup --worker http://127.0.0.1:37777 --config local.json (--manifest baseline.json | --independent) [--work-aliases aliases.json] [--bootstrap-plan reviewed.json]\n  attach --config local.json --ssh user@host --port 37778 --remote-token-file remote.json\n  status --config local.json\n  sync --config local.json [--pages 1000]\n  disable|enable --config local.json\n  inspect --config local.json --entity KIND:HASH\n  resolve --config local.json --entity KIND:HASH --chosen REVISION_HASH\n  inspect-work --config local.json --project NAME --list NAME\n\nSetup requires CLAUDE_MEM_SELF_HOSTED_SYNC_ALLOW_SETUP=1 on the loopback worker.\nFor the receiver run setup locally over SSH; copy its private config using scp.\nBaseline/reconcile open the explicit database READ ONLY and never migrate it.\n`); return;
  }
  if (command === 'recover-config') {
    const database = option('database'), worker = option('worker'), path = option('config'); noExtras();
    if (!database || !worker || !path) throw new Error('explicit database, worker and new config paths required');
    if (existsSync(resolve(path))) throw new Error('config already exists; refusing to overwrite');
    loopbackWorker(worker);
    const db = new Database(safePath(database), { readonly: true });
    try {
      const sync = new SelfHostedSync(db), token = sync.token();
      if (!token) throw new Error('database has no private sync identity');
      save(path, { version: 1, worker, token }); output({ recovered: true });
    } finally { db.close(); }
    return;
  }
  if (command === 'baseline' || command === 'reconcile') {
    const database = option('database'), out = option('output'), manifest = option('manifest'); noExtras();
    if (!database || (command === 'baseline' && !out) || (command === 'reconcile' && !manifest)) throw new Error('database and output/manifest paths are required');
    const db = new Database(safePath(database), { readonly: true });
    try { const sync = new SelfHostedSync(db); if (command === 'baseline') { if (existsSync(resolve(out!))) throw new Error('output already exists'); save(out!, sync.baseline()); output({ written: resolve(out!), schema: sync.schema() }); } else output(sync.reconcile(JSON.parse(readFileSync(safePath(manifest!), 'utf8')) as Baseline)); }
    finally { db.close(); } return;
  }
  const path = option('config'); if (!path) throw new Error('--config is required');
  if (command === 'setup') {
    const worker = option('worker'), manifest = option('manifest'), aliases = option('work-aliases'), bootstrap = option('bootstrap-plan'), independent = flag('independent'); noExtras();
    if (!worker || Boolean(manifest) === independent || (bootstrap && !manifest)) throw new Error('worker and exactly one of manifest/independent are required');
    if (existsSync(resolve(path))) throw new Error('config already exists; preserve its identity');
    const body = { ...(manifest ? { baseline: JSON.parse(readFileSync(safePath(manifest), 'utf8')) } : { independent: true }), ...(bootstrap ? { bootstrapPlan: JSON.parse(readFileSync(safePath(bootstrap), 'utf8')) } : {}), ...(aliases ? { workProjectAliases: JSON.parse(readFileSync(safePath(aliases), 'utf8')) } : {}) };
    const result = await workerRequest({ worker, token: '' }, 'setup', body) as { token: string; device: string; epoch: string };
    save(path, { version: 1, worker: loopbackWorker(worker), token: result.token }); output({ configured: true, device: result.device, epoch: result.epoch }); return;
  }
  const c = config(path);
  if (command === 'attach') {
    const target = option('ssh'), port = Number(option('port')), remoteFile = option('remote-token-file'); noExtras();
    if (!target || !remoteFile) throw new Error('ssh target, port and remote-token-file are required');
    const remote = config(remoteFile); const ssh = { target, port, token: remote.token };
    const status = await sshRequest(ssh, 'status') as { configured: boolean; device: string };
    if (!status.configured) throw new Error('receiver is not configured');
    c.ssh = ssh; c.peer = status.device; save(path, c); output({ attached: true, peer: c.peer }); return;
  }
  if (command === 'status') { noExtras(); output(await workerRequest(c, 'status')); return; }
  if (command === 'disable' || command === 'enable') { noExtras(); output(await workerRequest(c, 'enabled', { enabled: command === 'enable' })); return; }
  if (command === 'inspect') { const entity = option('entity'); noExtras(); if (!entity) throw new Error('entity required'); output(await workerRequest(c, 'inspect', { entity })); return; }
  if (command === 'inspect-work') { const project = option('project'), list = option('list'); noExtras(); if (!project || !list) throw new Error('project and list required'); output(await workerRequest(c, 'inspect-work', { project, list })); return; }
  if (command === 'resolve') { const entity = option('entity'), chosen = option('chosen'); noExtras(); if (!entity || !chosen) throw new Error('entity and chosen head required'); output(await workerRequest(c, 'resolve', { entity, chosen })); return; }
  if (command !== 'sync') throw new Error('unknown command');
  const maxPages = Number(option('pages') ?? '1000'); noExtras();
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100000) throw new Error('invalid pages limit');
  if (!c.ssh) throw new Error('attach an SSH receiver first');
  const lockPath = safePath(`${path}.lock`); let lock: number;
  try { lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid)); }
  catch {
    const pidText = readFileSync(lockPath, 'utf8');
    if (!/^[1-9][0-9]{0,9}$/.test(pidText)) throw new Error('invalid sync lock; refusing to replace it');
    try { process.kill(Number(pidText), 0); throw new Error('another sync is running'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    unlinkSync(lockPath); lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid));
  }
  try {
    for (let page = 0; page < maxPages; page++) {
      const request = parsePacket(await workerRequest(c, 'prepare', c.peer ? { peer: c.peer } : {}));
      const response = parsePacket(await sshRequest(c.ssh, 'exchange', request));
      await workerRequest(c, 'accept', { request, response });
      if (c.peer !== response.sender) { c.peer = response.sender; save(path, c); }
      const pulled = response.changes.at(-1)?.seq ?? request.after;
      if ((request.changes.at(-1)?.seq ?? request.ack) >= request.head && pulled >= response.head) { output({ synced: true, pages: page + 1, status: await workerRequest(c, 'status') }); return; }
    }
    output({ synced: false, reason: 'page limit reached; retry catches up from durable checkpoints', status: await workerRequest(c, 'status') }); process.exitCode = 2;
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
main().catch(error => { process.stderr.write(`self-hosted sync: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
