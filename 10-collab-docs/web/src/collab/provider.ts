import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { canEdit, type DocRole } from './roles';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_CONTROL = 2;
const NORMAL_CLOSURE = 1000;

/** Close codes after which the provider stops reconnecting, with the message to show. */
export const STOP_MESSAGES: Record<number, string> = {
  4401: 'Your session has ended. Sign in again to keep editing.',
  4403: 'You no longer have access to this document.',
  4404: 'This document was deleted or moved to the trash.',
};

/** The parts of a browser WebSocket the provider uses. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProviderOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  scheduler?: Scheduler;
}

export type ProviderStatus = 'connecting' | 'connected' | 'disconnected' | 'stopped';

interface ProviderEvents {
  status: ProviderStatus;
  role: DocRole | null;
  doc: Y.Doc;
  meta: string;
  comments: null;
  presence: null;
}

const OPEN = 1;

/** Returns the reconnect delay before attempt `attempt` (0-based): min(30 s, 500 ms × 2^n) plus up to 20%. */
export function reconnectDelay(attempt: number, random: () => number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base + base * 0.2 * random();
}

const browserScheduler: Scheduler = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/** Connects a Y.Doc and an Awareness to the document WebSocket and keeps them connected. */
export class CollabProvider {
  doc: Y.Doc;
  awareness: Awareness;
  role: DocRole | null = null;
  userId: string | null = null;
  status: ProviderStatus = 'disconnected';
  stopReason: string | null = null;

  private readonly url: string;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly random: () => number;
  private readonly scheduler: Scheduler;
  private readonly listeners = new Map<keyof ProviderEvents, Set<(value: never) => void>>();
  private socket: SocketLike | null = null;
  private greeted = false;
  private attempt = 0;
  private timer: unknown = null;
  private unsent = false;
  private destroyed = false;
  private detachDoc: () => void = () => undefined;

  constructor(options: ProviderOptions) {
    this.url = options.url;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.random = options.random ?? Math.random;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.attachDoc();
  }

  on<K extends keyof ProviderEvents>(event: K, listener: (value: ProviderEvents[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (value: never) => void);
    this.listeners.set(event, set);
    return () => set.delete(listener as (value: never) => void);
  }

  /** Opens the socket; reconnects on its own until destroyed or stopped. */
  connect(): void {
    if (this.destroyed || this.status === 'stopped') return;
    this.timer = null;
    this.setStatus('connecting');
    const socket = this.createSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.send(encodeSync((encoder) => syncProtocol.writeSyncStep1(encoder, this.doc)));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (event.data instanceof ArrayBuffer) this.receive(new Uint8Array(event.data));
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.onClosed(event.code);
    };
  }

  /** Sets this user's presence state, merged with what is already there. */
  setPresence(fields: Record<string, unknown>): void {
    const current = this.awareness.getLocalState() ?? {};
    this.awareness.setLocalState({ ...current, ...fields });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = null;
    socket?.close(NORMAL_CLOSURE);
    this.detachDoc();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private emit<K extends keyof ProviderEvents>(event: K, value: ProviderEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (v: ProviderEvents[K]) => void)(value);
  }

  private setStatus(status: ProviderStatus): void {
    this.status = status;
    this.emit('status', status);
  }

  private isLive(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN && this.greeted;
  }

  private send(frame: Uint8Array): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(frame);
  }

  private attachDoc(): void {
    const doc = this.doc;
    const awareness = this.awareness;
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      if (this.isLive() && canEdit(this.role)) {
        this.send(encodeSync((encoder) => syncProtocol.writeUpdate(encoder, update)));
      } else {
        this.unsent = true;
      }
    };
    const onAwareness = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      this.emit('presence', null);
      if (origin !== 'local' || !this.isLive() || this.userId === null) return;
      const clients = [...changes.added, ...changes.updated, ...changes.removed];
      this.send(encodeAwarenessFrame(encodeAwarenessUpdate(awareness, clients)));
    };
    doc.on('update', onUpdate);
    awareness.on('update', onAwareness);
    this.detachDoc = () => {
      doc.off('update', onUpdate);
      awareness.off('update', onAwareness);
    };
  }

  private receive(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const step = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (step === syncProtocol.messageYjsSyncStep1 && canEdit(this.role)) {
        this.send(encoding.toUint8Array(encoder));
        this.unsent = false;
      }
    } else if (type === MESSAGE_AWARENESS) {
      applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    } else if (type === MESSAGE_CONTROL) {
      this.control(JSON.parse(decoding.readVarString(decoder)) as Record<string, unknown>);
    }
  }

  private control(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'hello':
        this.greeted = true;
        this.attempt = 0;
        this.userId = (message.userId as string | null) ?? null;
        this.setStatus('connected');
        this.applyRole(message.role as DocRole);
        if (this.userId !== null) {
          const presence = this.awareness.getLocalState();
          // Setting the state again advances its clock.
          if (presence !== null) this.awareness.setLocalState(presence);
        }
        return;
      case 'role':
        this.applyRole(message.role as DocRole);
        return;
      case 'meta':
        this.emit('meta', String(message.title));
        return;
      case 'comments_changed':
        this.emit('comments', null);
        return;
    }
  }

  private applyRole(role: DocRole): void {
    this.role = role;
    this.emit('role', role);
    if (!canEdit(role) && this.unsent) this.rebuild();
  }

  /** Discards local state and loads the document again from the server. */
  private rebuild(): void {
    const presence = this.awareness.getLocalState();
    this.detachDoc();
    this.awareness.destroy();
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    if (presence) this.awareness.setLocalState(presence);
    this.unsent = false;
    this.attachDoc();
    this.emit('doc', this.doc);
    const socket = this.socket;
    this.socket = null;
    this.greeted = false;
    socket?.close(NORMAL_CLOSURE);
    this.connect();
  }

  private onClosed(code: number): void {
    this.socket = null;
    this.greeted = false;
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    removeAwarenessStates(this.awareness, others, this);
    if (this.destroyed) return;
    const stop = STOP_MESSAGES[code];
    if (stop) {
      this.stopReason = stop;
      this.setStatus('stopped');
      return;
    }
    this.setStatus('disconnected');
    const delay = reconnectDelay(this.attempt, this.random);
    this.attempt += 1;
    this.timer = this.scheduler.setTimeout(() => this.connect(), delay);
  }
}

function encodeSync(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function encodeAwarenessFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}
