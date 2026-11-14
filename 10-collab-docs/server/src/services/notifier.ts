export type DocEvent =
  | { kind: 'perm' }
  | { kind: 'meta'; title: string }
  | { kind: 'comments' }
  | { kind: 'trashed' };

export type ControlEvent =
  | { kind: 'workspace_perm'; workspaceId: string }
  | { kind: 'session_ended'; sessionId: string };

/** Announces committed changes to every server instance. */
export interface Notifier {
  doc(docId: string, event: DocEvent): void;
  control(event: ControlEvent): void;
}

/** A notifier for processes with no live connections to inform. */
export const silentNotifier: Notifier = {
  doc: () => undefined,
  control: () => undefined,
};
