import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { URL } from 'node:url';
import { DynamoEventStore } from '../dynamo-store.js';
import { DynamoProjectionStore } from '../projections.js';
import { reduceDocument } from '../reducer.js';
import { scanBody } from '../scanner.js';
import { VersionConflictError, type NewDocumentEvent } from '../domain.js';

interface HttpApiEvent {
  rawPath?: string;
  rawQueryString?: string;
  requestContext?: { http?: { method?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const store = new DynamoEventStore({
  tableName: process.env.EVENTS_TABLE ?? 'knowledge-events',
  bodyBucket: process.env.BODY_BUCKET ?? 'knowledge-bodies',
  dynamo: documentClient,
  s3: new S3Client({}),
});
const projections = new DynamoProjectionStore(
  process.env.LATEST_PROJECTION_TABLE ?? 'knowledge-latest',
  process.env.AUTHOR_PROJECTION_TABLE ?? 'knowledge-by-author',
  documentClient,
);

function response(statusCode: number, payload: unknown) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

export async function handler(event: HttpApiEvent) {
  try {
    const method = event.requestContext?.http?.method ?? 'GET';
    const url = new URL(`${event.rawPath ?? '/'}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`, 'http://lambda');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'POST' && parts[0] === 'streams' && parts[2] === 'events') {
      const rawText = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '{}';
      const raw = JSON.parse(rawText) as Partial<NewDocumentEvent> & { expectedVersion?: unknown };
      if (typeof raw.expectedVersion !== 'number' || !Number.isInteger(raw.expectedVersion) || raw.expectedVersion < 0) return response(400, { error: 'expectedVersion is required and must be a non-negative integer' });
      const input: NewDocumentEvent = { eventId: raw.eventId, type: raw.type as NewDocumentEvent['type'], streamId: parts[1], author: raw.author as string, timestamp: raw.timestamp as string, body: raw.body as string };
      const finding = scanBody(input.body ?? '');
      if (finding) return response(422, { error: 'event rejected by ingest scanner', ruleId: finding.ruleId });
      return response(201, (await store.append(input, raw.expectedVersion)).event);
    }
    if (method === 'GET' && parts[0] === 'streams' && parts[2] === 'events') return response(200, await store.getEvents(parts[1]));
    if (method === 'GET' && parts[0] === 'documents' && parts.length === 2) {
      const asOf = url.searchParams.get('asOf');
      if (asOf) {
        if (Number.isNaN(Date.parse(asOf))) return response(400, { error: 'asOf must be ISO-8601' });
        const result = reduceDocument((await store.getEvents(parts[1])).filter((item) => item.timestamp <= new Date(asOf).toISOString()));
        return result ? response(200, result) : response(404, { error: 'document not found' });
      }
      const result = await projections.getLatest(parts[1]);
      return result ? response(200, result) : response(404, { error: 'document not found' });
    }
    if (method === 'GET' && parts[0] === 'authors' && parts[2] === 'documents') return response(200, await projections.getAuthorDocuments(parts[1]));
    return response(404, { error: 'not found' });
  } catch (error) {
    if (error instanceof VersionConflictError) return response(409, { error: error.message, expectedVersion: error.expectedVersion, actualVersion: error.actualVersion });
    if (error instanceof Error && error.message.startsWith('SCANNER:')) return response(422, { error: 'event rejected by ingest scanner', ruleId: error.message.slice('SCANNER:'.length) });
    return response(400, { error: error instanceof Error ? error.message : 'request failed' });
  }
}
