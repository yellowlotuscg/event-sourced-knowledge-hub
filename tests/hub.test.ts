import { describe, expect, it } from 'vitest';
import { buildApiServer } from '../src/api.js';
import { InMemoryEventStore } from '../src/stores.js';
import { InMemoryProjectionStore } from '../src/projections.js';
import { reduceDocument } from '../src/reducer.js';
import { scanBody } from '../src/scanner.js';
import { sha256Text, stableJson } from '../src/stable.js';

const event = (type: 'DocumentCreated' | 'DocumentRevised' | 'DocumentRetracted', version: number, timestamp: string, body: string) => ({
  eventId: `test-${version}`,
  type,
  streamId: 'doc-1',
  version,
  author: version === 1 ? 'author-a' : 'author-b',
  timestamp,
  bodyHash: sha256Text(body),
  body,
});

describe('event store and concurrency', () => {
  it('allows one writer and rejects the competing expected version', async () => {
    const store = new InMemoryEventStore();
    const input = { type: 'DocumentCreated' as const, streamId: 'doc-1', author: 'author-a', timestamp: '2026-01-01T00:00:00Z', body: 'Synthetic content.' };
    const results = await Promise.allSettled([store.append(input, 0), store.append({ ...input, eventId: 'writer-two' }, 0)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await store.getEvents('doc-1')).length).toBe(1);
  });

  it('has no overwrite or delete path and rejects a duplicate version', async () => {
    const store = new InMemoryEventStore();
    await store.append({ type: 'DocumentCreated', streamId: 'doc-1', author: 'author-a', timestamp: '2026-01-01T00:00:00Z', body: 'Original.' }, 0);
    await expect(store.append({ type: 'DocumentRevised', streamId: 'doc-1', author: 'author-a', timestamp: '2026-01-02T00:00:00Z', body: 'Replacement.' }, 0)).rejects.toThrow();
    expect('overwrite' in store).toBe(false);
    expect('delete' in store).toBe(false);
    expect((await store.getEvents('doc-1'))[0].body).toBe('Original.');
  });
});

describe('scanner', () => {
  it('rejects all configured fixture families without storing literals', () => {
    const accessKey = ['AK', 'IA', ['0','1','2','3','4','5','6','7','8','9','A','B','C','D','E','F'].join('')].join('');
    const privateBlock = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const bearer = ['Bearer ', 'x'.repeat(28)].join('');
    const connection = ['postgres', '://user:pass@fictional.example/db'].join('');
    const generic = ['api-key=', 'x'.repeat(28)].join('');
    expect(scanBody(accessKey)?.ruleId).toBe('aws-access-key-id');
    expect(scanBody(privateBlock)?.ruleId).toBe('private-key-block');
    expect(scanBody(bearer)?.ruleId).toBe('bearer-token');
    expect(scanBody(connection)?.ruleId).toBe('connection-string');
    expect(scanBody(generic)?.ruleId).toBe('generic-high-entropy-token');
    expect(scanBody('Synthetic Northwind Widgets instructions.')).toBeUndefined();
  });
});

describe('reducer and API', () => {
  it('reduces revisions and retractions', () => {
    const active = reduceDocument([event('DocumentCreated', 1, '2026-01-01T00:00:00Z', 'first'), event('DocumentRevised', 2, '2026-01-02T00:00:00Z', 'second')]);
    expect(active?.body).toBe('second');
    expect(active?.status).toBe('active');
    const retracted = reduceDocument([event('DocumentCreated', 1, '2026-01-01T00:00:00Z', 'first'), event('DocumentRetracted', 2, '2026-01-03T00:00:00Z', 'retracted')]);
    expect(retracted?.status).toBe('retracted');
  });

  it('serves time travel and conflict responses', async () => {
    const store = new InMemoryEventStore();
    const projections = new InMemoryProjectionStore();
    const server = buildApiServer(store, projections);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${base}/streams/doc-api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 0, type: 'DocumentCreated', author: 'author-a', timestamp: '2026-01-01T00:00:00Z', body: 'before' }) });
    expect(created.status).toBe(201);
    const revised = await fetch(`${base}/streams/doc-api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, type: 'DocumentRevised', author: 'author-a', timestamp: '2026-01-02T00:00:00Z', body: 'after' }) });
    expect(revised.status).toBe(201);
    const conflict = await fetch(`${base}/streams/doc-api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, type: 'DocumentRevised', author: 'author-a', timestamp: '2026-01-03T00:00:00Z', body: 'loser' }) });
    expect(conflict.status).toBe(409);
    const historical = await (await fetch(`${base}/documents/doc-api?asOf=2026-01-01T12:00:00Z`)).json() as { body: string };
    expect(historical.body).toBe('before');
    const latest = await (await fetch(`${base}/documents/doc-api`)).json() as { body: string };
    expect(latest.body).toBe('after');
    server.close();
  });

  it('keeps replay serialization deterministic', async () => {
    const projections = new InMemoryProjectionStore();
    await projections.rebuild([event('DocumentCreated', 1, '2026-01-01T00:00:00Z', 'first'), event('DocumentRevised', 2, '2026-01-02T00:00:00Z', 'second')]);
    const first = stableJson(await projections.snapshot());
    const second = stableJson(await projections.snapshot());
    expect(first).toBe(second);
    expect(sha256Text(first)).toBe(sha256Text(second));
  });
});
