import { createHash, randomUUID } from 'node:crypto';

export type EventType = 'DocumentCreated' | 'DocumentRevised' | 'DocumentRetracted';

export interface StoredEvent {
  eventId: string;
  type: EventType;
  streamId: string;
  version: number;
  author: string;
  timestamp: string;
  bodyHash: string;
  body?: string;
  bodyS3Key?: string;
}

export type NewDocumentEvent = Omit<StoredEvent, 'eventId' | 'version' | 'bodyHash' | 'bodyS3Key'> & {
  eventId?: string;
  body: string;
};

export interface AppendResult {
  event: StoredEvent;
  version: number;
}

export class VersionConflictError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(`Expected version ${expectedVersion} for ${streamId}, found ${actualVersion}`);
    this.name = 'VersionConflictError';
  }
}

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

export function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function makeEvent(input: NewDocumentEvent, version: number): StoredEvent {
  if (!input.streamId || !input.author || !input.timestamp || !input.body) {
    throw new InvalidEventError('streamId, author, timestamp, and body are required');
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new InvalidEventError('version must be a positive integer');
  }
  if (input.type === 'DocumentCreated' && version !== 1) {
    throw new InvalidEventError('DocumentCreated must be version 1');
  }
  if (input.type !== 'DocumentCreated' && version === 1) {
    throw new InvalidEventError('revisions and retractions require an existing document');
  }
  const parsed = Date.parse(input.timestamp);
  if (Number.isNaN(parsed)) {
    throw new InvalidEventError('timestamp must be ISO-8601');
  }
  return {
    eventId: input.eventId ?? randomUUID(),
    type: input.type,
    streamId: input.streamId,
    version,
    author: input.author,
    timestamp: new Date(parsed).toISOString(),
    bodyHash: hashBody(input.body),
    body: input.body,
  };
}

export function eventBody(event: StoredEvent): string {
  if (event.body === undefined) {
    throw new Error(`Body ${event.bodyHash} is not materialized for ${event.eventId}`);
  }
  return event.body;
}

export interface EventStore {
  append(input: NewDocumentEvent, expectedVersion: number): Promise<AppendResult>;
  getEvents(streamId: string): Promise<StoredEvent[]>;
  getAllEvents(): Promise<StoredEvent[]>;
  getLatestVersion(streamId: string): Promise<number>;
}
