import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { PROTOCOL } from '../sync/self-hosted/constants/protocol-version.js';

/**
 * work_state_entries (v61): the agent's canonical to-do lists and working
 * state, written through the `work_state_write` MCP tool and shown at the start
 * of every session until closed.
 *
 * Append-only, one row per write. A list is replayed in write order
 * (getWorkStateEntries) and the latest value of each key wins
 * (WorkStateRenderer.foldWorkStateList), so a write only names the keys it changes. Rows are keyed by the checkout's project, so lists
 * follow the project across sessions without living in the repo, where two
 * branches appending to the same file conflicted on merge.
 */

export type WorkStateValue = string | number | boolean | null;
export type WorkStateFields = Record<string, WorkStateValue>;

export interface WorkStateEntry {
  id: number;
  project: string;
  /** Logical checkout key shared by its configured, legacy and parent read aliases. */
  scope_project?: string;
  list_name: string;
  fields: WorkStateFields;
  created_at_epoch: number;
}

/** Explicit checkout aliases share a history; adopted projects retain their own scope. */
export function scopeWorkStateEntries(entries: WorkStateEntry[], projects: string[]): WorkStateEntry[] {
  const foldKey = (key: string) => key.replace(/[A-Z]/g, character => character.toLowerCase());
  const aliases = new Set(projects.map(foldKey));
  const primary = projects.at(-1);
  return entries.map(entry => primary && aliases.has(foldKey(entry.project))
    ? { ...entry, scope_project: primary }
    : entry);
}

export function createWorkStateSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS work_state_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      list_name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_work_state_entries_project ON work_state_entries(project COLLATE NOCASE, list_name, id)');
  ensureWorkStateSyncColumns(db);
}

/**
 * Cloud sync columns (v66), the shape the row tables got in v39/v41: a row
 * syncs as the `work_state` content kind (CloudSync KINDS, SyncApply
 * applyWorkState). `synced_at` stays NULL until the hub acks the row; the
 * origin columns stay NULL on native rows and name the writing device and its
 * rowid on rows pulled from another device, where the partial unique index
 * makes re-applying a pulled row an upsert; `sync_rev` is the entity revision.
 * The PRAGMA checks are the guard; the schema version row is bookkeeping.
 */
function ensureWorkStateSyncColumns(db: Database): void {
  const columns = new Set(
    (db.query('PRAGMA table_info(work_state_entries)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!columns.has('synced_at')) db.run('ALTER TABLE work_state_entries ADD COLUMN synced_at INTEGER');
  if (!columns.has('origin_device_id')) db.run('ALTER TABLE work_state_entries ADD COLUMN origin_device_id TEXT');
  if (!columns.has('origin_local_id')) db.run('ALTER TABLE work_state_entries ADD COLUMN origin_local_id TEXT');
  if (!columns.has('sync_rev')) db.run("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'");
  db.run('CREATE INDEX IF NOT EXISTS idx_work_state_entries_unsynced ON work_state_entries(id) WHERE synced_at IS NULL');
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_work_state_entries_origin
    ON work_state_entries(origin_device_id, origin_local_id)
    WHERE origin_device_id IS NOT NULL
  `);
}

export function appendWorkStateEntry(
  db: Database,
  entry: { project: string; listName: string; fields: WorkStateFields; createdAtEpoch?: number },
): number {
  const createdAtEpoch = entry.createdAtEpoch ?? Date.now();
  const result = db.prepare(`
    INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(entry.project, entry.listName, JSON.stringify(entry.fields), new Date(createdAtEpoch).toISOString(), createdAtEpoch);
  const id = Number(result.lastInsertRowid);
  logger.debug('DB', 'Work state entry appended', { id, project: entry.project, listName: entry.listName });
  return id;
}

/**
 * Every entry stored under these project keys (and one list, when named), in
 * write order, the order cmem.ai folds in: the write clock, then the writing
 * device, then its rowid there. A row pulled from another device replays where
 * it was written rather than where it landed. A native row is this device's
 * (`localDeviceId`), so every device orders the same rows the same way, even
 * two writes made in the same millisecond.
 */
export function getWorkStateEntries(
  db: Database,
  projects: string[],
  listName?: string,
  localDeviceId = '',
): WorkStateEntry[] {
  if (projects.length === 0) return [];
  const placeholders = projects.map(() => '?').join(', ');
  const listFilter = listName === undefined ? '' : ' AND list_name = ?';
  const statement = db.prepare(`
    SELECT id, project, list_name, fields, created_at_epoch
    FROM work_state_entries
    WHERE project COLLATE NOCASE IN (${placeholders})${listFilter}
    ORDER BY created_at_epoch, COALESCE(origin_device_id, ?), COALESCE(CAST(origin_local_id AS INTEGER), id)
  `);
  let entries: WorkStateEntry[];
  try {
    const rows = statement.all(...projects, ...(listName === undefined ? [] : [listName]), localDeviceId) as Array<Omit<WorkStateEntry, 'fields'> & { fields: string }>;
    entries = rows.map(row => ({ ...row, fields: JSON.parse(row.fields) as WorkStateFields }));
  } finally {
    statement.finalize();
  }
  // The fork's opt-in lane projects causal work events. Preserve unsynced local
  // appends after that projection so offline writes remain immediately visible.
  // Installs that never opted in have no self_sync tables: prepare fails and native entries stand.
  let syncConfig: { enabled: number; protocol: number } | undefined;
  try {
    syncConfig = readOnce(db, 'SELECT enabled,protocol FROM self_sync_config WHERE singleton=1', s => s.get()) as typeof syncConfig;
  } catch (error) {
    if (/no such table: self_sync_config/.test(String(error))) return entries;
    throw error;
  }
  if (!syncConfig?.enabled) return entries;
  if (syncConfig.protocol !== PROTOCOL) throw new Error('private work journal protocol mismatch; explicit migration required');
  const captured = new Set((readOnce(db, "SELECT row_id FROM self_sync_map WHERE kind='work' AND row_id IS NOT NULL", s => s.all()) as Array<{ row_id: number }>).map(row => row.row_id));
  const canonicalProjects = readOnce(db, 'SELECT canonical FROM self_sync_work_aliases WHERE project=?', alias => [...new Set(projects.map(project => {
    const key = project.replace(/[A-Z]/g, character => character.toLowerCase());
    return (alias.get(key) as { canonical: string } | undefined)?.canonical ?? project;
  }))]);
  const projectionPlaceholders = canonicalProjects.map(() => '?').join(', ');
  const projected = readOnce(db, `SELECT project,list_name,fields,created_at_epoch FROM self_sync_work_projection
    WHERE project COLLATE NOCASE IN (${projectionPlaceholders})${listFilter} ORDER BY scope`,
    s => s.all(...canonicalProjects, ...(listName === undefined ? [] : [listName]))) as Array<Omit<WorkStateEntry, 'id' | 'fields'> & { fields: string }>;
  return [...projected.map((row, index) => ({ ...row, id: index + 1, fields: JSON.parse(row.fields) as WorkStateFields })), ...entries.filter(entry => !captured.has(entry.id))];
}

/** Fork-only reads follow upstream statement ownership: prepare, use, finalize. */
function readOnce<T>(db: Database, sql: string, use: (statement: ReturnType<Database['prepare']>) => T): T {
  const statement = db.prepare(sql);
  try {
    return use(statement);
  } finally {
    statement.finalize();
  }
}
