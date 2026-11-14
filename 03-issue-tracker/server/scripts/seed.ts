import { loadConfig, loadDotEnvIfPresent } from '../src/config.js';
import { createDb, type Database } from '../src/db/index.js';
import type { IssueStatus, MembershipRole } from '../src/db/types.js';
import { createScriptLogger } from '../src/lib/logger.js';
import { hashPassword } from '../src/lib/password.js';
import { insertComment } from '../src/modules/comments/repo.js';
import {
  allocateIssueNumber,
  insertIssue,
  replaceIssueLabels,
} from '../src/modules/issues/repo.js';

const PASSWORD = 'tracker-demo-1';

const USERS = [
  { email: 'owner@acme.test', name: 'Olivia Owner' },
  { email: 'admin@acme.test', name: 'Adrian Admin' },
  { email: 'member@acme.test', name: 'Mona Member' },
  { email: 'viewer@acme.test', name: 'Victor Viewer' },
  { email: 'owner@globex.test', name: 'Gloria Owner' },
];

interface SeedIssue {
  project: string;
  title: string;
  description?: string;
  status: IssueStatus;
  priority: number;
  assignee?: string;
  labels?: string[];
  comments?: [string, string][];
}

const ACME_ISSUES: SeedIssue[] = [
  {
    project: 'ENG',
    title: 'Login button overlaps footer on mobile',
    description: 'On screens narrower than 380px the login button covers the footer links.',
    status: 'todo',
    priority: 3,
    assignee: 'member@acme.test',
    labels: ['Bug'],
    comments: [
      ['member@acme.test', 'Reproduced on an iPhone SE.'],
      ['admin@acme.test', 'Please add a screenshot to the ticket.'],
    ],
  },
  {
    project: 'ENG',
    title: 'Export reports as CSV',
    description: 'Finance wants a CSV export of the monthly report.',
    status: 'backlog',
    priority: 2,
    labels: ['Feature'],
  },
  {
    project: 'ENG',
    title: 'Crash when exporting an empty report',
    status: 'in_progress',
    priority: 4,
    assignee: 'admin@acme.test',
    labels: ['Bug', 'Urgent'],
  },
  { project: 'ENG', title: 'Upgrade the charting library', status: 'done', priority: 1 },
  { project: 'ENG', title: 'Write onboarding docs', status: 'cancelled', priority: 0 },
  {
    project: 'OPS',
    title: 'Rotate database credentials',
    description: 'Quarterly rotation for the production database user.',
    status: 'todo',
    priority: 2,
    assignee: 'admin@acme.test',
  },
  { project: 'OPS', title: 'Set up uptime alerts', status: 'backlog', priority: 1 },
];

async function upsertUsers(db: Database): Promise<Map<string, string>> {
  const passwordHash = await hashPassword(PASSWORD);
  const ids = new Map<string, string>();
  for (const user of USERS) {
    const row = await db
      .insertInto('users')
      .values({ email: user.email, name: user.name, password_hash: passwordHash })
      .onConflict((oc) => oc.column('email').doUpdateSet({ name: user.name }))
      .returning('id')
      .executeTakeFirstOrThrow();
    ids.set(user.email, row.id);
  }
  return ids;
}

async function seedOrg(
  db: Database,
  slug: string,
  name: string,
  members: [string, MembershipRole][],
  users: Map<string, string>,
): Promise<string | null> {
  const existing = await db
    .selectFrom('orgs')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (existing) return null;
  const org = await db
    .insertInto('orgs')
    .values({ slug, name })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const [email, role] of members) {
    await db
      .insertInto('memberships')
      .values({ org_id: org.id, user_id: users.get(email) as string, role })
      .execute();
  }
  return org.id;
}

async function seedAcmeContent(db: Database, orgId: string, users: Map<string, string>) {
  const now = new Date();
  const projects = new Map<string, string>();
  for (const [key, projectName] of [
    ['ENG', 'Engineering'],
    ['OPS', 'Operations'],
    ['OLD', 'Legacy site'],
  ]) {
    const row = await db
      .insertInto('projects')
      .values({ org_id: orgId, key, name: projectName })
      .returning('id')
      .executeTakeFirstOrThrow();
    projects.set(key, row.id);
  }
  const labels = new Map<string, string>();
  for (const [labelName, color] of [
    ['Bug', '#d73a4a'],
    ['Feature', '#0e8a16'],
    ['Urgent', '#b60205'],
  ]) {
    const row = await db
      .insertInto('labels')
      .values({ org_id: orgId, name: labelName, color })
      .returning('id')
      .executeTakeFirstOrThrow();
    labels.set(labelName, row.id);
  }

  const reporter = users.get('owner@acme.test') as string;
  for (const issue of ACME_ISSUES) {
    const projectId = projects.get(issue.project) as string;
    const number = (await allocateIssueNumber(orgId, projectId, db)) as number;
    const issueId = await insertIssue(
      orgId,
      {
        projectId,
        number,
        title: issue.title,
        description: issue.description ?? '',
        status: issue.status,
        priority: issue.priority,
        assigneeId: issue.assignee ? (users.get(issue.assignee) as string) : null,
        reporterId: reporter,
        now,
      },
      db,
    );
    const labelIds = (issue.labels ?? []).map((l) => labels.get(l) as string);
    await replaceIssueLabels(orgId, issueId, labelIds, db);
    for (const [author, body] of issue.comments ?? []) {
      await insertComment(
        orgId,
        { issueId, authorId: users.get(author) as string, body, now },
        db,
      );
    }
  }

  const legacyId = projects.get('OLD') as string;
  const legacyNumber = (await allocateIssueNumber(orgId, legacyId, db)) as number;
  await insertIssue(
    orgId,
    {
      projectId: legacyId,
      number: legacyNumber,
      title: 'Retire the old marketing site',
      description: '',
      status: 'done',
      priority: 0,
      assigneeId: null,
      reporterId: reporter,
      now,
    },
    db,
  );
  await db
    .updateTable('projects')
    .set({ archived_at: now })
    .where('org_id', '=', orgId)
    .where('id', '=', legacyId)
    .execute();
}

loadDotEnvIfPresent();
const config = loadConfig(process.env);
const log = createScriptLogger('seed', config.logLevel);
const db = createDb(config.databaseUrl, 1);

try {
  await db.transaction().execute(async (trx) => {
    const users = await upsertUsers(trx);
    const acme = await seedOrg(
      trx,
      'acme',
      'Acme Inc.',
      [
        ['owner@acme.test', 'owner'],
        ['admin@acme.test', 'admin'],
        ['member@acme.test', 'member'],
        ['viewer@acme.test', 'viewer'],
      ],
      users,
    );
    if (acme) await seedAcmeContent(trx, acme, users);

    const globex = await seedOrg(
      trx,
      'globex',
      'Globex Corporation',
      [
        ['owner@globex.test', 'owner'],
        ['member@acme.test', 'member'],
      ],
      users,
    );
    if (globex) {
      const project = await trx
        .insertInto('projects')
        .values({ org_id: globex, key: 'ENG', name: 'Globex Engineering' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const number = (await allocateIssueNumber(globex, project.id, trx)) as number;
      await insertIssue(
        globex,
        {
          projectId: project.id,
          number,
          title: 'Globex-only issue with the same identifier as Acme ENG-1',
          description: '',
          status: 'todo',
          priority: 2,
          assigneeId: null,
          reporterId: users.get('owner@globex.test') as string,
          now: new Date(),
        },
        trx,
      );
    }
    log.info({ acmeSeeded: !!acme, globexSeeded: !!globex }, 'seed complete');
  });
} catch (err) {
  log.error({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await db.destroy();
}
