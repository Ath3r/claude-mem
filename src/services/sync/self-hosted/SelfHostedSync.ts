/** Opt-in private fork lane. Immutable revisions are retained even when projection conflicts.
 * Captures portable rows before every exchange: offline writes need no network or scheduler.
 * Base-table SQL and incoming checkpoints commit together; FTS triggers remain authoritative.
 */
import { validateBootstrapPlan, type BootstrapPlan } from './bootstrap.js';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { randomUUID, randomBytes } from 'crypto';
import { logger } from '../../../utils/logger.js';
import { canonicalJson, sha256Base64Url } from '../CanonicalContent.js';
import { SyncApply, type ChromaSyncLike, type SyncOp } from '../SyncApply.js';
import { emitContextInvalidation } from '../../../shared/context-invalidation.js';
import { TABLES, PAGE_SIZE, MAX_PACKET_BYTES, MAX_BASELINE_BYTES, PROTOCOL, entityId, revision, parsePacket, portablePayload, nativePayload, SESSION_FIELDS, CONTENT_FIELDS, type Kind, type Revision, type Packet } from './protocol.js';

export interface Baseline { protocol: typeof PROTOCOL; namespace: string; schema: number; rows: Array<{ kind: Kind; local: string; hash: string }> }
interface Mapping { entity: string; kind: Kind; owner: string; local: string; row_id: number | null; snapshot: string }
interface Config { device: string; epoch: string; enabled: number; auth_token: string; protocol: number }
interface Peer { device: string; epoch: string; received: number; sent: number }
interface Stored { seq: number; id: string; body: string }
const KINDS = Object.keys(TABLES) as Kind[];
const hash = (value: unknown) => sha256Base64Url(canonicalJson(value));
const projectKey = (value: unknown) => String(value).replace(/[A-Z]/g, character => character.toLowerCase());
const bind = (value: unknown): SQLQueryBindings => value === null || value === undefined ? null : value as SQLQueryBindings;

export class SelfHostedSync {
  private applier: SyncApply | null = null;
  private flushing: Promise<void> | null = null;
  constructor(readonly db: Database, private options: { chromaSync?: ChromaSyncLike | null; beforeCheckpoint?: () => void } = {}) {}

  /** Does not create tables or write anything on unconfigured installations. */
  configured(): boolean {
    if (!this.db.query("SELECT name FROM sqlite_master WHERE name = 'self_sync_config'").get()) return false;
    return this.config()?.enabled === 1;
  }
  private config(): Config | undefined { return this.db.query('SELECT device, epoch, enabled, auth_token, protocol FROM self_sync_config WHERE singleton = 1').get() as Config | undefined; }
  token(): string | null {
    if (!this.db.query("SELECT name FROM sqlite_master WHERE name='self_sync_config'").get()) return null;
    return this.config()?.auth_token ?? null;
  }
  private requireConfig(): Config {
    if (!this.configured()) throw new Error('self-hosted sync is disabled; explicit setup is required');
    const config = this.config()!;
    if (config.protocol !== PROTOCOL) throw new Error('private journal protocol mismatch; explicit migration required');
    return config;
  }
  schema(): number { return (this.db.query('SELECT MAX(version) AS version FROM schema_versions').get() as { version: number }).version; }
  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS self_sync_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1), device TEXT NOT NULL, epoch TEXT NOT NULL, enabled INTEGER NOT NULL, auth_token TEXT NOT NULL, protocol INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS self_sync_map(entity TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL, local TEXT NOT NULL, row_id INTEGER, snapshot TEXT NOT NULL, UNIQUE(kind,row_id));
      CREATE TABLE IF NOT EXISTS self_sync_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS self_sync_log_kind_seq ON self_sync_log(json_extract(body,'$.kind'),seq);
      CREATE TABLE IF NOT EXISTS self_sync_capture(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, captured INTEGER NOT NULL);
      INSERT OR IGNORE INTO self_sync_capture VALUES(1,0,-1);
      CREATE TABLE IF NOT EXISTS self_sync_heads(entity TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(entity,id));
      CREATE TABLE IF NOT EXISTS self_sync_peers(device TEXT PRIMARY KEY, epoch TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS self_sync_received(device TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, PRIMARY KEY(device,seq));
      CREATE TABLE IF NOT EXISTS self_sync_errors(entity TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS self_sync_jobs(id TEXT PRIMARY KEY, seq INTEGER NOT NULL, row_id INTEGER NOT NULL, op TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS self_sync_work_projection(scope TEXT PRIMARY KEY, project TEXT NOT NULL, list_name TEXT NOT NULL, fields TEXT NOT NULL, created_at_epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS self_sync_work_aliases(project TEXT PRIMARY KEY, canonical TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS self_sync_work_conflicts(scope TEXT NOT NULL, field TEXT NOT NULL, revisions TEXT NOT NULL, PRIMARY KEY(scope,field));
    `);
    // SQLite triggers see writes from every connection, including offline writers.
    // Only portable inputs dirty capture; sync/index bookkeeping does not.
    for (const kind of KINDS) {
      const table = TABLES[kind];
      const columns = kind === 'session' ? SESSION_FIELDS : kind === 'work'
        ? ['project', 'list_name', 'fields', 'created_at', 'created_at_epoch']
        : kind === 'prompt' ? ['session_db_id', 'content_session_id', 'prompt_number', 'prompt_text', 'created_at', 'created_at_epoch'] : CONTENT_FIELDS[kind];
      for (const event of ['INSERT', 'DELETE', `UPDATE OF ${columns.join(',')}`]) {
        const name = event.split(' ')[0].toLowerCase();
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS self_sync_dirty_${kind}_${name} AFTER ${event} ON ${table}
          BEGIN UPDATE self_sync_capture SET revision=revision+1 WHERE singleton=1; END;`);
      }
    }
  }
  private captureState(): { revision: number; captured: number } | undefined {
    // Pre-compat journals retain the conservative full scan until explicitly
    // migrated. Never install triggers or mutate an unconfigured store on read.
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE name='self_sync_capture'").get()) return undefined;
    return this.db.query('SELECT revision,captured FROM self_sync_capture WHERE singleton=1').get() as { revision: number; captured: number } | undefined;
  }
  private acknowledgeCapture(): void {
    if (this.captureState()) this.db.query('UPDATE self_sync_capture SET captured=revision WHERE singleton=1').run();
  }
  private rows(kind: Kind): Array<Record<string, unknown> & { id: number }> {
    if (kind === 'prompt') return this.db.query(`SELECT p.*, s.memory_session_id, COALESCE(s.project,'unknown') AS project, COALESCE(s.platform_source,'claude-code') AS platform_source FROM user_prompts p LEFT JOIN sdk_sessions s ON p.session_db_id=s.id ORDER BY p.id`).all() as Array<Record<string, unknown> & { id: number }>;
    return this.db.query(`SELECT * FROM ${TABLES[kind]} ORDER BY id`).all() as Array<Record<string, unknown> & { id: number }>;
  }
  baseline(): Baseline {
    const baseline: Baseline = { protocol: PROTOCOL, namespace: randomUUID(), schema: this.schema(), rows: KINDS.flatMap(kind => this.rows(kind).map(row => ({ kind, local: String(row.id), hash: hash(portablePayload(kind, row)) }))) };
    this.validateBaseline(baseline);
    return baseline;
  }
  reconcile(baseline: Baseline): { matched: number; independent: number; ambiguous: Array<{ kind: Kind; local: string }> } {
    this.validateBaseline(baseline);
    let matched = 0, independent = 0;
    const ambiguous: Array<{ kind: Kind; local: string }> = [];
    for (const kind of KINDS) {
      const known = new Map(baseline.rows.filter(r => r.kind === kind).map(r => [r.local, r.hash]));
      for (const row of this.rows(kind)) {
        const expected = known.get(String(row.id));
        if (!expected) independent++;
        else if (expected === hash(portablePayload(kind, row))) matched++;
        else ambiguous.push({ kind, local: String(row.id) });
      }
    }
    return { matched, independent, ambiguous };
  }
  private validateBaseline(baseline: Baseline): void {
    if (Buffer.byteLength(JSON.stringify(baseline)) > MAX_BASELINE_BYTES) throw new Error('baseline manifest exceeds size limit');
    if (!baseline || baseline.protocol !== PROTOCOL || baseline.schema !== this.schema() || !/^[a-f0-9-]{36}$/.test(baseline.namespace) || !Array.isArray(baseline.rows) || baseline.rows.length > 2_000_000) throw new Error('incompatible baseline manifest');
    const seen = new Set<string>();
    for (const r of baseline.rows) {
      if (!KINDS.includes(r.kind) || !/^[1-9][0-9]{0,15}$/.test(r.local) || !/^[A-Za-z0-9_-]{43}$/.test(r.hash) || seen.has(`${r.kind}:${r.local}`)) throw new Error('invalid baseline manifest row');
      seen.add(`${r.kind}:${r.local}`);
    }
  }
  setup(input: { independent?: boolean; baseline?: Baseline; bootstrapPlan?: BootstrapPlan; workProjectAliases?: string[][] }): { device: string; epoch: string; token: string } {
    if (this.configured()) throw new Error('already configured; identity cannot be replaced');
    if (!input.independent && !input.baseline) throw new Error('choose verified shared baseline or explicitly independent history');
    if (input.bootstrapPlan && !input.baseline) throw new Error('bootstrap plan requires a shared baseline');
    if (input.baseline && input.independent) throw new Error('choose exactly one history mode');
    const result = this.db.transaction(() => {
      const reviewed = input.bootstrapPlan ? validateBootstrapPlan(input.bootstrapPlan, input.baseline!, new Map(this.rows('session').map(row => [String(row.id), row]))) : new Map();
      if (input.baseline) {
        const report = this.reconcile(input.baseline);
        if (report.ambiguous.some(row => row.kind !== 'session' || !reviewed.has(row.local))) throw new Error('baseline has changed/colliding rows; reconcile them on disposable copies before setup');
        const localWork = new Set(this.rows('work').map(row => String(row.id)));
        if (input.baseline.rows.some(row => row.kind === 'work' && !localWork.has(row.local))) throw new Error('partial work baseline cannot establish shared causality; reconcile complete event history first');
      }
      this.createSchema();
      const previous = this.config();
      if (previous) throw new Error('disabled identity exists; use enable, do not replace its identity');
      const device = randomUUID(), epoch = randomUUID();
      const token = randomBytes(32).toString('base64url');
      this.db.query('INSERT INTO self_sync_config VALUES(1,?,?,1,?,?)').run(device, epoch, token, PROTOCOL);
      if (input.baseline) {
        const byKind = new Map(KINDS.map(kind => [kind, new Map(this.rows(kind).map(row => [String(row.id), row]))]));
        for (const r of input.baseline.rows) {
          const row = byKind.get(r.kind)!.get(r.local);
          if (!row) continue;
          const reviewedSession = r.kind === 'session' ? reviewed.get(r.local) : undefined;
          const mapping = this.map(r.kind, row.id, input.baseline.namespace, r.local, reviewedSession ? r.hash : hash(null));
          if (reviewedSession) {
            // Same revision as an unchanged peer, then capture() journals the
            // current completion as its causal child without rewriting the row.
            this.append(revision({ entity: mapping.entity, kind: 'session', owner: mapping.owner, local: mapping.local, actor: mapping.owner, parents: [], causes: [], payload: reviewedSession.baselinePayload, deleted: false }));
          }
        }
      }
      this.configureWorkAliases(input.workProjectAliases ?? []);
      this.assertUnambiguousWorkActivation();
      this.capture();
      return { device, epoch, token };
    }).immediate();
    emitContextInvalidation('all', 'SelfHostedSync.setup', 'removal');
    return result;
  }
  private configureWorkAliases(groups: string[][]): void {
    if (!Array.isArray(groups) || groups.length > 256) throw new Error('invalid work project aliases');
    for (const group of groups) {
      if (!Array.isArray(group) || group.length < 2 || group.length > 256 || group.some(p => typeof p !== 'string' || !p || p.length > 4096)) throw new Error('invalid work project aliases');
      const canonical = projectKey(group.at(-1));
      for (const project of new Set(group.map(projectKey))) {
        const previous = this.db.query('SELECT canonical FROM self_sync_work_aliases WHERE project=?').get(project) as { canonical: string } | undefined;
        if (previous && previous.canonical !== canonical) throw new Error('overlapping work project aliases');
        this.db.query('INSERT OR IGNORE INTO self_sync_work_aliases VALUES(?,?)').run(project, canonical);
      }
    }
  }
  private canonicalWorkProject(project: unknown): string {
    const key = projectKey(project);
    return (this.db.query('SELECT canonical FROM self_sync_work_aliases WHERE project=?').get(key) as { canonical: string } | undefined)?.canonical ?? key;
  }
  /** There is no durable native checkout-alias registry. Never guess a historical
   * ordering when separately scoped histories may later be folded by its reader. */
  private assertUnambiguousWorkActivation(): void {
    const writes = new Map<string, Set<string>>();
    for (const row of this.rows('work')) {
      const p = portablePayload('work', row), fields = p.fields as Record<string, unknown>;
      const task = fields.task == null || fields.task === '' ? null : String(fields.task);
      for (const key of Object.keys(fields).filter(k => k !== 'task')) {
        const target = canonicalJson([p.list_name, task, key]);
        const projects = writes.get(target) ?? new Set<string>();
        projects.add(this.canonicalWorkProject(p.project)); writes.set(target, projects);
        if (projects.size > 1) throw new Error('ambiguous work project aliases; review explicit workProjectAliases on disposable copies before setup');
      }
    }
  }
  setEnabled(enabled: boolean): void {
    if (!this.config()) throw new Error('not configured');
    this.db.query('UPDATE self_sync_config SET enabled=? WHERE singleton=1').run(enabled ? 1 : 0);
    emitContextInvalidation('all', 'SelfHostedSync.setEnabled', 'removal');
  }
  private map(kind: Kind, rowId: number | null, owner: string, local: string, snapshot: string): Mapping {
    const entity = entityId(kind, owner, local);
    this.db.query('INSERT INTO self_sync_map(entity,kind,owner,local,row_id,snapshot) VALUES(?,?,?,?,?,?)').run(entity, kind, owner, local, rowId, snapshot);
    if (rowId !== null && kind !== 'session' && kind !== 'work') this.db.query(`UPDATE ${TABLES[kind]} SET origin_device_id=?,origin_local_id=? WHERE id=?`).run(owner, local, rowId);
    return { entity, kind, owner, local, row_id: rowId, snapshot };
  }
  private heads(entity: string): string[] { return (this.db.query('SELECT id FROM self_sync_heads WHERE entity=? ORDER BY id').all(entity) as Array<{ id: string }>).map(r => r.id); }
  private getRevision(id: string): Revision | undefined {
    const row = this.db.query('SELECT body FROM self_sync_log WHERE id=?').get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  private workScope(r: Revision): string { const p = r.payload!; return canonicalJson([p.scope_project, p.list_name]); }
  private workFrontier(scope: string): string[] {
    const events = this.workEvents().filter(r => this.workScope(r) === scope);
    const causes = new Set(events.flatMap(r => r.causes));
    return events.filter(r => !causes.has(r.id)).map(r => r.id).sort();
  }
  /** Scan inside the worker's SQLite transaction, before observing any remote data. */
  capture(): void {
    const { device } = this.requireConfig();
    this.db.transaction(() => {
      const state = this.captureState();
      if (state && state.revision === state.captured) return;
      this.assertUnambiguousWorkActivation();
      for (const kind of KINDS) {
        const existing = this.db.query('SELECT * FROM self_sync_map WHERE kind=?').all(kind) as Mapping[];
        const byRow = new Map(existing.filter(r => r.row_id !== null).map(r => [r.row_id!, r]));
        const present = new Set<number>();
        const rows = this.rows(kind);
        if (kind === 'work') rows.sort((a, b) => {
          const priority = (id: number) => { const m = byRow.get(id); return m?.snapshot === hash(null) && m.owner !== device ? 0 : 1; };
          return priority(a.id) - priority(b.id) || a.id - b.id;
        });
        for (const row of rows) {
          present.add(row.id);
          let m = byRow.get(row.id);
          if (!m) {
            const owner = typeof row.origin_device_id === 'string' ? row.origin_device_id : device;
            const local = typeof row.origin_local_id === 'string' ? row.origin_local_id : String(row.id);
            m = this.map(kind, row.id, owner, local, hash(null));
          }
          const payload = portablePayload(kind, row);
          if (kind === 'work') payload.scope_project = this.canonicalWorkProject(payload.project);
          const snapshot = hash(payload);
          if (snapshot === m.snapshot) continue;
          if (kind === 'work' && m.snapshot !== hash(null)) throw new Error('append-only work event was modified; repair on a disposable copy');
          const causes = kind === 'work' ? this.workFrontier(canonicalJson([payload.scope_project, payload.list_name])) : [];
          const parents = kind === 'work' ? [] : this.heads(m.entity);
          const op = revision({ entity: m.entity, kind, owner: m.owner, local: m.local, actor: m.snapshot === hash(null) && !parents.length ? m.owner : device, parents, causes, payload, deleted: false });
          this.append(op);
          if (kind !== 'session' && kind !== 'work') this.queueIndex(op, row.id);
          this.db.query('UPDATE self_sync_map SET snapshot=? WHERE entity=?').run(snapshot, m.entity);
        }
        for (const m of existing) {
          if (m.row_id === null || present.has(m.row_id) || m.snapshot === hash(null)) continue;
          if (kind === 'work') throw new Error('work events are append-only; close with status done/dropped instead of deleting events');
          const tombstone = revision({ entity: m.entity, kind, owner: m.owner, local: m.local, actor: device, parents: this.heads(m.entity), causes: [], payload: null, deleted: true });
          this.append(tombstone);
          if (kind !== 'session') this.queueIndex(tombstone, m.row_id);
          this.db.query('UPDATE self_sync_map SET snapshot=?,row_id=NULL WHERE entity=?').run(hash(null), m.entity);
        }
      }
      this.rebuildWorkProjection();
      this.acknowledgeCapture();
    })();
  }
  private append(op: Revision): boolean {
    if (this.getRevision(op.id)) return false;
    if (op.kind === 'work' && op.payload!.scope_project !== this.canonicalWorkProject(op.payload!.project)) throw new Error('work project alias plan mismatch; review matching plans on both devices');
    for (const id of op.parents) {
      const parent = this.getRevision(id);
      if (!parent || parent.entity !== op.entity) throw new Error('missing or foreign entity predecessor');
    }
    for (const id of op.causes) {
      const cause = this.getRevision(id);
      if (!cause || cause.kind !== 'work' || this.workScope(cause) !== this.workScope(op)) throw new Error('missing or foreign work predecessor');
    }
    this.db.query('INSERT INTO self_sync_log(id,body) VALUES(?,?)').run(op.id, canonicalJson(op));
    for (const id of op.parents) this.db.query('DELETE FROM self_sync_heads WHERE entity=? AND id=?').run(op.entity, id);
    this.db.query('INSERT INTO self_sync_heads(entity,id) VALUES(?,?)').run(op.entity, op.id);
    return true;
  }
  private peer(device: string): Peer | undefined { return this.db.query('SELECT * FROM self_sync_peers WHERE device=?').get(device) as Peer | undefined; }
  head(): number { return (this.db.query('SELECT COALESCE(MAX(seq),0) AS head FROM self_sync_log').get() as { head: number }).head; }
  private page(after: number): Array<{ seq: number; revision: Revision }> {
    const changes: Packet['changes'] = [];
    // Reserve envelope space and stop before exceeding the wire byte bound.
    let bytes = 1024;
    for (const row of this.db.query('SELECT seq,id,body FROM self_sync_log WHERE seq>? ORDER BY seq LIMIT ?').all(after, PAGE_SIZE) as Stored[]) {
      const change = { seq: row.seq, revision: JSON.parse(row.body) };
      const size = Buffer.byteLength(JSON.stringify(change)) + 1;
      if (bytes + size > MAX_PACKET_BYTES) break;
      changes.push(change); bytes += size;
    }
    return changes;
  }
  prepare(peerDevice?: string): Packet {
    this.requireConfig();
    return this.db.transaction((): Packet => {
      this.capture();
      const c = this.config()!, p = peerDevice ? this.peer(peerDevice) : undefined;
      if (!peerDevice && (this.db.query('SELECT COUNT(*) AS n FROM self_sync_peers').get() as { n: number }).n > 0) throw new Error('peer identity required after first exchange');
      return { protocol: PROTOCOL, schema: this.schema(), sender: c.device, epoch: c.epoch, receiver: p?.device ?? peerDevice ?? null, receiverEpoch: p?.epoch ?? null, after: p?.received ?? 0, ack: p?.sent ?? 0, changes: this.page(p?.sent ?? 0), head: this.head() };
    }).immediate();
  }
  /** Receiver applies push and returns its pull page. Never network I/O inside SQLite. */
  exchange(input: unknown): Packet {
    const packet = parsePacket(input), c = this.requireConfig();
    let changed = false;
    const response = this.db.transaction((): Packet => {
      this.checkPeer(packet);
      this.capture();
      changed = this.ingest(packet);
      const p = this.peer(packet.sender)!;
      if (packet.after > this.head()) throw new Error('pull cursor exceeds retained journal');
      return { protocol: PROTOCOL, schema: this.schema(), sender: c.device, epoch: c.epoch, receiver: packet.sender, receiverEpoch: packet.epoch, after: p.received, ack: packet.after, changes: this.page(packet.after), head: this.head() };
    }).immediate();
    if (changed) emitContextInvalidation('all', 'SelfHostedSync.exchange', 'removal');
    return response;
  }
  accept(input: unknown, request: Packet): void {
    const response = parsePacket(input);
    request = parsePacket(request);
    if (request.sender !== this.requireConfig().device || request.epoch !== this.requireConfig().epoch) throw new Error('request does not belong to this device');
    if (request.receiver && response.sender !== request.receiver) throw new Error('response from unexpected peer');
    this.db.transaction(() => {
      this.checkPeer(response);
      const expectedAck = request.changes.at(-1)?.seq ?? request.ack;
      if (expectedAck > this.head() || request.changes.some(change => !this.getRevision(change.revision.id))) throw new Error('request does not match retained journal');
      if (response.after !== expectedAck || response.ack !== request.after) throw new Error('peer acknowledgement does not match request');
      this.capture();
      this.ingest({ ...response, ack: request.after });
      this.db.query('UPDATE self_sync_peers SET sent=? WHERE device=?').run(expectedAck, response.sender);
      this.options.beforeCheckpoint?.();
    }).immediate();
    emitContextInvalidation('all', 'SelfHostedSync.accept', 'removal');
  }
  private checkPeer(packet: Packet): void {
    const c = this.requireConfig();
    if (packet.schema !== this.schema()) throw new Error('schema mismatch; upgrade both workers before syncing');
    if (packet.sender === c.device || (packet.receiver !== null && packet.receiver !== c.device) || (packet.receiverEpoch !== null && packet.receiverEpoch !== c.epoch)) throw new Error('cloned identity or wrong receiver/epoch');
    const existing = this.peer(packet.sender);
    if (existing && existing.epoch !== packet.epoch) throw new Error('peer journal was replaced; explicit recovery required');
    if (!existing) this.db.query('INSERT INTO self_sync_peers(device,epoch) VALUES(?,?)').run(packet.sender, packet.epoch);
  }
  private ingest(packet: Packet): boolean {
    const p = this.peer(packet.sender)!;
    let last = p.received, changed = false, workChanged = false;
    if (packet.ack > this.head()) throw new Error('ack exceeds journal');
    for (const { seq, revision: op } of packet.changes) {
      if (seq <= p.received) {
        const seen = this.db.query('SELECT id FROM self_sync_received WHERE device=? AND seq=?').get(packet.sender, seq) as { id: string } | undefined;
        if (seen?.id !== op.id) throw new Error('replay differs from committed journal');
        continue;
      }
      if (seq !== last + 1 || seq > packet.head) throw new Error('noncontiguous page');
      last = seq;
      this.db.query('INSERT INTO self_sync_received(device,seq,id) VALUES(?,?,?)').run(packet.sender, seq, op.id);
      if (this.append(op)) {
        changed = true;
        workChanged ||= op.kind === 'work';
        this.project(op);
      }
    }
    // capture already refreshed local work. Duplicate pages and content-only
    // pages cannot change its projection; avoid replaying every work event.
    if (workChanged) {
      this.assertUnambiguousWorkActivation();
      this.rebuildWorkProjection();
    }
    // Session tombstones may precede their content tombstones in the page.
    // A constraint conflict is retained, then retried once dependencies clear.
    for (const row of this.db.query('SELECT entity FROM self_sync_errors').all() as Array<{ entity: string }>) {
      const heads = this.heads(row.entity);
      if (heads.length === 1) this.project(this.getRevision(heads[0])!);
    }
    // capture ran before ingest in this same transaction. All subsequent base
    // writes were verified projections, so they must not become local edits.
    this.acknowledgeCapture();
    this.options.beforeCheckpoint?.();
    this.db.query('UPDATE self_sync_peers SET received=?,sent=MAX(sent,?) WHERE device=?').run(last, packet.ack, packet.sender);
    return changed;
  }
  private op(r: Revision): SyncOp {
    if (r.kind === 'session' || r.kind === 'work') throw new Error('not native content');
    return { seq: '1', kind: r.kind, origin_device: r.owner, origin_id: r.local, rev: '1', body: canonicalJson(r.payload ? nativePayload(r.payload) : {}), server_ts: 0, deleted: r.deleted };
  }
  private nativeApplier(): SyncApply { return this.applier ??= new SyncApply(this.db, { deviceId: this.requireConfig().device, chromaSync: this.options.chromaSync }); }
  private queueIndex(r: Revision, id: number): void {
    const seq = (this.db.query('SELECT seq FROM self_sync_log WHERE id=?').get(r.id) as { seq: number }).seq;
    this.db.query('INSERT OR IGNORE INTO self_sync_jobs(id,seq,row_id,op) VALUES(?,?,?,?)').run(r.id, seq, id, canonicalJson(this.op(r)));
  }
  private sessionDependents(id: number): Array<{ mapping: Mapping; snapshot: string }> {
    const rows = this.db.query(`SELECT m.* FROM self_sync_map m WHERE
      (m.kind='prompt' AND m.row_id IN (SELECT id FROM user_prompts WHERE session_db_id=?))
      OR (m.kind='observation' AND m.row_id IN (SELECT o.id FROM observations o JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id WHERE s.id=?))
      OR (m.kind='summary' AND m.row_id IN (SELECT o.id FROM session_summaries o JOIN sdk_sessions s ON s.memory_session_id=o.memory_session_id WHERE s.id=?))`).all(id, id, id) as Mapping[];
    return rows.map(mapping => ({ mapping, snapshot: hash(this.rowPayload(mapping)) }));
  }
  private rowPayload(m: Mapping): Record<string, unknown> {
    const row = m.kind === 'prompt'
      ? this.db.query(`SELECT p.*, s.memory_session_id, COALESCE(s.project,'unknown') AS project, COALESCE(s.platform_source,'claude-code') AS platform_source FROM user_prompts p LEFT JOIN sdk_sessions s ON p.session_db_id=s.id WHERE p.id=?`).get(m.row_id!)
      : this.db.query(`SELECT * FROM ${TABLES[m.kind]} WHERE id=?`).get(m.row_id!);
    if (!row) throw new Error('projection dependent disappeared');
    return portablePayload(m.kind, row as Record<string, unknown>);
  }
  private recordProjectionEffects(source: Revision, dependents: Array<{ mapping: Mapping; snapshot: string }>): void {
    for (const { mapping: m, snapshot: before } of dependents) {
      const payload = this.rowPayload(m), snapshot = hash(payload);
      if (snapshot === before) continue;
      // capture() has already journaled genuine local edits under the same
      // immediate transaction. Only changes caused by this SQL projection are
      // acknowledged here; no content revision is invented on the receiver.
      this.db.query('UPDATE self_sync_map SET snapshot=? WHERE entity=?').run(snapshot, m.entity);
      const op: SyncOp = { seq: '1', kind: m.kind as SyncOp['kind'], origin_device: m.owner, origin_id: m.local, rev: '1', body: canonicalJson(nativePayload(payload)), server_ts: 0, deleted: false };
      const seq = (this.db.query('SELECT seq FROM self_sync_log WHERE id=?').get(source.id) as { seq: number }).seq;
      this.db.query('INSERT OR IGNORE INTO self_sync_jobs(id,seq,row_id,op) VALUES(?,?,?,?)').run(hash([source.id, m.entity]), seq, m.row_id, canonicalJson(op));
    }
  }
  private contentSessionSnapshot(r: Revision): string {
    const p = r.payload!;
    // Native content apply can create/adopt/merge stubs. In this lane portable
    // session revisions carry that authority; content must not mutate sessions
    // or silently fold their independent identities. Include both lookup keys.
    const sessions = this.db.query('SELECT * FROM sdk_sessions WHERE memory_session_id=? OR content_session_id=? ORDER BY id')
      .all(bind(p.memory_session_id), bind(p.content_session_id)) as Array<Record<string, unknown>>;
    return hash(sessions.map(row => [row.id, portablePayload('session', row)]));
  }
  private project(r: Revision): void {
    let m = this.db.query('SELECT * FROM self_sync_map WHERE entity=?').get(r.entity) as Mapping | undefined;
    if (!m) m = this.map(r.kind, null, r.owner, r.local, hash(null));
    if (this.heads(r.entity).length !== 1) return;
    this.db.exec('SAVEPOINT self_sync_project');
    try {
      let id: number | null = m.row_id;
      if (r.kind === 'session') {
        const p = r.payload!;
        if (r.deleted) {
          if (id !== null) {
            const local = this.db.query('SELECT status FROM sdk_sessions WHERE id=?').get(id) as { status: string };
            if (local.status === 'active') throw new Error('active session identity collision; retain local processing state');
            const refs = this.db.query(`SELECT 1 FROM sdk_sessions s WHERE s.id=? AND (
              EXISTS(SELECT 1 FROM observations WHERE memory_session_id=s.memory_session_id)
              OR EXISTS(SELECT 1 FROM session_summaries WHERE memory_session_id=s.memory_session_id)
              OR EXISTS(SELECT 1 FROM user_prompts WHERE session_db_id=s.id)
              OR EXISTS(SELECT 1 FROM pending_messages WHERE session_db_id=s.id)
              OR EXISTS(SELECT 1 FROM tool_uses WHERE session_db_id=s.id))`).get(id);
            if (refs) throw new Error('session dependency identity collision; preserve independently created local records');
            this.db.query('DELETE FROM sdk_sessions WHERE id=?').run(id);
          }
          id = null;
        } else if (id === null) {
          const collision = this.db.query('SELECT id FROM sdk_sessions WHERE (platform_source=? AND content_session_id=?) OR memory_session_id=?').get(bind(p.platform_source), bind(p.content_session_id), bind(p.memory_session_id));
          if (collision) throw new Error('session identity collision; verify shared baseline');
          const columns = [...SESSION_FIELDS, 'status'];
          id = Number(this.db.query(`INSERT INTO sdk_sessions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...SESSION_FIELDS.map(k => bind(p[k])), 'completed').lastInsertRowid);
        } else {
          const dependents = this.sessionDependents(id);
          this.db.query(`UPDATE sdk_sessions SET ${SESSION_FIELDS.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...SESSION_FIELDS.map(k => bind(p[k])), id);
          this.recordProjectionEffects(r, dependents);
        }
      } else if (r.kind === 'work') {
        const p = nativePayload(r.payload!);
        id = Number(this.db.query('INSERT INTO work_state_entries(project,list_name,fields,created_at,created_at_epoch) VALUES(?,?,?,?,?)').run(bind(p.project), bind(p.list_name), bind(p.fields), bind(p.created_at), bind(p.created_at_epoch)).lastInsertRowid);
      } else {
        if (!r.deleted && r.payload?.memory_session_id) {
          const missingSession = this.db.query(`SELECT 1 FROM self_sync_map m JOIN self_sync_heads h ON h.entity=m.entity JOIN self_sync_log l ON l.id=h.id
            WHERE m.kind='session' AND json_extract(l.body,'$.deleted')=1 AND EXISTS(
              SELECT 1 FROM self_sync_log prior WHERE json_extract(prior.body,'$.entity')=m.entity
              AND json_extract(prior.body,'$.payload.memory_session_id')=?) LIMIT 1`).get(bind(r.payload.memory_session_id));
          if (missingSession) throw new Error('tombstoned session identity collision; resolve the session explicitly');
        }
        const sessionsBefore = r.deleted ? null : this.contentSessionSnapshot(r);
        id = this.nativeApplier().applySelfHostedRow(this.op(r));
        if (!r.deleted && this.contentSessionSnapshot(r) !== sessionsBefore) throw new Error('content/session association identity collision; await authoritative portable session metadata');
        if (id !== null) {
          if (!r.deleted && hash(this.rowPayload({ ...m, row_id: id })) !== hash(r.payload)) throw new Error('content/session association identity collision; portable projection differs from its revision');
          this.queueIndex(r, id);
        }
      }
      this.db.query('UPDATE self_sync_map SET row_id=?,snapshot=? WHERE entity=?').run(r.deleted ? null : id, hash(r.payload), r.entity);
      this.db.query('DELETE FROM self_sync_errors WHERE entity=?').run(r.entity);
      this.db.exec('RELEASE self_sync_project');
    } catch (error) {
      this.db.exec('ROLLBACK TO self_sync_project');
      this.db.exec('RELEASE self_sync_project');
      const code = (error as { code?: string }).code;
      if (code && !code.startsWith('SQLITE_CONSTRAINT')) throw error;
      if (code || (error instanceof Error && /collision|collided/.test(error.message))) this.db.query('INSERT OR REPLACE INTO self_sync_errors(entity,reason) VALUES(?,?)').run(r.entity, 'identity/constraint conflict; inspect retained revisions and reconcile');
      else throw error;
    }
  }
  resolve(entity: string, chosen: string): void {
    this.db.transaction(() => {
      this.capture();
      const selected = this.getRevision(chosen);
      if (!selected || selected.entity !== entity || selected.kind === 'work') throw new Error('choose a retained content/session head; work conflicts resolve with a new local work_state_write');
      const op = revision({ ...selected, actor: this.requireConfig().device, parents: this.heads(entity) });
      this.append(op);
      this.project(op);
    }).immediate();
    emitContextInvalidation('all', 'SelfHostedSync.resolve', 'removal');
  }
  private workEvents(): Revision[] { return (this.db.query("SELECT body FROM self_sync_log WHERE json_extract(body,'$.kind')='work' ORDER BY seq").all() as Array<{ body: string }>).map(r => JSON.parse(r.body)); }
  private rebuildWorkProjection(): void {
    const events = this.workEvents(), byId = new Map(events.map(e => [e.id, e]));
    const memo = new Map<string, Set<string>>();
    const ancestors = (r: Revision): Set<string> => {
      const cached = memo.get(r.id); if (cached) return cached;
      const result = new Set<string>();
      // Iterative traversal avoids stack overflow on long-lived work lists.
      const pending = [...r.causes];
      while (pending.length) { const id = pending.pop()!; if (result.has(id)) continue; result.add(id); pending.push(...(byId.get(id)?.causes ?? [])); }
      memo.set(r.id, result); return result;
    };
    const groups = new Map<string, Revision[]>();
    for (const e of events) { const p = e.payload!, f = p.fields as Record<string, unknown>; const task = f.task === undefined || f.task === null || f.task === '' ? null : String(f.task); const key = canonicalJson([p.scope_project, p.list_name, task]); groups.set(key, [...groups.get(key) ?? [], e]); }
    this.db.query('DELETE FROM self_sync_work_projection').run();
    this.db.query('DELETE FROM self_sync_work_conflicts').run();
    for (const [scope, group] of groups) {
      const fields: Record<string, unknown> = Object.create(null), keys = new Set(group.flatMap(e => Object.keys(e.payload!.fields as object)));
      const task = JSON.parse(scope)[2];
      if (task !== null) fields.task = task;
      for (const key of keys) {
        if (key === 'task') continue; // identity follows the upstream renderer's String(task) rule
        const writes = group.filter(e => Object.hasOwn(e.payload!.fields as object, key));
        const live = writes.filter(e => !writes.some(other => other !== e && ancestors(other).has(e.id)));
        const values = new Set(live.map(e => canonicalJson((e.payload!.fields as Record<string, unknown>)[key])));
        if (values.size > 1) this.db.query('INSERT INTO self_sync_work_conflicts VALUES(?,?,?)').run(scope, key, canonicalJson(live.map(e => e.id).sort()));
        fields[key] = values.size > 1 ? `SYNC_CONFLICT (${live.length} concurrent values; inspect self-hosted sync status)` : (live[0].payload!.fields as Record<string, unknown>)[key];
      }
      const p = group[0].payload!;
      this.db.query('INSERT INTO self_sync_work_projection VALUES(?,?,?,?,?)').run(scope, bind(p.scope_project), bind(p.list_name), canonicalJson(fields), Math.max(...group.map(e => Number(e.payload!.created_at_epoch))));
    }
  }
  status(): Record<string, unknown> {
    if (!this.configured()) return { configured: false };
    const c = this.requireConfig();
    return { configured: true, protocol: PROTOCOL, schema: this.schema(), device: c.device, epoch: c.epoch, head: this.head(), peers: this.db.query('SELECT * FROM self_sync_peers').all(),
      conflicts: this.db.query('SELECT entity,COUNT(*) AS competing_heads FROM self_sync_heads GROUP BY entity HAVING COUNT(*)>1').all(),
      projectionErrors: this.db.query('SELECT * FROM self_sync_errors').all(),
      workConflicts: this.db.query('SELECT scope,field,revisions FROM self_sync_work_conflicts ORDER BY scope,field').all(),
      pendingIndexJobs: (this.db.query('SELECT COUNT(*) AS n FROM self_sync_jobs').get() as { n: number }).n };
  }
  /** Values never printed by status; explicit conflict inspection requires local authorization. */
  inspect(entity: string): Revision[] { return this.heads(entity).map(id => this.getRevision(id)!); }
  inspectWork(project: string, list: string): Revision[] { return this.workEvents().filter(e => this.workScope(e) === canonicalJson([this.canonicalWorkProject(project), list])); }
  async flushIndexJobs(): Promise<void> {
    if (!this.configured()) return;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      for (const job of this.db.query('SELECT * FROM self_sync_jobs ORDER BY seq').all() as Array<{ id: string; row_id: number; op: string }>) {
        try { await this.nativeApplier().forwardSelfHostedRow(JSON.parse(job.op), job.row_id); this.db.query('DELETE FROM self_sync_jobs WHERE id=?').run(job.id); }
        catch {
          logger.warn('SYNC_APPLY', 'Private sync indexing deferred; durable job retained');
          break; // durable retry on next exchange, startup or manual sync
        }
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
}
