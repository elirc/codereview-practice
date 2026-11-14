import { sql } from 'kysely';
import type { MembershipRole } from '../../src/db/types.js';
import { createUser, type TestContext, type TestUser } from './context.js';

export interface OrgFixture {
  id: string;
  slug: string;
  projects: Record<string, string>;
  labels: Record<string, string>;
  /** Issue ids keyed by identifier, e.g. `ENG-1`. */
  issues: Record<string, string>;
  comments: Record<string, string>;
}

export type UserKey = 'alice' | 'adam' | 'mia' | 'vic' | 'tom' | 'gina' | 'gus' | 'dana';

export interface Fixture {
  users: Record<UserKey, TestUser>;
  acme: OrgFixture;
  globex: OrgFixture;
}

const SECOND = 1000;

async function insertOrg(
  ctx: TestContext,
  slug: string,
  members: [TestUser, MembershipRole][],
): Promise<OrgFixture> {
  const org = await ctx.db
    .insertInto('orgs')
    .values({ slug, name: slug.toUpperCase() })
    .returning('id')
    .executeTakeFirstOrThrow();
  let joined = ctx.clock.now().getTime();
  for (const [user, role] of members) {
    joined += SECOND;
    await ctx.db
      .insertInto('memberships')
      .values({ org_id: org.id, user_id: user.id, role, created_at: new Date(joined) })
      .execute();
  }
  return { id: org.id, slug, projects: {}, labels: {}, issues: {}, comments: {} };
}

export async function insertProject(
  ctx: TestContext,
  org: OrgFixture,
  key: string,
  options: { archived?: boolean } = {},
): Promise<string> {
  const project = await ctx.db
    .insertInto('projects')
    .values({
      org_id: org.id,
      key,
      name: `${key} project`,
      archived_at: options.archived ? ctx.clock.now() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  org.projects[key] = project.id;
  return project.id;
}

export async function insertLabel(
  ctx: TestContext,
  org: OrgFixture,
  name: string,
  color = '#cc3333',
): Promise<string> {
  const label = await ctx.db
    .insertInto('labels')
    .values({ org_id: org.id, name, color })
    .returning('id')
    .executeTakeFirstOrThrow();
  org.labels[name] = label.id;
  return label.id;
}

/** Inserts an issue with the next number in its project, bypassing the API. */
export async function insertIssue(
  ctx: TestContext,
  org: OrgFixture,
  key: string,
  values: {
    title: string;
    reporterId: string;
    description?: string;
    assigneeId?: string;
    priority?: number;
    createdAt?: Date;
  },
): Promise<{ id: string; identifier: string }> {
  const project = await ctx.db
    .updateTable('projects')
    .set({ next_issue_number: sql<number>`next_issue_number + 1` })
    .where('org_id', '=', org.id)
    .where('key', '=', key)
    .returning(['id', 'next_issue_number'])
    .executeTakeFirstOrThrow();
  const number = project.next_issue_number - 1;
  const at = values.createdAt ?? ctx.clock.now();
  const issue = await ctx.db
    .insertInto('issues')
    .values({
      org_id: org.id,
      project_id: project.id,
      number,
      title: values.title,
      description: values.description ?? '',
      priority: values.priority ?? 0,
      assignee_id: values.assigneeId ?? null,
      reporter_id: values.reporterId,
      created_at: at,
      updated_at: at,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const identifier = `${key}-${number}`;
  org.issues[identifier] = issue.id;
  return { id: issue.id, identifier };
}

export async function insertComment(
  ctx: TestContext,
  org: OrgFixture,
  identifier: string,
  authorId: string,
  body: string,
): Promise<string> {
  const comment = await ctx.db
    .insertInto('comments')
    .values({
      org_id: org.id,
      issue_id: org.issues[identifier],
      author_id: authorId,
      body,
      created_at: ctx.clock.now(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  org.comments[`${identifier}:${body}`] = comment.id;
  return comment.id;
}

/**
 * Two organisations whose project keys and issue numbers overlap:
 * acme has ENG-1..2 and an archived OPS-1; globex has ENG-1..3 and MKT-1.
 * dana belongs to both.
 */
export async function seedTwoOrgs(ctx: TestContext): Promise<Fixture> {
  const users: Record<UserKey, TestUser> = {
    alice: await createUser(ctx, 'alice@acme.test', 'Alice Owner'),
    adam: await createUser(ctx, 'adam@acme.test', 'Adam Admin'),
    mia: await createUser(ctx, 'mia@acme.test', 'Mia Member'),
    vic: await createUser(ctx, 'vic@acme.test', 'Vic Viewer'),
    tom: await createUser(ctx, 'tom@acme.test', 'Tom Member'),
    gina: await createUser(ctx, 'gina@globex.test', 'Gina Owner'),
    gus: await createUser(ctx, 'gus@globex.test', 'Gus Member'),
    dana: await createUser(ctx, 'dana@both.test', 'Dana Dual'),
  };

  const acme = await insertOrg(ctx, 'acme', [
    [users.alice, 'owner'],
    [users.adam, 'admin'],
    [users.mia, 'member'],
    [users.vic, 'viewer'],
    [users.tom, 'member'],
    [users.dana, 'member'],
  ]);
  const globex = await insertOrg(ctx, 'globex', [
    [users.gina, 'owner'],
    [users.gus, 'member'],
    [users.dana, 'member'],
  ]);

  await insertProject(ctx, acme, 'ENG');
  await insertProject(ctx, acme, 'OPS');
  await insertLabel(ctx, acme, 'Bug');
  await insertLabel(ctx, acme, 'Feature', '#3366cc');
  const base = ctx.clock.now().getTime();
  await insertIssue(ctx, acme, 'ENG', {
    title: 'Login button misaligned',
    description: 'The login button overlaps the footer on small screens.',
    reporterId: users.alice.id,
    assigneeId: users.mia.id,
    priority: 2,
    createdAt: new Date(base + 1 * SECOND),
  });
  await insertIssue(ctx, acme, 'ENG', {
    title: 'Crash when exporting reports',
    reporterId: users.mia.id,
    priority: 4,
    createdAt: new Date(base + 2 * SECOND),
  });
  await insertIssue(ctx, acme, 'OPS', {
    title: 'Rotate database credentials',
    reporterId: users.alice.id,
    createdAt: new Date(base + 3 * SECOND),
  });
  await ctx.db
    .updateTable('projects')
    .set({ archived_at: ctx.clock.now() })
    .where('id', '=', acme.projects.OPS)
    .execute();
  await insertComment(ctx, acme, 'ENG-1', users.mia.id, 'I can reproduce this.');

  await insertProject(ctx, globex, 'ENG');
  await insertProject(ctx, globex, 'MKT');
  await insertLabel(ctx, globex, 'Bug');
  for (const n of [1, 2, 3]) {
    await insertIssue(ctx, globex, 'ENG', {
      title: `Globex engineering task ${n}`,
      reporterId: users.gina.id,
      assigneeId: n === 1 ? users.gus.id : undefined,
      createdAt: new Date(base + (10 + n) * SECOND),
    });
  }
  await insertIssue(ctx, globex, 'MKT', {
    title: 'Launch campaign',
    reporterId: users.gina.id,
    createdAt: new Date(base + 20 * SECOND),
  });
  await insertComment(ctx, globex, 'ENG-1', users.gus.id, 'Globex comment');

  return { users, acme, globex };
}
