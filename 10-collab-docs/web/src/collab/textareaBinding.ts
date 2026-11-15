import * as Y from 'yjs';
import { diffText } from './diff';
import { browserScheduler, type Scheduler } from './provider';

/** The parts of a textarea the binding uses. */
export interface TextAreaLike {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  addEventListener(type: 'input', listener: () => void): void;
  removeEventListener(type: 'input', listener: () => void): void;
}

export interface BindOptions {
  /** Input events within this many milliseconds become one change; 0 applies each one at once. */
  batchMs?: number;
  scheduler?: Scheduler;
}

/**
 * Keeps a textarea and a Y.Text in step: input becomes one delete + insert
 * per batch, and remote changes update the value while keeping the
 * selection on the same characters. Returns a function that unbinds.
 */
export function bindTextarea(
  text: Y.Text,
  textarea: TextAreaLike,
  options: BindOptions = {},
): () => void {
  const doc = text.doc;
  if (!doc) throw new Error('Y.Text must belong to a document');
  const batchMs = options.batchMs ?? 0;
  const scheduler = options.scheduler ?? browserScheduler;
  const origin = { source: 'textarea' };
  let selection: { start: Y.RelativePosition; end: Y.RelativePosition } | null = null;
  let pending: unknown = null;

  textarea.value = text.toString();

  const flush = () => {
    pending = null;
    const change = diffText(text.toString(), textarea.value);
    if (!change) return;
    doc.transact(() => {
      if (change.deleteCount > 0) text.delete(change.index, change.deleteCount);
      if (change.insert.length > 0) text.insert(change.index, change.insert);
    }, origin);
  };

  const onInput = () => {
    if (batchMs <= 0) {
      flush();
      return;
    }
    if (pending === null) pending = scheduler.setTimeout(flush, batchMs);
  };

  const beforeTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin === origin) return;
    const length = text.length;
    const startIndex = Math.min(textarea.selectionStart, length);
    const endIndex = Math.min(textarea.selectionEnd, length);
    const start = Y.createRelativePositionFromTypeIndex(text, startIndex);
    const end =
      endIndex > startIndex ? Y.createRelativePositionFromTypeIndex(text, endIndex, -1) : start;
    selection = { start, end };
  };

  const onChange = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin === origin) return;
    textarea.value = text.toString();
    if (!selection) return;
    const start = Y.createAbsolutePositionFromRelativePosition(selection.start, doc);
    const end = Y.createAbsolutePositionFromRelativePosition(selection.end, doc);
    selection = null;
    if (start && end) textarea.setSelectionRange(start.index, end.index);
  };

  doc.on('beforeTransaction', beforeTransaction);
  text.observe(onChange);
  textarea.addEventListener('input', onInput);

  return () => {
    if (pending !== null) {
      scheduler.clearTimeout(pending);
      flush();
    }
    doc.off('beforeTransaction', beforeTransaction);
    text.unobserve(onChange);
    textarea.removeEventListener('input', onInput);
  };
}
