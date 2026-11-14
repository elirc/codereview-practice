import * as Y from 'yjs';
import { contentOf, docFromLog, stateOfLog, textOfState } from '../collab/docState.js';
import { AppendRejected, DocStore, loadAtHeadIn } from '../collab/docStore.js';
import { readSnapshot, toBytea } from '../db/db.js';
import { canEdit } from '../domain/roles.js';
import { diffText } from '../domain/textDiff.js';
import { errors } from '../http/errors.js';
import { requireDocAccess, resolveDocAccess, type UserPrincipal } from './access.js';
import type { ServiceContext } from './context.js';

export type VersionKind = 'auto' | 'named' | 'pre_restore';

export interface VersionView {
  id: string;
  docId: string;
  seq: number;
  kind: VersionKind;
  label: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface RestoreResult {
  changed: boolean;
  seq: number | null;
  preRestoreVersionId: string | null;
}

const VERSION_COLUMNS = ['id', 'doc_id', 'seq', 'kind', 'label', 'created_by', 'created_at'] as const;

function versionView(row: {
  id: string;
  doc_id: string;
  seq: number;
  kind: VersionKind;
  label: string | null;
  created_by: string | null;
  created_at: Date;
}): VersionView {
  return {
    id: row.id,
    docId: row.doc_id,
    seq: row.seq,
    kind: row.kind,
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Lists a document's versions, newest first. */
export async function listVersions(
  ctx: ServiceContext,
  docId: string,
  principal: UserPrincipal,
): Promise<VersionView[]> {
  await requireDocAccess(ctx.db, docId, principal, ctx.clock.now(), { min: 'editor' });
  const rows = await ctx.db
    .selectFrom('doc_versions')
    .select(VERSION_COLUMNS)
    .where('doc_id', '=', docId)
    .orderBy('created_at', 'desc')
    .orderBy('seq', 'desc')
    .execute();
  return rows.map(versionView);
}

/** Saves the document's current state as a named version. */
export async function createNamedVersion(
  ctx: ServiceContext,
  docId: string,
  principal: UserPrincipal,
  input: { label: string },
): Promise<VersionView> {
  const now = ctx.clock.now();
  await requireDocAccess(ctx.db, docId, principal, now, { min: 'editor' });
  const row = await ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const head = await loadAtHeadIn(trx, docId);
      if (!head) throw errors.notFound('Document not found.');
      const { state } = stateOfLog(head.log);
      return trx
        .insertInto('doc_versions')
        .values({
          doc_id: docId,
          seq: head.headSeq,
          state: toBytea(state),
          kind: 'named',
          label: input.label,
          created_by: principal.userId,
          created_at: now,
        })
        .returning(VERSION_COLUMNS)
        .executeTakeFirstOrThrow();
    });
  return versionView(row);
}

/** Returns a version with its text, for someone who may edit its document. */
export async function getVersion(
  ctx: ServiceContext,
  versionId: string,
  principal: UserPrincipal,
): Promise<VersionView & { text: string }> {
  const row = await ctx.db
    .selectFrom('doc_versions')
    .select([...VERSION_COLUMNS, 'state'])
    .where('id', '=', versionId)
    .executeTakeFirst();
  if (!row) throw errors.notFound('Version not found.');
  const access = await resolveDocAccess(ctx.db, row.doc_id, principal, ctx.clock.now());
  if (access.kind !== 'ok') throw errors.notFound('Version not found.');
  if (!canEdit(access.access.role)) throw errors.forbidden();
  return { ...versionView(row), text: textOfState(row.state) };
}

/**
 * Restores a version by appending one update that replaces the changed range
 * of the current text with the version's text. Writes nothing when the texts
 * are already equal; otherwise also records the prior state as `pre_restore`.
 */
export async function restoreVersion(
  ctx: ServiceContext,
  docId: string,
  versionId: string,
  principal: UserPrincipal,
): Promise<RestoreResult> {
  await requireDocAccess(ctx.db, docId, principal, ctx.clock.now(), { min: 'editor' });
  const version = await ctx.db
    .selectFrom('doc_versions')
    .select(['state'])
    .where('id', '=', versionId)
    .where('doc_id', '=', docId)
    .executeTakeFirst();
  if (!version) throw errors.notFound('Version not found.');
  const targetText = textOfState(version.state);
  const store = new DocStore(ctx.db, ctx.clock, ctx.config.MAX_DOC_BYTES);

  return ctx.live.runExclusive(docId, async () => {
    const head = await readSnapshot(ctx.db, (trx) => loadAtHeadIn(trx, docId));
    if (!head) throw errors.notFound('Document not found.');
    const working = docFromLog(head.log);
    try {
      const content = contentOf(working);
      const change = diffText(content.toString(), targetText);
      if (change === null) return { changed: false, seq: null, preRestoreVersionId: null };

      const before = Y.encodeStateAsUpdate(working);
      const captured: Uint8Array[] = [];
      working.on('update', (update: Uint8Array) => captured.push(update));
      working.transact(() => {
        if (change.deleteCount > 0) content.delete(change.index, change.deleteCount);
        if (change.insert.length > 0) content.insert(change.index, change.insert);
      });
      const update = captured.length === 1 ? captured[0] : Y.mergeUpdates(captured);

      const now = ctx.clock.now();
      let committed: { seq: number; preRestoreVersionId: string };
      try {
        committed = await ctx.db.transaction().execute(async (trx) => {
          const preRestore = await trx
            .insertInto('doc_versions')
            .values({
              doc_id: docId,
              seq: head.headSeq,
              state: toBytea(before),
              kind: 'pre_restore',
              created_by: principal.userId,
              created_at: now,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const seq = await store.appendInTransaction(trx, {
            docId,
            update,
            userId: principal.userId,
            authorize: async (inner) => {
              const access = await resolveDocAccess(inner, docId, principal, now);
              return access.kind === 'ok' && canEdit(access.access.role);
            },
          });
          return { seq, preRestoreVersionId: preRestore.id };
        });
      } catch (error) {
        if (!(error instanceof AppendRejected)) throw error;
        if (error.status === 'missing') throw errors.notFound('Document not found.');
        if (error.status === 'forbidden') throw errors.forbidden();
        throw errors.invalidState('The document has reached its size limit.', 422);
      }
      ctx.live.applyCommitted(docId, committed.seq, update);
      return { changed: true, ...committed };
    } finally {
      working.destroy();
    }
  });
}
