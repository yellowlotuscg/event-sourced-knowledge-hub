import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { makeEvent, type AppendResult, type EventStore, type NewDocumentEvent, type StoredEvent, VersionConflictError } from './domain.js';
import { scanBody } from './scanner.js';

export interface DynamoEventStoreOptions {
  tableName: string;
  bodyBucket: string;
  bodyPrefix?: string;
  inlineBodyLimit?: number;
  dynamo?: DynamoDBDocumentClient;
  s3?: S3Client;
}

export class DynamoEventStore implements EventStore {
  private readonly dynamo: DynamoDBDocumentClient;
  private readonly s3: S3Client;
  private readonly inlineBodyLimit: number;
  private readonly bodyPrefix: string;
  constructor(private readonly options: DynamoEventStoreOptions) {
    this.dynamo = options.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
    this.s3 = options.s3 ?? new S3Client({});
    this.inlineBodyLimit = options.inlineBodyLimit ?? 32_000;
    this.bodyPrefix = options.bodyPrefix ?? 'bodies';
  }

  async getLatestVersion(streamId: string): Promise<number> {
    const result = await this.dynamo.send(new QueryCommand({
      TableName: this.options.tableName,
      KeyConditionExpression: 'streamId = :streamId',
      ExpressionAttributeValues: { ':streamId': streamId },
      Select: 'COUNT',
    }));
    return result.Count ?? 0;
  }

  async append(input: NewDocumentEvent, expectedVersion: number): Promise<AppendResult> {
    const actualVersion = await this.getLatestVersion(input.streamId);
    if (actualVersion !== expectedVersion) throw new VersionConflictError(input.streamId, expectedVersion, actualVersion);
    const finding = scanBody(input.body);
    if (finding) throw new Error(`SCANNER:${finding.ruleId}`);
    const event = makeEvent(input, expectedVersion + 1);
    const item: StoredEvent = { ...event };
    if (input.body.length > this.inlineBodyLimit) {
      const key = `${this.bodyPrefix}/${event.streamId}/${event.version}-${event.bodyHash}-${randomUUID()}`;
      await this.s3.send(new PutObjectCommand({ Bucket: this.options.bodyBucket, Key: key, Body: input.body, ContentType: 'text/plain', IfNoneMatch: '*' }));
      delete item.body;
      item.bodyS3Key = key;
    }
    try {
      await this.dynamo.send(new PutCommand({
        TableName: this.options.tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(streamId) AND attribute_not_exists(version)',
      }));
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        throw new VersionConflictError(input.streamId, expectedVersion, await this.getLatestVersion(input.streamId));
      }
      throw error;
    }
    return { event: item, version: item.version };
  }

  private async materialize(event: StoredEvent): Promise<StoredEvent> {
    if (!event.body && event.bodyS3Key) {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.options.bodyBucket, Key: event.bodyS3Key }));
      if (!object.Body) throw new Error(`Missing body object ${event.bodyS3Key}`);
      const body = await object.Body.transformToString();
      return { ...event, body };
    }
    return event;
  }

  async getEvents(streamId: string): Promise<StoredEvent[]> {
    const result = await this.dynamo.send(new QueryCommand({
      TableName: this.options.tableName,
      KeyConditionExpression: 'streamId = :streamId',
      ExpressionAttributeValues: { ':streamId': streamId },
      ScanIndexForward: true,
    }));
    return Promise.all((result.Items ?? []).map((item) => this.materialize(item as StoredEvent)));
  }

  async getAllEvents(): Promise<StoredEvent[]> {
    throw new Error('DynamoEventStore.getAllEvents requires a dedicated export/replay scan in production');
  }
}
