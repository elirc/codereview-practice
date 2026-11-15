import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { diffText } from '../src/collab/diff';
import type { Scheduler } from '../src/collab/provider';
import { bindTextarea, type TextAreaLike } from '../src/collab/textareaBinding';

class FakeTextarea implements TextAreaLike {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  private listener: (() => void) | null = null;

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  addEventListener(_type: 'input', listener: () => void): void {
    this.listener = listener;
  }

  removeEventListener(): void {
    this.listener = null;
  }

  /** Simulates the user producing a new value with the caret at `caret`. */
  typeValue(value: string, caret = value.length): void {
    this.value = value;
    this.setSelectionRange(caret, caret);
    this.listener?.();
  }
}

class ManualScheduler implements Scheduler {
  private pending: Array<() => void> = [];

  setTimeout(callback: () => void): unknown {
    this.pending.push(callback);
    return this.pending.length;
  }

  clearTimeout(): void {
    this.pending = [];
  }

  runAll(): void {
    const due = this.pending;
    this.pending = [];
    for (const callback of due) callback();
  }
}

function pair() {
  const local = new Y.Doc();
  const remote = new Y.Doc();
  local.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(remote, update, 'remote');
  });
  remote.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(local, update, 'remote');
  });
  return { local, remote };
}

describe('diffText', () => {
  it('keeps surrogate pairs whole', () => {
    expect(diffText('a😀b', 'a😃b')).toEqual({ index: 1, deleteCount: 2, insert: '😃' });
  });
});

describe('bindTextarea', () => {
  it('turns an input event into one delete and insert', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'hello world');
    const textarea = new FakeTextarea();
    bindTextarea(text, textarea);
    expect(textarea.value).toBe('hello world');

    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    textarea.typeValue('hello brave new world');
    expect(text.toString()).toBe('hello brave new world');
    expect(updates).toHaveLength(1);

    textarea.typeValue('hello world');
    expect(text.toString()).toBe('hello world');
    expect(updates).toHaveLength(2);
  });

  it('shows remote changes and keeps the caret on the same characters', () => {
    const { local, remote } = pair();
    remote.getText('content').insert(0, 'hello world');
    const textarea = new FakeTextarea();
    bindTextarea(local.getText('content'), textarea);
    textarea.setSelectionRange(6, 11);

    remote.getText('content').insert(0, '>> ');
    expect(textarea.value).toBe('>> hello world');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([9, 14]);

    remote.getText('content').insert(14, '!');
    expect(textarea.value).toBe('>> hello world!');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([9, 14]);
  });

  it('moves the caret back when text before it is deleted remotely', () => {
    const { local, remote } = pair();
    remote.getText('content').insert(0, 'abcdef');
    const textarea = new FakeTextarea();
    bindTextarea(local.getText('content'), textarea);
    textarea.setSelectionRange(4, 4);
    remote.getText('content').delete(0, 2);
    expect(textarea.value).toBe('cdef');
    expect(textarea.selectionStart).toBe(2);
  });

  it('turns input events within the batch window into one update', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    const textarea = new FakeTextarea();
    const scheduler = new ManualScheduler();
    bindTextarea(text, textarea, { batchMs: 40, scheduler });
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));

    textarea.typeValue('h');
    textarea.typeValue('he');
    textarea.typeValue('hey');
    expect(text.toString()).toBe('');
    scheduler.runAll();
    expect(text.toString()).toBe('hey');
    expect(updates).toHaveLength(1);
  });

  it('applies pending input when unbinding', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    const textarea = new FakeTextarea();
    const unbind = bindTextarea(text, textarea, { batchMs: 40, scheduler: new ManualScheduler() });
    textarea.typeValue('last words');
    unbind();
    expect(text.toString()).toBe('last words');
  });

  it('stops syncing after unbinding', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    const textarea = new FakeTextarea();
    const unbind = bindTextarea(text, textarea);
    unbind();
    textarea.typeValue('ignored');
    expect(text.toString()).toBe('');
  });
});
