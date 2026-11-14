import type { MediaStorage } from "./storage";

type StoredObject = { body: Uint8Array; contentType: string };
type StorageCall = { op: "put" | "get" | "delete"; key: string };

/** Process-local storage for development and tests. Records every call it receives. */
export class MemoryMediaStorage implements MediaStorage {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: StorageCall[] = [];

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.calls.push({ op: "put", key });
    this.objects.set(key, { body: body.slice(), contentType });
  }

  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    this.calls.push({ op: "get", key });
    const stored = this.objects.get(key);
    if (!stored) return null;
    const body = stored.body.slice();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  }

  async delete(key: string): Promise<void> {
    this.calls.push({ op: "delete", key });
    this.objects.delete(key);
  }

  reset(): void {
    this.objects.clear();
    this.calls.length = 0;
  }
}
