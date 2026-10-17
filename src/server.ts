import { JsonlEventStore } from './stores.js';
import { InMemoryProjectionStore } from './projections.js';
import { buildApiServer } from './api.js';

const store = new JsonlEventStore(process.env.EVENT_LOG ?? 'data/events.jsonl');
const projections = new InMemoryProjectionStore();
await projections.rebuild(await store.getAllEvents());
const server = buildApiServer(store, projections);
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => console.log(`knowledge hub listening on http://localhost:${port}`));

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
