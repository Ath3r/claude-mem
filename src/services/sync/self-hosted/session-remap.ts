import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
import { canonicalJson, sha256Base64Url } from '../CanonicalContent.js';
import { PROTOCOL, entityId, portablePayload, revision, type Kind } from './protocol.js';
import type { Baseline } from './SelfHostedSync.js';

export const MAX_SESSION_REMAP_BYTES = 8 * 1024 * 1024;
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const local = z.string().regex(/^[1-9][0-9]{0,15}$/);
const reference = z.string().min(1).max(4096);
const schema = z.object({
  protocol: z.literal(PROTOCOL), namespace: z.string().uuid(), schema: z.number().int(),
  manifestHash: digest, sessionLocal: local,
  oldMemorySessionId: reference, newMemorySessionId: reference,
  reason: z.string().min(1).max(512),
  parentCompletion: z.object({
    mode: z.literal('completion-pair-after-remap-v1'),
    referenceOnlyHash: digest,
    reason: z.string().min(1).max(512),
  }).strict().optional(),
  rows: z.array(z.object({
    kind: z.enum(['session', 'observation', 'summary', 'prompt']), local,
    expectedHash: digest, currentHash: digest,
    baselinePayload: z.record(z.string(), z.unknown()),
  }).strict()).min(1).max(4096),
  // Explicitly reviewed new dependents are not baseline exceptions. They keep
  // ordinary device-owned roots; never infer independence from a hash mismatch.
  independentRows: z.array(z.object({
    kind: z.enum(['observation', 'summary', 'prompt']), local,
    expectedHash: z.null(), currentHash: digest,
  }).strict()).max(4096),
}).strict();
export type SessionRemapPlan = z.infer<typeof schema>;
type Row = Record<string, unknown> & { id: number };
const hash = (v: unknown) => sha256Base64Url(canonicalJson(v));
const key = (kind: Kind, local: string) => `${kind}:${local}`;

/** One explicitly audited reference graph. This authorizes journal roots and
 * causal local children, never SQL re-keying or a change to baseline ownership.
 * Caller holds setup's IMMEDIATE transaction; no helper writes or logs payloads. */
export function validateSessionRemapPlan(input: unknown, baseline: Baseline, rows: Map<Kind, Row[]>) {
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_SESSION_REMAP_BYTES) throw new Error('session remap plan exceeds size limit');
  const plan = schema.parse(input);
  if (plan.protocol !== baseline.protocol || plan.namespace !== baseline.namespace || plan.schema !== baseline.schema || plan.manifestHash !== hash(baseline)) throw new Error('session remap manifest mismatch');
  if (plan.oldMemorySessionId === plan.newMemorySessionId) throw new Error('session remap references must differ');
  const known = new Map(baseline.rows.map(r => [key(r.kind, r.local), r.hash]));
  const current = new Map([...rows].flatMap(([kind, values]) => values.map(r => [key(kind, String(r.id)), r] as const)));
  // Missing old members cannot be discovered from hashes alone. A partial
  // baseline is therefore never sufficient evidence for this exception.
  if (baseline.rows.some(r => !current.has(key(r.kind, r.local)))) throw new Error('session remap requires a complete baseline');
  const reviewed = new Map<string, SessionRemapPlan['rows'][number]>();
  for (const entry of plan.rows) {
    const k = key(entry.kind, entry.local), row = current.get(k);
    if (!row || reviewed.has(k) || known.get(k) !== entry.expectedHash || hash(entry.baselinePayload) !== entry.expectedHash) throw new Error('session remap baseline identity/hash mismatch');
    const payload = portablePayload(entry.kind, row);
    if (hash(payload) !== entry.currentHash || entry.currentHash === entry.expectedHash) throw new Error('session remap current hash mismatch');
    revision({ kind: entry.kind, entity: entityId(entry.kind, plan.namespace, entry.local), owner: plan.namespace, local: entry.local, actor: plan.namespace, parents: [], causes: [], payload: entry.baselinePayload, deleted: false });
    revision({ kind: entry.kind, entity: entityId(entry.kind, plan.namespace, entry.local), owner: plan.namespace, local: entry.local, actor: plan.namespace, parents: [], causes: [], payload, deleted: false });
    if (entry.baselinePayload.memory_session_id !== plan.oldMemorySessionId || payload.memory_session_id !== plan.newMemorySessionId) throw new Error('session remap unreviewed field/reference change');
    const referenceOnly: Record<string, unknown> = { ...entry.baselinePayload, memory_session_id: plan.newMemorySessionId };
    if (plan.parentCompletion && entry.kind === 'session' && entry.local === plan.sessionLocal) {
      // Validation witness only: it establishes the exact permitted difference,
      // not historical ordering. Return the original baseline for B -> C capture.
      if (hash(referenceOnly) !== plan.parentCompletion.referenceOnlyHash) throw new Error('session remap reference-only hash mismatch');
      const changed = Object.keys(payload).filter(field => canonicalJson(payload[field]) !== canonicalJson(referenceOnly[field])).sort();
      if (canonicalJson(changed) !== canonicalJson(['completed_at', 'completed_at_epoch'])) throw new Error('session remap unreviewed completion field change');
      const epoch = payload.completed_at_epoch;
      if (typeof epoch !== 'number' || typeof payload.completed_at !== 'string' || Date.parse(payload.completed_at) !== epoch || (entry.baselinePayload.completed_at_epoch !== null && epoch <= Number(entry.baselinePayload.completed_at_epoch))) throw new Error('session remap completion must advance');
    } else if (canonicalJson(referenceOnly) !== canonicalJson(payload)) throw new Error('session remap unreviewed field/reference change');
    reviewed.set(k, entry);
  }
  const session = reviewed.get(key('session', plan.sessionLocal));
  if (!session || plan.rows.filter(r => r.kind === 'session').length !== 1) throw new Error('session remap requires exactly one parent');
  const contentId = session.baselinePayload.content_session_id;
  const platform = session.baselinePayload.platform_source;
  const approved = new Set(reviewed.keys());
  for (const entry of plan.independentRows) {
    const k = key(entry.kind, entry.local), row = current.get(k);
    if (!row || known.has(k) || approved.has(k) || row.origin_device_id != null || row.origin_local_id != null) throw new Error('session remap independent identity collision');
    const payload = portablePayload(entry.kind, row);
    if (payload.memory_session_id !== plan.newMemorySessionId || hash(payload) !== entry.currentHash) throw new Error('session remap independent current hash/reference mismatch');
    revision({ kind: entry.kind, entity: entityId(entry.kind, plan.namespace, entry.local), owner: plan.namespace, local: entry.local, actor: plan.namespace, parents: [], causes: [], payload, deleted: false });
    approved.add(k);
  }
  const closure = new Set<string>();
  for (const [kind, values] of rows) {
    if (kind === 'work') continue;
    for (const row of values) {
      const k = key(kind, String(row.id));
      const linked = row.memory_session_id === plan.oldMemorySessionId || row.memory_session_id === plan.newMemorySessionId;
      if (kind === 'session') {
        if (linked || (row.content_session_id === contentId && row.platform_source === platform)) {
          if (String(row.id) !== plan.sessionLocal) throw new Error('session remap parent reference collision');
          closure.add(k);
        }
      } else if (linked || (kind === 'prompt' && (String(row.session_db_id) === plan.sessionLocal || row.content_session_id === contentId))) {
        if (kind === 'prompt' && (String(row.session_db_id) !== plan.sessionLocal || row.content_session_id !== contentId)) throw new Error('session remap prompt parent collision');
        closure.add(k);
      }
    }
  }
  if (closure.size !== approved.size || [...closure].some(k => !approved.has(k))) throw new Error('session remap incomplete or conflicting graph');
  logger.debug('SYNC_APPLY', 'Private session remap plan validated', { sharedRows: reviewed.size, independentRows: plan.independentRows.length });
  return reviewed;
}
