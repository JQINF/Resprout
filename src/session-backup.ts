import { exportSessionSnapshot, importSession } from './session.ts';
import type { ConversationNode, Session, SessionSnapshot } from './session.ts';
import { readPdfFile, savePdfFile } from './pdf-store.ts';

interface BackupAsset {
  id: string;
  name: string;
  mimeType: string;
  data: string;
}

export interface RestoredSessionBackup {
  snapshot: SessionSnapshot;
  missingAssets: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assetReferences(nodes: readonly ConversationNode[]): Map<string, string> {
  const references = new Map<string, string>();
  for (const node of nodes) {
    if (node.data.fileId) references.set(node.data.fileId, node.data.fileName ?? node.data.fileId);
    if (node.data.imageAssetId) references.set(node.data.imageAssetId, `${node.data.fileName ?? '选区图片'}（选区图片）`);
  }
  return references;
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('附件读取失败'));
    reader.readAsDataURL(blob);
  });
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function exportSessionBackup(session: Session, nodes: ConversationNode[], edges: SessionSnapshot['edges']): Promise<string> {
  const snapshot = exportSessionSnapshot(session, nodes, edges);
  const references = assetReferences(nodes);
  const assets: BackupAsset[] = [];
  for (const [id, name] of references) {
    const record = await readPdfFile(id);
    if (!record) throw new Error(`附件“${name}”已缺失，请先重新关联后再备份`);
    assets.push({
      id,
      name: record.name || name,
      mimeType: record.type || 'application/octet-stream',
      data: await blobBase64(record.blob),
    });
  }
  return JSON.stringify({ ...snapshot, schemaVersion: 2, assets }, null, 2);
}

export async function importSessionBackup(text: string): Promise<RestoredSessionBackup> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error('不是受支持的 Resprout 备份文件');
  }
  const snapshot = importSession(JSON.stringify({ ...value, schemaVersion: 1 }));
  if (value.schemaVersion === 1) {
    const missing: string[] = [];
    for (const [id, name] of assetReferences(snapshot.nodes)) {
      if (!await readPdfFile(id)) missing.push(name);
    }
    return { snapshot, missingAssets: missing };
  }
  if (!Array.isArray(value.assets)) throw new Error('备份附件列表无效');
  const seen = new Set<string>();
  for (const raw of value.assets) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.data !== 'string') {
      throw new Error('备份附件内容无效');
    }
    if (seen.has(raw.id)) throw new Error('备份包含重复附件 ID');
    seen.add(raw.id);
    if (await readPdfFile(raw.id)) continue;
    const name = typeof raw.name === 'string' && raw.name ? raw.name : raw.id;
    const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : 'application/octet-stream';
    await savePdfFile(raw.id, new File([decodeBase64(raw.data)], name, { type: mimeType }));
  }
  const missing: string[] = [];
  for (const [id, name] of assetReferences(snapshot.nodes)) {
    if (!await readPdfFile(id)) missing.push(name);
  }
  return { snapshot, missingAssets: missing };
}
