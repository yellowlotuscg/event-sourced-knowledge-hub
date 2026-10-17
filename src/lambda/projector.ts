import { unmarshall } from '@aws-sdk/util-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { reduceDocument } from '../reducer.js';
import type { StoredEvent } from '../domain.js';

type StreamRecord = { dynamodb?: { NewImage?: Record<string, unknown> } };
export type DynamoStreamEvent = { Records?: StreamRecord[] };

interface ProjectorConfig {
  latestTable: string;
  authorTable: string;
  bodyBucket: string;
}

const config: ProjectorConfig = {
  latestTable: process.env.LATEST_PROJECTION_TABLE ?? 'knowledge-latest',
  authorTable: process.env.AUTHOR_PROJECTION_TABLE ?? 'knowledge-by-author',
  bodyBucket: process.env.BODY_BUCKET ?? 'knowledge-bodies',
};
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

async function materialize(event: StoredEvent): Promise<StoredEvent> {
  if (!event.body && event.bodyS3Key) {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.bodyBucket, Key: event.bodyS3Key }));
    if (!object.Body) throw new Error(`Missing body object ${event.bodyS3Key}`);
    return { ...event, body: await object.Body.transformToString() };
  }
  return event;
}

export async function handler(event: DynamoStreamEvent): Promise<void> {
  for (const record of event.Records ?? []) {
    if (!record.dynamodb?.NewImage) continue;
    const stored = unmarshall(record.dynamodb.NewImage as Record<string, any>) as unknown as StoredEvent;
    const item = await materialize(stored);
    if (!item.body) continue;
    const current = {
      id: item.streamId,
      author: item.author,
      body: item.body,
      bodyHash: item.bodyHash,
      version: item.version,
      status: item.type === 'DocumentRetracted' ? 'retracted' as const : 'active' as const,
      updatedAt: item.timestamp,
      lastEventId: item.eventId,
    };
    await dynamo.send(new PutCommand({
      TableName: config.latestTable,
      Item: current,
      ConditionExpression: 'attribute_not_exists(id) OR version < :version',
      ExpressionAttributeValues: { ':version': current.version },
    })).catch((error: unknown) => {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
    });
    await dynamo.send(new PutCommand({
      TableName: config.authorTable,
      Item: { documentId: current.id, ...current },
      ConditionExpression: 'attribute_not_exists(documentId) OR version < :version',
      ExpressionAttributeValues: { ':version': current.version },
    })).catch((error: unknown) => {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
    });
  }
}
