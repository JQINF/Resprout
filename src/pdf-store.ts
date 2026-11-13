const DATABASE_NAME = 'resprout-files';
const STORE_NAME = 'documents';
let databasePromise: Promise<IDBDatabase> | null = null;

export interface StoredPdfFile {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  updatedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('无法打开 PDF 文件数据库'));
      request.onblocked = () => reject(new Error('PDF 文件数据库被其他页面占用'));
    });
  }
  return databasePromise;
}

function complete<T>(request: IDBRequest<T>): Promise<T>;
function complete<T, R>(request: IDBRequest<T>, action: (value: T) => R): Promise<R>;
function complete<T, R>(request: IDBRequest<T>, action?: (value: T) => R): Promise<T | R> {
  return new Promise<T | R>((resolve, reject) => {
    request.onsuccess = () => resolve(action ? action(request.result) : request.result);
    request.onerror = () => reject(request.error ?? new Error('PDF 文件操作失败'));
  });
}

export async function savePdfFile(id: string, file: File): Promise<string> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const record: StoredPdfFile = {
    id,
    name: file.name,
    type: file.type || 'application/pdf',
    size: file.size,
    blob: file,
    updatedAt: new Date().toISOString(),
  };
  const request = transaction.objectStore(STORE_NAME).put(record);
  await complete(request);
  return id;
}

export async function readPdfFile(id: string): Promise<StoredPdfFile | null> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const request: IDBRequest<StoredPdfFile | undefined> = transaction.objectStore(STORE_NAME).get(id);
  return complete(request, value => value ?? null);
}

export async function deletePdfFile(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const request = transaction.objectStore(STORE_NAME).delete(id);
  await complete(request);
}
