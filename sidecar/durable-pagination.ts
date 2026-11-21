import type { Context } from '@earendil-works/chord/context';
import type { Cursor, DocumentQuery, DocumentRecord, Page } from '@earendil-works/pi-durable';

export interface DocumentScanner {
  scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context): Promise<Page<DocumentRecord, Cursor>>;
}

export async function scanDocumentsAll(
  storage: DocumentScanner,
  query: DocumentQuery,
  limit: number,
  context: Context,
  visit: (record: DocumentRecord) => Promise<void>,
): Promise<void> {
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanDocuments(query, limit, cursor, context);
    for (const record of page.items) await visit(record);
    cursor = page.next;
  } while (cursor);
}
