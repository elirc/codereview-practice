import { sql } from 'kysely';
import { readDocLog } from '../collab/docStore.js';
import { stateOfLog } from '../collab/docState.js';
import { toBytea, type Db } from '../db/db.js';
import { addMinutes } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';

export const AUTO_VERSIONS_KEPT = 50;

export interface AutoVersionOptions {
  db: Db;
  logger: Logger;
  minutes: number;
}

interface Candidate {
  id: string;
  head_seq: number;
}

/**
 * Creates an automatic version for one document that has changed since its
 * newest version, when that version (or the document) is old enough, and
 * trims older automatic versions. Returns the document id, or null when none is due.
 */
async function versionNext(
  options: AutoVersionOptions,
  skip: string[],
  now: Date,
): Promise<{ docId: string; created: boolean } | null> {
  const cutoff = addMinutes(now, -options.minutes);
  return options.db.transaction().execute(async (trx) => {
    const exclude = skip.length > 0 ? sql`and d.id <> all(${skip}::uuid[])` : sql``;
    const result = await sql<Candidate>`
      select d.id, d.head_seq
      from docs d
      left join lateral (
        select v.seq, v.created_at
        from doc_versions v
        where v.doc_id = d.id
        order by v.created_at desc, v.seq desc
        limit 1
      ) latest on true
      where d.trashed_at is null
        and d.head_seq > coalesce(latest.seq, 0)
        and coalesce(latest.created_at, d.created_at) <= ${cutoff}
        ${exclude}
      order by d.id
      limit 1
      for update of d skip locked
    `.execute(trx);
    const doc = result.rows[0];
    if (!doc) return null;
    skip.push(doc.id);

    const { state } = stateOfLog(await readDocLog(trx, doc.id));
    const inserted = await sql`
      insert into doc_versions (doc_id, seq, state, kind, created_at)
      values (${doc.id}, ${doc.head_seq}, ${toBytea(state)}, 'auto', ${now})
      on conflict (doc_id, seq) where kind = 'auto' do nothing
    `.execute(trx);
    await sql`
      delete from doc_versions
      where doc_id = ${doc.id}
        and kind = 'auto'
        and id not in (
          select id from doc_versions
          where doc_id = ${doc.id} and kind = 'auto'
          order by seq desc
          limit ${AUTO_VERSIONS_KEPT}
        )
    `.execute(trx);
    const created = Number(inserted.numAffectedRows ?? 0n) > 0;
    if (created) options.logger.info({ docId: doc.id, seq: doc.head_seq }, 'automatic version created');
    return { docId: doc.id, created };
  });
}

/** Creates every automatic version that is due; returns how many were created. */
export async function autoVersionOnce(options: AutoVersionOptions, now: Date): Promise<number> {
  const skip: string[] = [];
  let created = 0;
  for (;;) {
    const before = skip.length;
    try {
      const outcome = await versionNext(options, skip, now);
      if (outcome === null) break;
      if (outcome.created) created += 1;
    } catch (error) {
      const docId = skip.length > before ? skip[skip.length - 1] : null;
      options.logger.error({ err: error, docId }, 'automatic version failed');
      if (docId === null) throw error;
    }
  }
  return created;
}
