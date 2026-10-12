import { z } from 'zod';
import { logger } from '../../../utils/logger.js';
import { canonicalJson, sha256Base64Url, stableDocumentId, buildContentOperation, canonicalDecimalToSafeInteger } from '../CanonicalContent.js';

export const PROTOCOL = 1;
export const PAGE_SIZE = 24;
export const MAX_PACKET_BYTES = 8 * 1024 * 1024;
export const TABLES = { session: 'sdk_sessions', observation: 'observations', summary: 'session_summaries', prompt: 'user_prompts', work: 'work_state_entries' } as const;
export type Kind = keyof typeof TABLES;
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const primitive = z.union([z.string().max(65536), z.number().finite(), z.boolean(), z.null()]);
const revisionSchema = z.object({
  id: digest, entity: z.string().max(100), kind: z.enum(['session', 'observation', 'summary', 'prompt', 'work']),
  owner: z.string().uuid(), local: z.string().regex(/^[1-9][0-9]{0,15}$/), actor: z.string().uuid(),
  parents: z.array(digest).max(256), causes: z.array(digest).max(256),
  payload: z.record(z.string(), z.unknown()).nullable(), deleted: z.boolean(),
}).strict();
export type Revision = z.infer<typeof revisionSchema>;
const changeSchema = z.object({ seq: sequence.refine(n => n > 0), revision: revisionSchema }).strict();
const packetSchema = z.object({
  protocol: z.literal(PROTOCOL), schema: sequence, sender: z.string().uuid(), epoch: z.string().uuid(),
  receiver: z.string().uuid().nullable(), receiverEpoch: z.string().uuid().nullable(),
  after: sequence, ack: sequence, changes: z.array(changeSchema).max(PAGE_SIZE), head: sequence,
}).strict();
export type Packet = z.infer<typeof packetSchema>;

export const SESSION_FIELDS = ['content_session_id', 'memory_session_id', 'project', 'platform_source', 'user_prompt', 'custom_title', 'started_at', 'started_at_epoch', 'completed_at', 'completed_at_epoch', 'observed_model', 'observed_billing'] as const;
export const CONTENT_FIELDS = {
  observation: ['memory_session_id', 'project', 'text', 'type', 'title', 'subtitle', 'facts', 'narrative', 'concepts', 'files_read', 'files_modified', 'prompt_number', 'discovery_tokens', 'content_hash', 'generated_by_model', 'agent_type', 'agent_id', 'metadata', 'merged_into_project', 'created_at', 'created_at_epoch'],
  summary: ['memory_session_id', 'project', 'request', 'investigated', 'learned', 'completed', 'next_steps', 'files_read', 'files_edited', 'notes', 'prompt_number', 'discovery_tokens', 'merged_into_project', 'created_at', 'created_at_epoch'],
  prompt: ['content_session_id', 'prompt_number', 'prompt_text', 'created_at', 'created_at_epoch', 'memory_session_id', 'project', 'platform_source'],
} as const;
const sessionSchema = z.object({
  content_session_id: z.string().min(1).max(4096), memory_session_id: z.string().min(1).max(4096).nullable(),
  project: z.string().min(1).max(4096), platform_source: z.string().min(1).max(128),
  user_prompt: z.string().nullable(), custom_title: z.string().nullable(),
  started_at: z.string().datetime(), started_at_epoch: sequence,
  completed_at: z.string().datetime().nullable(), completed_at_epoch: sequence.nullable(),
  observed_model: z.string().nullable(), observed_billing: z.string().nullable(),
}).strict();
const workSchema = z.object({ project: z.string().min(1).max(4096), list_name: z.string().min(1).max(256), fields: z.record(z.string().min(1).max(256), primitive).refine(v => Object.keys(v).length <= 256), created_at: z.string().datetime(), created_at_epoch: sequence }).strict();

export function entityId(kind: Kind, owner: string, local: string): string {
  if (kind === 'session' || kind === 'work') return `${kind}:${sha256Base64Url(canonicalJson(['cmem-doc-id-v1', 'device', kind, owner, local]))}`;
  return stableDocumentId(kind, owner, local);
}
export function revision(input: Omit<Revision, 'id'>): Revision {
  const { id: _previousId, ...fields } = input as Revision;
  const body = { ...fields, parents: [...input.parents].sort(), causes: [...input.causes].sort() };
  const result = { ...body, id: sha256Base64Url(canonicalJson(body)) };
  validateRevision(result);
  return result;
}
export function validateRevision(input: unknown): Revision {
  const value = revisionSchema.parse(input);
  const { id, ...body } = value;
  if (Buffer.byteLength(canonicalJson(value)) > 260_000) throw new Error('revision exceeds size limit');
  if (id !== sha256Base64Url(canonicalJson(body)) || value.entity !== entityId(value.kind, value.owner, value.local)) throw new Error('revision identity/hash mismatch');
  for (const ids of [value.parents, value.causes]) {
    if (new Set(ids).size !== ids.length || ids.includes(value.id) || canonicalJson(ids) !== canonicalJson([...ids].sort())) throw new Error('invalid causal references');
  }
  if (value.deleted !== (value.payload === null)) throw new Error('invalid tombstone');
  if (value.kind === 'work' && (value.deleted || value.parents.length)) throw new Error('work events are append-only');
  if (value.kind !== 'work' && value.causes.length) throw new Error('only work events have list causal references');
  if (value.payload !== null) {
    if (value.kind === 'session') sessionSchema.parse(value.payload);
    else if (value.kind === 'work') workSchema.parse(value.payload);
    else {
      buildContentOperation({ kind: value.kind, originDeviceId: value.owner, originLocalId: value.local, entityRev: '1', payload: value.payload });
      for (const key of DECIMAL_FIELDS) if (value.payload[key] != null) canonicalDecimalToSafeInteger(value.payload[key], key);
    }
  }
  return value;
}
export function parsePacket(input: unknown): Packet {
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_PACKET_BYTES) throw new Error('packet exceeds size limit');
    const packet = packetSchema.parse(input);
    for (const change of packet.changes) validateRevision(change.revision);
    return packet;
  } catch (error) {
    // Validation errors can contain remote memory values; log no input or error details.
    logger.debug('SYNC_APPLY', 'Private sync packet rejected');
    throw error;
  }
}
export const JSON_FIELDS = new Set(['facts', 'concepts', 'files_read', 'files_modified', 'files_edited', 'metadata', 'fields']);
export const DECIMAL_FIELDS = new Set(['prompt_number', 'discovery_tokens', 'created_at_epoch']);
export function nativePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v === null ? null : JSON_FIELDS.has(k) ? canonicalJson(v) : DECIMAL_FIELDS.has(k) && typeof v === 'string' ? canonicalDecimalToSafeInteger(v, k) : v]));
}
export function portablePayload(kind: Kind, row: Record<string, unknown>): Record<string, unknown> {
  const fields = kind === 'session' ? SESSION_FIELDS : kind === 'work' ? ['project', 'list_name', 'fields', 'created_at', 'created_at_epoch'] : CONTENT_FIELDS[kind];
  return Object.fromEntries(fields.map(k => {
    const v = row[k] ?? null;
    return [k, v === null ? null : JSON_FIELDS.has(k) ? typeof v === 'string' ? JSON.parse(v) : v : kind !== 'session' && kind !== 'work' && DECIMAL_FIELDS.has(k) ? String(v) : v];
  }));
}
