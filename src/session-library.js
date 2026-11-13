import { deletePdfFile } from './pdf-store.js';

const STORAGE_KEY = 'resprout.session-library.v1';

function readRecords() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(record => record && typeof record.id === 'string' && record.snapshot) : [];
  } catch {
    return [];
  }
}

function writeRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function recordTitle(snapshot) {
  const title = String(snapshot.session.title ?? '').trim();
  if (title && title !== '未命名探索') return title;
  const firstQuestion = snapshot.nodes.find(node => (node.role ?? 'user') === 'user' && String(node.content ?? '').trim());
  return firstQuestion ? String(firstQuestion.content).trim().replace(/\s+/g, ' ').slice(0, 48) : '未命名探索';
}

export function listSessionRecords() {
  return readRecords().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function saveSessionRecord(json) {
  const snapshot = JSON.parse(json);
  if (snapshot.schemaVersion !== 1 || !snapshot.session?.id || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
    throw new Error('无法保存无效的会话');
  }
  const id = String(snapshot.session.id);
  const updatedAt = String(snapshot.session.updatedAt ?? new Date().toISOString());
  const firstAnswer = snapshot.nodes.find(node => node.role === 'assistant' && String(node.content ?? '').trim());
  const record = {
    id,
    title: recordTitle(snapshot),
    createdAt: String(snapshot.session.createdAt ?? updatedAt),
    updatedAt,
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
    preview: firstAnswer ? String(firstAnswer.content).trim().replace(/\s+/g, ' ').slice(0, 120) : '',
    snapshot,
  };
  writeRecords([record, ...readRecords().filter(item => item.id !== id)]);
  return record;
}

export function readSessionRecord(id) {
  const record = readRecords().find(item => item.id === id);
  if (!record) throw new Error('会话不存在或已被删除');
  return JSON.stringify(record.snapshot);
}

export async function deleteSessionRecord(id) {
  const removed = readRecords().find(record => record.id === id);
  const remaining = readRecords().filter(record => record.id !== id);
  const referenced = new Set(remaining.flatMap(record => record.snapshot.nodes ?? [])
    .filter(node => node.role === 'reference' && node.fileId)
    .map(node => node.fileId));
  const removedAssets = new Set((removed?.snapshot.nodes ?? [])
    .filter(node => node.role === 'reference' && node.fileId)
    .map(node => node.fileId));
  writeRecords(remaining);
  await Promise.all([...removedAssets]
    .filter(fileId => !referenced.has(fileId))
    .map(fileId => deletePdfFile(fileId).catch(() => {})));
}
