import { deletePdfFile } from './pdf-store.ts';

const STORAGE_KEY = 'resprout.session-library.v1';
const MIGRATION_KEY = 'resprout.session-library.idb-migration-v1';
const DATABASE_NAME = 'resprout-sessions';
const SNAPSHOT_STORE = 'snapshots';
const SUMMARY_STORE = 'summaries';
const DEFAULT_TITLE = '未命名探索';

export interface StoredSessionNode {
  role?: unknown;
  content?: unknown;
  fileId?: unknown;
  imageAssetId?: unknown;
}

export type StoredSessionEdge = Record<string, unknown>;

export interface StoredSessionSnapshot {
  schemaVersion: 1;
  session: Record<string, unknown> & { id: string };
  nodes: StoredSessionNode[];
  edges: StoredSessionEdge[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
  preview: string;
}

export interface SessionRecord extends SessionSummary {
  snapshot: StoredSessionSnapshot;
}

interface SnapshotRow {
  id: string;
  snapshot: StoredSessionSnapshot;
}

let databasePromise: Promise<IDBDatabase> | null = null;
let migrationPromise: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredSessionSnapshot(value: unknown): value is StoredSessionSnapshot {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (!isRecord(value.session) || typeof value.session.id !== 'string') return false;
  return Array.isArray(value.nodes)
    && value.nodes.every(isRecord)
    && Array.isArray(value.edges)
    && value.edges.every(isRecord);
}

function recordTitle(snapshot: StoredSessionSnapshot): string {
  const title = String(snapshot.session.title ?? '').trim();
  if (title && title !== DEFAULT_TITLE) return title;
  const firstQuestion = snapshot.nodes.find(node =>
    (node.role ?? 'user') === 'user' && Boolean(String(node.content ?? '').trim()));
  return firstQuestion
    ? String(firstQuestion.content).trim().replace(/\s+/g, ' ').slice(0, 48)
    : DEFAULT_TITLE;
}

function normalizeRecord(value: Record<string, unknown>, snapshot: StoredSessionSnapshot): SessionRecord {
  return {
    id: String(value.id),
    title: typeof value.title === 'string' ? value.title : recordTitle(snapshot),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    nodeCount: typeof value.nodeCount === 'number' && Number.isFinite(value.nodeCount)
      ? value.nodeCount
      : snapshot.nodes.length,
    edgeCount: typeof value.edgeCount === 'number' && Number.isFinite(value.edgeCount)
      ? value.edgeCount
      : snapshot.edges.length,
    preview: typeof value.preview === 'string' ? value.preview : '',
    snapshot,
  };
}

function readLegacyRecords(): SessionRecord[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const records: SessionRecord[] = [];
    for (const value of parsed) {
      if (!isRecord(value) || typeof value.id !== 'string') continue;
      const snapshot = value.snapshot;
      if (!isStoredSessionSnapshot(snapshot)) continue;
      records.push(normalizeRecord(value, snapshot));
    }
    return records;
  } catch {
    return [];
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SNAPSHOT_STORE)) {
          request.result.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
        }
        if (!request.result.objectStoreNames.contains(SUMMARY_STORE)) {
          request.result.createObjectStore(SUMMARY_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('无法打开会话数据库'));
      request.onblocked = () => reject(new Error('会话数据库被其他页面占用'));
    });
  }
  return databasePromise;
}

function complete<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('会话数据库操作失败'));
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('会话数据库提交失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('会话数据库提交被中止'));
  });
}

function summaryOf(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
    edgeCount: record.edgeCount,
    preview: record.preview,
  };
}

async function writeRecord(record: SessionRecord, summaryOnly = false): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(summaryOnly ? [SUMMARY_STORE] : [SNAPSHOT_STORE, SUMMARY_STORE], 'readwrite');
  if (!summaryOnly) transaction.objectStore(SNAPSHOT_STORE).put({ id: record.id, snapshot: record.snapshot });
  transaction.objectStore(SUMMARY_STORE).put(summaryOf(record));
  await committed(transaction);
}

async function readSnapshotRow(id: string): Promise<SnapshotRow | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(SNAPSHOT_STORE, 'readonly');
  return complete(transaction.objectStore(SNAPSHOT_STORE).get(id) as IDBRequest<SnapshotRow | undefined>);
}

async function readSummaryRow(id: string): Promise<SessionSummary | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(SUMMARY_STORE, 'readonly');
  return complete(transaction.objectStore(SUMMARY_STORE).get(id) as IDBRequest<SessionSummary | undefined>);
}

async function migrateLegacy(): Promise<void> {
  for (const record of readLegacyRecords()) {
    const existing = await readSnapshotRow(record.id);
    const existingUpdatedAt = existing ? String(existing.snapshot.session.updatedAt ?? '') : '';
    const shouldWrite = !existing
      || Date.parse(record.updatedAt) > Date.parse(existingUpdatedAt)
      || (existingUpdatedAt === '' && record.updatedAt !== '');
    if (shouldWrite) await writeRecord(record);
    else if (!await readSummaryRow(record.id)) await writeRecord(record, true);
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(MIGRATION_KEY, 'done');
  } catch {}
}

async function ensureMigrated(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATION_KEY) === 'done') return;
  } catch {}
  if (!migrationPromise) {
    migrationPromise = migrateLegacy().catch(error => {
      migrationPromise = null;
      throw error;
    });
  }
  const pending = migrationPromise;
  await pending;
  if (migrationPromise === pending) migrationPromise = null;
}

export async function listSessionRecords(): Promise<SessionSummary[]> {
  await ensureMigrated();
  const database = await openDatabase();
  const transaction = database.transaction(SUMMARY_STORE, 'readonly');
  const records = await complete(transaction.objectStore(SUMMARY_STORE).getAll() as IDBRequest<SessionSummary[]>);
  return records.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function saveSessionSnapshot(snapshot: StoredSessionSnapshot): Promise<SessionRecord> {
  if (!isStoredSessionSnapshot(snapshot)) throw new Error('无法保存无效的会话');
  await ensureMigrated();
  const id = snapshot.session.id;
  const updatedAt = String(snapshot.session.updatedAt ?? new Date().toISOString());
  const firstAnswer = snapshot.nodes.find(node =>
    node.role === 'assistant' && Boolean(String(node.content ?? '').trim()));
  const record: SessionRecord = {
    id,
    title: recordTitle(snapshot),
    createdAt: String(snapshot.session.createdAt ?? updatedAt),
    updatedAt,
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
    preview: firstAnswer
      ? String(firstAnswer.content).trim().replace(/\s+/g, ' ').slice(0, 120)
      : '',
    snapshot,
  };
  await writeRecord(record);
  return record;
}

export async function saveSessionRecord(json: string): Promise<SessionRecord> {
  const parsed: unknown = JSON.parse(json);
  if (!isStoredSessionSnapshot(parsed)) throw new Error('无法保存无效的会话');
  return saveSessionSnapshot(parsed);
}

export async function hasSessionRecord(id: string): Promise<boolean> {
  await ensureMigrated();
  return Boolean(await readSnapshotRow(id));
}

export async function readSessionRecord(id: string): Promise<string> {
  await ensureMigrated();
  const row = await readSnapshotRow(id);
  if (!row) throw new Error('会话不存在或已被删除');
  return JSON.stringify(row.snapshot);
}

function storedAssetIds(node: StoredSessionNode): string[] {
  return [node.fileId, node.imageAssetId]
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
}

export async function assetReferencedByOtherSessions(fileId: string, sessionId: string): Promise<boolean> {
  await ensureMigrated();
  const database = await openDatabase();
  const transaction = database.transaction(SNAPSHOT_STORE, 'readonly');
  const rows = await complete(transaction.objectStore(SNAPSHOT_STORE).getAll() as IDBRequest<SnapshotRow[]>);
  return rows.some(row => row.id !== sessionId
    && row.snapshot.nodes.some(node => storedAssetIds(node).includes(fileId)));
}

export async function deleteSessionRecord(id: string): Promise<void> {
  await ensureMigrated();
  const removed = await readSnapshotRow(id);
  const database = await openDatabase();
  const readTransaction = database.transaction(SNAPSHOT_STORE, 'readonly');
  const rows = await complete(readTransaction.objectStore(SNAPSHOT_STORE).getAll() as IDBRequest<SnapshotRow[]>);
  const referenced = new Set<string>();
  for (const row of rows) {
    if (row.id === id) continue;
    for (const node of row.snapshot.nodes) {
      for (const fileId of storedAssetIds(node)) referenced.add(fileId);
    }
  }
  const removedAssets = new Set<string>();
  for (const node of removed?.snapshot.nodes ?? []) {
    for (const fileId of storedAssetIds(node)) removedAssets.add(fileId);
  }
  const transaction = database.transaction([SNAPSHOT_STORE, SUMMARY_STORE], 'readwrite');
  transaction.objectStore(SNAPSHOT_STORE).delete(id);
  transaction.objectStore(SUMMARY_STORE).delete(id);
  await committed(transaction);
  await Promise.all([...removedAssets]
    .filter(fileId => !referenced.has(fileId))
    .map(fileId => deletePdfFile(fileId).catch(() => {})));
}
