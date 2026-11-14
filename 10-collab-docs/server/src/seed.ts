import * as Y from 'yjs';
import { DocStore } from './collab/docStore.js';
import { loadConfig } from './config/config.js';
import { createDb } from './db/db.js';
import { systemClock } from './lib/clock.js';
import { createLogger } from './lib/logger.js';
import { cryptoRandom } from './lib/random.js';
import * as auth from './services/auth.js';
import { createThread } from './services/comments.js';
import type { ServiceContext } from './services/context.js';
import * as docs from './services/docs.js';
import { noLiveDocs } from './services/liveDocs.js';
import { silentNotifier } from './services/notifier.js';
import * as sharing from './services/sharing.js';
import { createNamedVersion } from './services/versions.js';
import * as workspaces from './services/workspaces.js';

export const SEED_PASSWORD = 'password123';

const PEOPLE = {
  owner: { email: 'olivia@example.com', name: 'Olivia Owner' },
  admin: { email: 'adam@example.com', name: 'Adam Admin' },
  member: { email: 'maya@example.com', name: 'Maya Member' },
  commenter: { email: 'cole@example.com', name: 'Cole Commenter' },
  external: { email: 'erin@example.com', name: 'Erin External' },
} as const;

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, { process: 'seed' });
const db = createDb(config.DATABASE_URL, 2);
const ctx: ServiceContext = {
  db,
  clock: systemClock,
  random: cryptoRandom,
  config,
  notifier: silentNotifier,
  live: noLiveDocs,
};
const store = new DocStore(db, systemClock, config.MAX_DOC_BYTES);

/** Appends text to a document as a series of updates and returns the resulting Y.Doc. */
async function write(docId: string, userId: string, paragraphs: string[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  const text = doc.getText('content');
  for (const paragraph of paragraphs) text.insert(text.length, `${paragraph}\n\n`);
  for (const update of updates) {
    const result = await store.append({ docId, update, userId });
    if (result.status !== 'ok') throw new Error(`seed append failed: ${result.status}`);
  }
  return doc;
}

function anchor(doc: Y.Doc, quote: string) {
  const text = doc.getText('content');
  const start = text.toString().indexOf(quote);
  return {
    start: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, start, 0)),
    end: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, start + quote.length, -1)),
  };
}

async function seed(): Promise<void> {
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', PEOPLE.owner.email)
    .executeTakeFirst();
  if (existing) {
    logger.info('seed data already present');
    return;
  }

  const users = {} as Record<keyof typeof PEOPLE, string>;
  for (const key of Object.keys(PEOPLE) as Array<keyof typeof PEOPLE>) {
    const created = await auth.register(ctx, { ...PEOPLE[key], password: SEED_PASSWORD });
    users[key] = created.user.id;
  }

  const team = await workspaces.createWorkspace(ctx, users.owner, { name: 'Acme Product' });
  await workspaces.addMember(ctx, users.owner, team.id, { email: PEOPLE.admin.email, role: 'admin' });
  await workspaces.addMember(ctx, users.owner, team.id, { email: PEOPLE.member.email, role: 'member' });
  await workspaces.addMember(ctx, users.owner, team.id, {
    email: PEOPLE.commenter.email,
    role: 'member',
  });
  await workspaces.updateWorkspace(ctx, users.owner, team.id, { allowExternalSharing: true });

  const ownerPrincipal = { userId: users.owner, link: null };
  const plan = await docs.createDoc(ctx, users.owner, team.id, {
    title: 'Product plan',
    workspaceAccess: 'editor',
  });
  const planDoc = await write(plan.id, users.owner, [
    'Q3 goals: ship offline mode and shared templates.',
    'Risks: the sync server needs a second instance before launch.',
    'Owners: Maya drives the beta, Adam reviews pricing.',
  ]);
  await createNamedVersion(ctx, plan.id, ownerPrincipal, { label: 'First draft' });
  await sharing.shareDoc(ctx, plan.id, ownerPrincipal, { email: PEOPLE.external.email, role: 'viewer' });
  await createThread(ctx, plan.id, ownerPrincipal, {
    anchor: anchor(planDoc, 'second instance'),
    body: 'Do we have a date for this?',
  });

  const notes = await docs.createDoc(ctx, users.member, team.id, {
    title: 'Meeting notes',
    workspaceAccess: 'viewer',
  });
  await write(notes.id, users.member, ['Monday sync', '- Beta feedback is mostly about search.']);
  await sharing.shareDoc(ctx, notes.id, { userId: users.member, link: null }, {
    email: PEOPLE.commenter.email,
    role: 'commenter',
  });

  const old = await docs.createDoc(ctx, users.owner, team.id, { title: 'Old draft' });
  await write(old.id, users.owner, ['Superseded by the product plan.']);
  await docs.trashDoc(ctx, old.id, ownerPrincipal);

  logger.info({ docId: plan.id }, 'seed complete');
}

try {
  await seed();
} catch (error) {
  logger.error({ err: error }, 'seed failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}
