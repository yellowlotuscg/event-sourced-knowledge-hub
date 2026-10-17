import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eventBody, makeEvent, type AppendResult, type EventStore, type NewDocumentEvent, type StoredEvent, VersionConflictError } from './domain.js';
import { scanBody } from './scanner.js';

export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, StoredEvent[]>();

  async append(input: NewDocumentEvent, expectedVersion: number): Promise<AppendResult> {
    const current = this.events.get(input.streamId) ?? [];
    if (current.length !== expectedVersion) throw new VersionConflictError(input.streamId, expectedVersion, current.length);
    const finding = scanBody(input.body);
    if (finding) throw new Error(`SCANNER:${finding.ruleId}`);
    const event = makeEvent(input, expectedVersion + 1);
    const next = [...current, event];
    this.events.set(input.streamId, next);
    return { event, version: event.version };
  }

  async getEvents(streamId: string): Promise<StoredEvent[]> {
    return (this.events.get(streamId) ?? []).map((event) => ({ ...event }));
  }

  async getAllEvents(): Promise<StoredEvent[]> {
    return [...this.events.values()].flat().sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.streamId.localeCompare(b.streamId) || a.version - b.version).map((event) => ({ ...event }));
  }

  async getLatestVersion(streamId: string): Promise<number> {
    return (this.events.get(streamId) ?? []).length;
  }
}

export class JsonlEventStore implements EventStore {
  constructor(private readonly filePath: string) {}

  private async read(): Promise<StoredEvent[]> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as StoredEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async append(input: NewDocumentEvent, expectedVersion: number): Promise<AppendResult> {
    const all = await this.read();
    const current = all.filter((event) => event.streamId === input.streamId);
    if (current.length !== expectedVersion) throw new VersionConflictError(input.streamId, expectedVersion, current.length);
    const finding = scanBody(input.body);
    if (finding) throw new Error(`SCANNER:${finding.ruleId}`);
    const event = makeEvent(input, expectedVersion + 1);
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
    return { event, version: event.version };
  }

  async getEvents(streamId: string): Promise<StoredEvent[]> {
    return (await this.read()).filter((event) => event.streamId === streamId).sort((a, b) => a.version - b.version);
  }

  async getAllEvents(): Promise<StoredEvent[]> {
    return (await this.read()).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.streamId.localeCompare(b.streamId) || a.version - b.version);
  }

  async getLatestVersion(streamId: string): Promise<number> {
    return (await this.getEvents(streamId)).length;
  }
}

export { eventBody };
