import { deletePdfFile } from './pdf-store.ts';

const STORAGE_KEY = 'resprout.session-library.v1';
const DEFAULT_TITLE = '未命名探索';

export interface StoredSessionNode {
  role?: unknown;
  content?: unknown;
  fileId?: unknown;
}

export type StoredSessionEdge = Record<string, unknown>;

export interface StoredSessionSnapshot {
  schemaVersion: 1;
  session: Record<string, unknown> & { id: string };
  nodes: StoredSessionNode[];
  edges: StoredSessionEdge[];
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
  preview: string;
  snapshot: StoredSessionSnapshot;
}

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

function readRecords(): SessionRecord[] {
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

function writeRecords(records: readonly SessionRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

export function listSessionRecords(): SessionRecord[] {
  return readRecords().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function saveSessionSnapshot(snapshot: StoredSessionSnapshot): SessionRecord {
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
  writeRecords([record, ...readRecords().filter(item => item.id !== id)]);
  return record;
}

export function saveSessionRecord(json: string): SessionRecord {
  const parsed: unknown = JSON.parse(json);
  if (!isStoredSessionSnapshot(parsed)) throw new Error('无法保存无效的会话');
  return saveSessionSnapshot(parsed);
}

export function readSessionRecord(id: string): string {
  const record = readRecords().find(item => item.id === id);
  if (!record) throw new Error('会话不存在或已被删除');
  return JSON.stringify(record.snapshot);
}

export async function deleteSessionRecord(id: string): Promise<void> {
  const removed = readRecords().find(record => record.id === id);
  const remaining = readRecords().filter(record => record.id !== id);
  const referenced = new Set<string>();
  for (const record of remaining) {
    for (const node of record.snapshot.nodes) {
      if (node.role === 'reference' && typeof node.fileId === 'string' && node.fileId) {
        referenced.add(node.fileId);
      }
    }
  }
  const removedAssets = new Set<string>();
  for (const node of removed?.snapshot.nodes ?? []) {
    if (node.role === 'reference' && typeof node.fileId === 'string' && node.fileId) {
      removedAssets.add(node.fileId);
    }
  }
  writeRecords(remaining);
  await Promise.all([...removedAssets]
    .filter(fileId => !referenced.has(fileId))
    .map(fileId => deletePdfFile(fileId).catch(() => {})));
}
