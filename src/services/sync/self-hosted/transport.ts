import { spawn } from 'node:child_process';
import { logger } from '../../../utils/logger.js';
import { MAX_PACKET_BYTES } from './protocol.js';

export interface SyncConnection { worker: string; token: string }
export interface SshConnection { target: string; port: number; token: string }
export function loopbackWorker(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('worker must be an HTTP loopback origin');
  return url.origin;
}
export function validateToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid sync token'); return token;
}
function endpoint(route: string): string {
  if (!['status', 'baseline', 'reconcile', 'setup', 'enabled', 'prepare', 'exchange', 'accept', 'resolve', 'inspect', 'inspect-work'].includes(route)) throw new Error('unsupported sync route');
  return `/api/self-hosted-sync/${route}`;
}
export async function workerRequest(connection: SyncConnection, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${loopbackWorker(connection.worker)}${endpoint(route)}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(connection.token ? { authorization: `Bearer ${validateToken(connection.token)}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  });
  const text = await boundedResponse(response);
  if (!response.ok) {
    logger.warn('SYNC_APPLY', 'Private sync worker request rejected', { route, status: response.status });
    throw new Error(`worker ${route} rejected request (HTTP ${response.status})`);
  }
  return JSON.parse(text);
}
async function boundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error('empty worker response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > MAX_PACKET_BYTES) throw new Error('worker response exceeds size limit'); chunks.push(chunk.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
/** Fixed remote command, validated numeric port/token/target, no remote paths or SQL.
 * JSON travels on stdin. BatchMode retains the user's SSH host-key policy.
 */
export function sshRequest(connection: SshConnection, route: string, body?: unknown): Promise<unknown> {
  if (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(connection.target)) throw new Error('unsafe SSH target');
  if (!Number.isInteger(connection.port) || connection.port < 1024 || connection.port > 65535) throw new Error('invalid receiver port');
  const auth = connection.token ? ` -H 'Authorization: Bearer ${validateToken(connection.token)}'` : '';
  const method = body === undefined ? '' : " -H 'Content-Type: application/json' --data-binary @-";
  const command = `curl --silent --show-error --fail --max-time 30 --max-filesize ${MAX_PACKET_BYTES}${auth}${method} http://127.0.0.1:${connection.port}${endpoint(route)}`;
  const input = body === undefined ? '' : JSON.stringify(body);
  if (Buffer.byteLength(input) > MAX_PACKET_BYTES) throw new Error('SSH request exceeds size limit');
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', connection.target, command], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const timeout = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('SSH request timed out')); }, 45_000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        logger.warn('SYNC_APPLY', 'Private sync SSH exchange failed; retry remains available');
        reject(error);
      } else {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch {
          logger.warn('SYNC_APPLY', 'Private sync SSH response rejected');
          reject(new Error('invalid SSH receiver response'));
        }
      }
    }
    child.on('error', error => finish(error)); child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // never print remote memory, tokens, or config
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_PACKET_BYTES) { child.kill('SIGTERM'); finish(new Error('SSH response exceeds size limit')); } else chunks.push(chunk); });
    child.on('close', code => finish(code === 0 ? undefined : new Error(`SSH/receiver failed (exit ${code}); local writes remain available; retry sync later`)));
    child.stdin.end(input);
  });
}
