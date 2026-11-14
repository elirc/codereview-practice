import { z } from 'zod';

export const CONTROL_CHANNEL = 'control';

/** Returns the bus channel of a document. */
export function docChannel(docId: string): string {
  return `doc:${docId}`;
}

const instanceId = z.string().min(1);

export const docBusMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('update'),
    instanceId,
    seq: z.number().int().positive(),
    update: z.string(),
  }),
  z.object({ kind: z.literal('awareness'), instanceId, update: z.string() }),
  z.object({ kind: z.literal('perm'), instanceId }),
  z.object({ kind: z.literal('meta'), instanceId, title: z.string() }),
  z.object({ kind: z.literal('comments'), instanceId }),
  z.object({ kind: z.literal('trashed'), instanceId }),
]);

export const controlBusMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace_perm'), instanceId, workspaceId: z.string().uuid() }),
  z.object({ kind: z.literal('session_ended'), instanceId, sessionId: z.string().uuid() }),
]);

export type DocBusMessage = z.infer<typeof docBusMessage>;
export type ControlBusMessage = z.infer<typeof controlBusMessage>;
export type BusMessage = DocBusMessage | ControlBusMessage;
