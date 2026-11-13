import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai';

const directory = resolve(process.env.RESPROUT_CONFIG_DIR ?? '.resprout');
const file = resolve(directory, 'models.json');
let entries: Record<string, ModelsStoreEntry> | null = null;
let pending: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is ModelsStoreEntry {
  return isRecord(value) && Array.isArray(value.models);
}

async function load(): Promise<void> {
  if (entries) return;
  entries = {};
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(value)) return;
    for (const [providerId, entry] of Object.entries(value)) {
      if (isEntry(entry)) entries[providerId] = entry;
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
  }
}

async function persist(): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, 'models.json.tmp');
  await writeFile(temporary, JSON.stringify(entries ?? {}, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

export function createModelsStore(): ModelsStore {
  return {
    read: async providerId => {
      await load();
      return entries?.[providerId];
    },
    write: (providerId, entry) => serialize(async () => {
      await load();
      if (!entries) throw new Error('模型目录尚未初始化');
      entries[providerId] = entry;
      await persist();
    }),
    delete: providerId => serialize(async () => {
      await load();
      delete entries?.[providerId];
      await persist();
    }),
  };
}
