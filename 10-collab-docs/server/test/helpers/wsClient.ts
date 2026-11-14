import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  decodeFrame,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  type Frame,
} from '../../src/ws/codec.js';
import { TEST_ORIGIN } from './env.js';

export interface ConnectOptions {
  token?: string;
  link?: string;
  /** Origin header; null sends none. */
  origin?: string | null;
  /** Send local edits and answer the server's SyncStep1 when the role allows editing. */
  autoSend?: boolean;
  doc?: Y.Doc;
}

export interface Closed {
  code: number;
  reason: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Control = { type: string; [key: string]: any };

const REMOTE = Symbol('remote');

function socketUrl(baseUrl: string, docId: string, link?: string): string {
  return `${baseUrl}/ws/docs/${docId}${link ? `?link=${encodeURIComponent(link)}` : ''}`;
}

function socketOptions(options: ConnectOptions): WebSocket.ClientOptions {
  const headers: Record<string, string> = {};
  if (options.token) headers.cookie = `cd_session=${options.token}`;
  const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
  return origin === null ? { headers } : { headers, origin };
}

/** A protocol-level WebSocket client with its own Y.Doc, for driving the server in tests. */
export class TestClient {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly socket: WebSocket;
  readonly frames: Frame[] = [];
  readonly controls: Control[] = [];
  readonly closed: Promise<Closed>;
  role: string | null = null;
  autoSend: boolean;
  private pending: Uint8Array[] = [];
  private readonly waiters = new Set<() => void>();
  private closeInfo: Closed | null = null;

  private constructor(socket: WebSocket, options: ConnectOptions) {
    this.socket = socket;
    this.doc = options.doc ?? new Y.Doc();
    this.text = this.doc.getText('content');
    this.autoSend = options.autoSend ?? true;
    this.closed = new Promise((resolve) => {
      socket.on('close', (code: number, reason: Buffer) => {
        this.closeInfo = { code, reason: reason.toString() };
        resolve(this.closeInfo);
        this.notify();
      });
    });
    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      this.receive(new Uint8Array(data as Buffer));
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      if (this.autoSend && this.canEdit() && this.isOpen()) this.socket.send(encodeSyncUpdate(update));
      else this.pending.push(update);
    });
  }

  /** Opens a connection and resolves once the socket is open. */
  static connect(baseUrl: string, docId: string, options: ConnectOptions = {}): Promise<TestClient> {
    const socket = new WebSocket(socketUrl(baseUrl, docId, options.link), socketOptions(options));
    const client = new TestClient(socket, options);
    return new Promise((resolve, reject) => {
      socket.once('open', () => {
        socket.send(encodeSyncStep1(Y.encodeStateVector(client.doc)));
        resolve(client);
      });
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        reject(new Error(`upgrade refused with ${response.statusCode}`));
      });
      socket.once('error', reject);
    });
  }

  /** Connects and waits for the hello and the initial sync exchange. */
  static async join(baseUrl: string, docId: string, options: ConnectOptions = {}): Promise<TestClient> {
    const client = await TestClient.connect(baseUrl, docId, options);
    await client.waitForControl('hello');
    await client.waitFor(() => client.frames.some((frame) => frame.type === 'sync-step2'));
    if (client.canEdit()) {
      await client.waitFor(() => client.frames.some((frame) => frame.type === 'sync-step1'));
    }
    return client;
  }

  /** Attempts an upgrade that is expected to fail and resolves with the HTTP status. */
  static refusedStatus(baseUrl: string, docId: string, options: ConnectOptions = {}): Promise<number> {
    const socket = new WebSocket(socketUrl(baseUrl, docId, options.link), socketOptions(options));
    return new Promise((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
        socket.on('error', () => undefined);
      });
      socket.once('open', () => {
        socket.close();
        reject(new Error('upgrade unexpectedly accepted'));
      });
      socket.on('error', () => undefined);
    });
  }

  get hello(): Control | undefined {
    return this.controls.find((control) => control.type === 'hello');
  }

  get closeCode(): number | null {
    return this.closeInfo?.code ?? null;
  }

  isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  canEdit(): boolean {
    return this.role === 'editor' || this.role === 'owner';
  }

  /** Resolves when the predicate holds after some received frame. */
  waitFor(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (!predicate()) return;
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }

  waitForText(expected: string): Promise<void> {
    return this.waitFor(() => this.text.toString() === expected);
  }

  async waitForControl(type: string, after = 0): Promise<Control> {
    await this.waitFor(() => this.controls.slice(after).some((control) => control.type === type));
    return this.controls.slice(after).find((control) => control.type === type)!;
  }

  /** Inserts text locally; it is sent when the client is allowed to edit. */
  type(index: number, value: string): void {
    this.text.insert(index, value);
  }

  /** Appends text locally. */
  append(value: string): void {
    this.type(this.text.length, value);
  }

  /** Sends the locally held updates as one Update frame. */
  flush(): void {
    if (this.pending.length === 0) return;
    const merged = Y.mergeUpdates(this.pending);
    this.pending = [];
    this.socket.send(encodeSyncUpdate(merged));
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  sendRaw(data: Uint8Array | string, binary = true): void {
    this.socket.send(data, { binary });
  }

  close(): Promise<Closed> {
    if (this.isOpen()) this.socket.close(1000);
    return this.closed;
  }

  /** Drops the TCP connection without a close frame. */
  terminate(): Promise<Closed> {
    this.socket.terminate();
    return this.closed;
  }

  private receive(data: Uint8Array): void {
    const frame = decodeFrame(data);
    this.frames.push(frame);
    switch (frame.type) {
      case 'sync-step1':
        if (this.autoSend && this.canEdit()) {
          this.socket.send(encodeSyncStep2(Y.encodeStateAsUpdate(this.doc, frame.stateVector)));
          this.pending = [];
        }
        break;
      case 'sync-step2':
      case 'sync-update':
        Y.applyUpdate(this.doc, frame.update, REMOTE);
        break;
      case 'control': {
        const control = frame.message as Control;
        this.controls.push(control);
        if (control.type === 'hello' || control.type === 'role') this.role = control.role;
        break;
      }
      case 'awareness':
        this.onAwareness(frame.update);
        break;
    }
    this.notify();
  }

  protected onAwareness(_update: Uint8Array): void {}

  protected notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
