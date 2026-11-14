import { beforeEach, describe, expect, it } from 'vitest';
import { useTestContext } from './support/context.js';
import { seedTwoOrgs, type Fixture } from './support/fixtures.js';

describe('database constraints', () => {
  const ctx = useTestContext();
  let f: Fixture;

  beforeEach(async () => {
    f = await seedTwoOrgs(ctx);
  });

  it('rejects an issue label linking an issue to another org label', async () => {
    const insert = ctx.db
      .insertInto('issue_labels')
      .values({
        org_id: f.acme.id,
        issue_id: f.acme.issues['ENG-1'],
        label_id: f.globex.labels.Bug,
      })
      .execute();
    await expect(insert).rejects.toMatchObject({
      code: '23503',
      constraint: 'issue_labels_label_fkey',
    });
  });

  it('rejects an issue label whose issue belongs to another org', async () => {
    const insert = ctx.db
      .insertInto('issue_labels')
      .values({
        org_id: f.acme.id,
        issue_id: f.globex.issues['ENG-1'],
        label_id: f.acme.labels.Bug,
      })
      .execute();
    await expect(insert).rejects.toMatchObject({
      code: '23503',
      constraint: 'issue_labels_issue_fkey',
    });
  });

  it('rejects a comment on another org issue', async () => {
    const insert = ctx.db
      .insertInto('comments')
      .values({
        org_id: f.acme.id,
        issue_id: f.globex.issues['ENG-1'],
        author_id: f.users.alice.id,
        body: 'Cross-org',
      })
      .execute();
    await expect(insert).rejects.toMatchObject({
      code: '23503',
      constraint: 'comments_issue_fkey',
    });
  });

  it('rejects an issue in another org project', async () => {
    const insert = ctx.db
      .insertInto('issues')
      .values({
        org_id: f.acme.id,
        project_id: f.globex.projects.MKT,
        number: 50,
        title: 'Cross-org',
        reporter_id: f.users.alice.id,
      })
      .execute();
    await expect(insert).rejects.toMatchObject({
      code: '23503',
      constraint: 'issues_project_fkey',
    });
  });

  it('rejects an assignee who is not a member of the issue org', async () => {
    const update = ctx.db
      .updateTable('issues')
      .set({ assignee_id: f.users.gina.id })
      .where('id', '=', f.acme.issues['ENG-1'])
      .execute();
    await expect(update).rejects.toMatchObject({
      code: '23503',
      constraint: 'issues_assignee_fkey',
    });
  });

  it('rejects label names that differ only by case within one org', async () => {
    const insert = ctx.db
      .insertInto('labels')
      .values({ org_id: f.acme.id, name: 'BUG', color: '#000000' })
      .execute();
    await expect(insert).rejects.toMatchObject({
      code: '23505',
      constraint: 'labels_org_id_name_key',
    });
  });

  it('rejects a duplicate issue number within a project', async () => {
    const insert = ctx.db
      .insertInto('issues')
      .values({
        org_id: f.acme.id,
        project_id: f.acme.projects.ENG,
        number: 1,
        title: 'Duplicate',
        reporter_id: f.users.alice.id,
      })
      .execute();
    await expect(insert).rejects.toMatchObject({ code: '23505' });
  });
});
