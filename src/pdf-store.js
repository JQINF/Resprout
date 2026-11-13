const DATABASE_NAME = 'resprout-files';
const STORE_NAME = 'documents';
let databasePromise = null;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('无法打开 PDF 文件数据库'));
      request.onblocked = () => reject(new Error('PDF 文件数据库被其他页面占用'));
    });
  }
  return databasePromise;
}

function complete(request, action) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(action?.(request.result));
    request.onerror = () => reject(request.error ?? new Error('PDF 文件操作失败'));
  });
}

export async function savePdfFile(id, file) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const request = transaction.objectStore(STORE_NAME).put({
    id,
    name: file.name,
    type: file.type || 'application/pdf',
    size: file.size,
    blob: file,
    updatedAt: new Date().toISOString(),
  });
  await complete(request);
  return id;
}

export async function readPdfFile(id) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const request = transaction.objectStore(STORE_NAME).get(id);
  return complete(request, value => value ?? null);
}

export async function deletePdfFile(id) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const request = transaction.objectStore(STORE_NAME).delete(id);
  return complete(request);
}
