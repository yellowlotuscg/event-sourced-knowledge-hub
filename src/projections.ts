import { reduceAuthorDocuments, reduceDocument, type AuthorDocumentSummary, type LatestDocument } from './reducer.js';
import type { StoredEvent } from './domain.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export interface ProjectionStore {
  getLatest(documentId: string): Promise<LatestDocument | undefined>;
  getAuthorDocuments(author: string): Promise<AuthorDocumentSummary[]>;
  rebuild(events: StoredEvent[]): Promise<void>;
  apply(event: StoredEvent): Promise<void>;
  snapshot(): Promise<{ latest: Record<string, LatestDocument>; authors: Record<string, AuthorDocumentSummary[]> }>;
}

export class InMemoryProjectionStore implements ProjectionStore {
  private events = new Map<string, StoredEvent[]>();
  private seen = new Set<string>();

  async apply(event: StoredEvent): Promise<void> {
    if (this.seen.has(event.eventId)) return;
    const current = this.events.get(event.streamId) ?? [];
    if (current.some((item) => item.version === event.version)) return;
    this.events.set(event.streamId, [...current, event].sort((a, b) => a.version - b.version));
    this.seen.add(event.eventId);
  }

  async rebuild(events: StoredEvent[]): Promise<void> {
    this.events = new Map();
    this.seen = new Set();
    for (const event of events) await this.apply(event);
  }

  private all(): StoredEvent[] { return [...this.events.values()].flat(); }

  async getLatest(documentId: string): Promise<LatestDocument | undefined> {
    return reduceDocument(this.events.get(documentId) ?? []);
  }

  async getAuthorDocuments(author: string): Promise<AuthorDocumentSummary[]> {
    return reduceAuthorDocuments(this.all(), author);
  }

  async snapshot(): Promise<{ latest: Record<string, LatestDocument>; authors: Record<string, AuthorDocumentSummary[]> }> {
    const latest: Record<string, LatestDocument> = {};
    for (const [id, events] of this.events) {
      const document = reduceDocument(events);
      if (document) latest[id] = document;
    }
    const authors: Record<string, AuthorDocumentSummary[]> = {};
    for (const event of this.all()) authors[event.author] = await this.getAuthorDocuments(event.author);
    return { latest, authors };
  }
}

export class DynamoProjectionStore implements ProjectionStore {
  private readonly dynamo: DynamoDBDocumentClient;

  constructor(
    private readonly latestTable: string,
    private readonly authorTable: string,
    dynamo?: DynamoDBDocumentClient,
  ) {
    this.dynamo = dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async getLatest(documentId: string): Promise<LatestDocument | undefined> {
    const result = await this.dynamo.send(new GetCommand({ TableName: this.latestTable, Key: { id: documentId } }));
    return result.Item as LatestDocument | undefined;
  }

  async getAuthorDocuments(author: string): Promise<AuthorDocumentSummary[]> {
    const result = await this.dynamo.send(new QueryCommand({
      TableName: this.authorTable,
      KeyConditionExpression: 'author = :author',
      ExpressionAttributeValues: { ':author': author },
    }));
    return (result.Items ?? []) as AuthorDocumentSummary[];
  }

  async apply(): Promise<void> { throw new Error('DynamoProjectionStore is read-only; the projector owns writes'); }
  async rebuild(): Promise<void> { throw new Error('DynamoProjectionStore is read-only; the projector owns writes'); }
  async snapshot(): Promise<{ latest: Record<string, LatestDocument>; authors: Record<string, AuthorDocumentSummary[]> }> { throw new Error('DynamoProjectionStore does not support snapshots'); }
}
