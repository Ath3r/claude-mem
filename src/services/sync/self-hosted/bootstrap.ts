import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
import { canonicalJson, sha256Base64Url } from '../CanonicalContent.js';
import { PROTOCOL, entityId, revision, portablePayload } from './protocol.js';
import type { Baseline } from './SelfHostedSync.js';

const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const completionFields = ['completed_at', 'completed_at_epoch'] as const;
const planSchema = z.object({
  protocol: z.literal(PROTOCOL), namespace: z.string().uuid(), schema: z.number().int(),
  manifestHash: digest,
  sessions: z.array(z.object({
    local: z.string().regex(/^[1-9][0-9]{0,15}$/), expectedHash: digest, currentHash: digest,
    allowedFields: z.array(z.enum(completionFields)).min(1).max(2),
    baselinePayload: z.record(z.string(), z.unknown()),
    reason: z.string().min(1).max(512),
  }).strict()).min(1).max(256),
}).strict();
export type BootstrapPlan = z.infer<typeof planSchema>;
const hash = (value: unknown) => sha256Base64Url(canonicalJson(value));

/** A plan is an audited, hash-bound exception for completion metadata only. It
 * cannot rename a row, reassign ownership, bless another kind, or erase history.
 * Run under setup's IMMEDIATE transaction before creating any sync state. */
export function validateBootstrapPlan(input: unknown, baseline: Baseline, rows: Map<string, Record<string, unknown>>) {
  if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error('bootstrap plan exceeds size limit');
  const plan = planSchema.parse(input);
  if (plan.protocol !== baseline.protocol || plan.namespace !== baseline.namespace || plan.schema !== baseline.schema || plan.manifestHash !== hash(baseline)) throw new Error('bootstrap plan manifest mismatch');
  const known = new Map(baseline.rows.filter(row => row.kind === 'session').map(row => [row.local, row.hash]));
  const reviewed = new Map<string, BootstrapPlan['sessions'][number]>();
  for (const entry of plan.sessions) {
    const row = rows.get(entry.local);
    if (!row || reviewed.has(entry.local) || known.get(entry.local) !== entry.expectedHash || hash(entry.baselinePayload) !== entry.expectedHash) throw new Error('bootstrap baseline identity/hash mismatch');
    const current = portablePayload('session', row);
    if (hash(current) !== entry.currentHash || entry.expectedHash === entry.currentHash) throw new Error('bootstrap current hash mismatch');
    // Validate the entire old payload, including strict identity and schema.
    revision({ kind: 'session', entity: entityId('session', plan.namespace, entry.local), owner: plan.namespace, local: entry.local, actor: plan.namespace, parents: [], causes: [], payload: entry.baselinePayload, deleted: false });
    const changed = Object.keys(current).filter(key => canonicalJson(current[key]) !== canonicalJson(entry.baselinePayload[key])).sort();
    const allowed = [...new Set(entry.allowedFields)].sort();
    if (allowed.length !== entry.allowedFields.length || canonicalJson(changed) !== canonicalJson(allowed)) throw new Error('bootstrap unreviewed field change');
    // Only an advance to a complete, consistent timestamp pair is accepted.
    const epoch = current.completed_at_epoch;
    if (typeof epoch !== 'number' || typeof current.completed_at !== 'string' || Date.parse(current.completed_at) !== epoch || (entry.baselinePayload.completed_at_epoch !== null && epoch <= Number(entry.baselinePayload.completed_at_epoch))) throw new Error('bootstrap completion must advance');
    reviewed.set(entry.local, entry);
  }
  logger.debug('SYNC_APPLY', 'Private bootstrap plan validated', { sessions: reviewed.size });
  return reviewed;
}
