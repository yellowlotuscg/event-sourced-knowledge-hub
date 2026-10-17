import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { reduceDocument } from './reducer.js';
import { scanBody } from './scanner.js';
import { VersionConflictError, type EventStore, type NewDocumentEvent } from './domain.js';
import type { ProjectionStore } from './projections.js';

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid JSON'); }
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

export function buildApiServer(store: EventStore, projections: ProjectionStore) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (request.method === 'POST' && parts[0] === 'streams' && parts[2] === 'events') {
        const streamId = parts[1];
        const raw = await readJson(request) as Partial<NewDocumentEvent> & { expectedVersion?: unknown };
        if (typeof raw.expectedVersion !== 'number' || !Number.isInteger(raw.expectedVersion) || raw.expectedVersion < 0) {
          return send(response, 400, { error: 'expectedVersion is required and must be a non-negative integer' });
        }
        const input: NewDocumentEvent = {
          eventId: typeof raw.eventId === 'string' ? raw.eventId : undefined,
          type: raw.type as NewDocumentEvent['type'],
          streamId,
          author: raw.author as string,
          timestamp: raw.timestamp as string,
          body: raw.body as string,
        };
        const finding = scanBody(input.body ?? '');
        if (finding) return send(response, 422, { error: 'event rejected by ingest scanner', ruleId: finding.ruleId });
        const result = await store.append(input, raw.expectedVersion);
        await projections.apply(result.event);
        return send(response, 201, result.event);
      }
      if (request.method === 'GET' && parts[0] === 'streams' && parts[2] === 'events') {
        return send(response, 200, await store.getEvents(parts[1]));
      }
      if (request.method === 'GET' && parts[0] === 'documents' && parts.length === 2) {
        const events = await store.getEvents(parts[1]);
        const asOf = url.searchParams.get('asOf');
        if (asOf && Number.isNaN(Date.parse(asOf))) return send(response, 400, { error: 'asOf must be ISO-8601' });
        const filtered = asOf ? events.filter((event) => event.timestamp <= new Date(asOf).toISOString()) : events;
        const result = reduceDocument(filtered);
        return result ? send(response, 200, result) : send(response, 404, { error: 'document not found' });
      }
      if (request.method === 'GET' && parts[0] === 'authors' && parts[2] === 'documents') {
        return send(response, 200, await projections.getAuthorDocuments(parts[1]));
      }
      return send(response, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof VersionConflictError) return send(response, 409, { error: error.message, expectedVersion: error.expectedVersion, actualVersion: error.actualVersion });
      if (error instanceof Error && error.message.startsWith('SCANNER:')) return send(response, 422, { error: 'event rejected by ingest scanner', ruleId: error.message.slice('SCANNER:'.length) });
      return send(response, 400, { error: error instanceof Error ? error.message : 'request failed' });
    }
  });
}
