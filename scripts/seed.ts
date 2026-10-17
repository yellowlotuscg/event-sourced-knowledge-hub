import { mkdir, rm, writeFile } from 'node:fs/promises';
import { InMemoryProjectionStore } from '../src/projections.js';
import { JsonlEventStore } from '../src/stores.js';
import { stableJson } from '../src/stable.js';

const eventsPath = process.env.EVENT_LOG ?? 'data/events.jsonl';
const projectionsPath = process.env.PROJECTIONS_FILE ?? 'data/live-projections.json';
await mkdir('data', { recursive: true });
await rm(eventsPath, { force: true });
const store = new JsonlEventStore(eventsPath);
const seedEvents = [
  { eventId: 'seed-001', type: 'DocumentCreated' as const, streamId: 'runbook-assembly', author: 'author-a', timestamp: '2026-01-01T09:00:00.000Z', body: 'Synthetic runbook: assembly checks for Northwind Widgets.' },
  { eventId: 'seed-002', type: 'DocumentRevised' as const, streamId: 'runbook-assembly', author: 'author-b', timestamp: '2026-01-02T09:00:00.000Z', body: 'Synthetic runbook revision: assembly checks with fictional steps.' },
  { eventId: 'seed-003', type: 'DocumentCreated' as const, streamId: 'howto-labels', author: 'author-a', timestamp: '2026-01-01T10:00:00.000Z', body: 'Synthetic how-to: label a Northwind Widgets sample package.' },
  { eventId: 'seed-004', type: 'DocumentRetracted' as const, streamId: 'howto-labels', author: 'author-a', timestamp: '2026-01-03T09:00:00.000Z', body: 'Synthetic retraction notice for a fictional Northwind Widgets document.' },
];
for (const event of seedEvents) {
  await store.append(event, await store.getLatestVersion(event.streamId));
}
const projections = new InMemoryProjectionStore();
await projections.rebuild(await store.getAllEvents());
const serialized = `${stableJson(await projections.snapshot())}\n`;
await writeFile(projectionsPath, serialized, 'utf8');
console.log(`seeded ${seedEvents.length} events into ${eventsPath}`);
console.log(`wrote live projection snapshot to ${projectionsPath}`);
