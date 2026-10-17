import type { StoredEvent } from './domain.js';

export interface LatestDocument {
  id: string;
  author: string;
  body: string;
  bodyHash: string;
  version: number;
  status: 'active' | 'retracted';
  updatedAt: string;
  lastEventId: string;
}

export interface AuthorDocumentSummary {
  id: string;
  author: string;
  version: number;
  status: LatestDocument['status'];
  updatedAt: string;
  bodyHash: string;
}

export function reduceDocument(events: readonly StoredEvent[]): LatestDocument | undefined {
  let state: LatestDocument | undefined;
  for (const event of [...events].sort((a, b) => a.version - b.version)) {
    if (!event.body) throw new Error(`Event ${event.eventId} has no body`);
    if (event.type === 'DocumentCreated') {
      state = {
        id: event.streamId,
        author: event.author,
        body: event.body,
        bodyHash: event.bodyHash,
        version: event.version,
        status: 'active',
        updatedAt: event.timestamp,
        lastEventId: event.eventId,
      };
    } else if (event.type === 'DocumentRevised' && state) {
      state = { ...state, author: event.author, body: event.body, bodyHash: event.bodyHash, version: event.version, status: 'active', updatedAt: event.timestamp, lastEventId: event.eventId };
    } else if (event.type === 'DocumentRetracted' && state) {
      state = { ...state, author: event.author, body: event.body, bodyHash: event.bodyHash, version: event.version, status: 'retracted', updatedAt: event.timestamp, lastEventId: event.eventId };
    }
  }
  return state;
}

export function reduceAuthorDocuments(events: readonly StoredEvent[], author: string): AuthorDocumentSummary[] {
  const byDocument = new Map<string, StoredEvent[]>();
  for (const event of events.filter((item) => item.author === author)) {
    const existing = byDocument.get(event.streamId) ?? [];
    existing.push(event);
    byDocument.set(event.streamId, existing);
  }
  return [...byDocument.values()]
    .map((items) => reduceDocument(items))
    .filter((item): item is LatestDocument => item !== undefined)
    .map(({ id, author: documentAuthor, version, status, updatedAt, bodyHash }) => ({ id, author: documentAuthor, version, status, updatedAt, bodyHash }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
