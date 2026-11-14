import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { restoreRevision } from "@/actions/posts";
import { publishPost } from "@/actions/workflow";
import { orNotFound, requirePageUser } from "@/auth/page-guards";
import { canOnPost } from "@/auth/policy";
import { getPostForActor } from "@/services/posts";
import { diffRevisions, listRevisions } from "@/services/revisions";
import { nextStatus } from "@/services/workflow-rules";
import { ActionButton } from "../../../_components/action-button";
import { ScheduleForm } from "../../../_components/schedule-form";
import { firstParam, formatInstant } from "../../../format";

export const metadata = { title: "Revisions" };

const uuid = z.string().uuid();

export default async function RevisionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const id = uuid.safeParse((await params).id);
  if (!id.success) notFound();
  const query = await searchParams;

  const post = await orNotFound(getPostForActor(user, id.data));
  const revisions = await listRevisions(user, post.id);

  const from = uuid.safeParse(firstParam(query.from));
  const to = uuid.safeParse(firstParam(query.to));
  const diff =
    from.success && to.success
      ? await orNotFound(diffRevisions(user, post.id, from.data, to.data))
      : null;

  const canEdit = canOnPost(user, "editContent", post);
  const hasLive = post.publishedRevisionId !== null;
  const canPublish =
    canOnPost(user, "publish", post) && nextStatus(post.status, "publish", hasLive) !== null;
  const canSchedule =
    canOnPost(user, "publish", post) && nextStatus(post.status, "schedule", hasLive) !== null;

  return (
    <>
      <h1>Revisions</h1>
      <p>
        <Link href={`/admin/posts/${post.id}`}>Back to editor</Link> · status{" "}
        <strong>{post.status}</strong>, version {post.version}
      </p>

      <form className="inline" method="get">
        <label>
          From
          <select name="from" defaultValue={diff?.from.id ?? revisions[1]?.id ?? ""}>
            {revisions.map((revision) => (
              <option key={revision.id} value={revision.id}>
                {revision.number}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <select name="to" defaultValue={diff?.to.id ?? revisions[0]?.id ?? ""}>
            {revisions.map((revision) => (
              <option key={revision.id} value={revision.id}>
                {revision.number}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Compare</button>
      </form>

      {diff && (
        <section>
          <h2>
            Revision {diff.from.number} → {diff.to.number}
          </h2>
          {diff.from.title !== diff.to.title && (
            <p>
              Title: <del>{diff.from.title}</del> → <ins>{diff.to.title}</ins>
            </p>
          )}
          <div className="diff">
            {diff.lines.map((line, index) => (
              <div key={index} className={line.kind}>
                {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                {line.text}
              </div>
            ))}
          </div>
        </section>
      )}

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Saved</th>
            <th>Notes</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {revisions.map((revision) => (
            <tr key={revision.id}>
              <td>{revision.number}</td>
              <td>{revision.title}</td>
              <td>
                {formatInstant(revision.createdAt)} by {revision.createdByName}
              </td>
              <td>
                {revision.id === post.latestRevisionId && "latest "}
                {revision.id === post.publishedRevisionId && "live "}
                {revision.id === post.scheduledRevisionId && "scheduled "}
                {revision.restoredFromNumber && `restored from ${revision.restoredFromNumber}`}
              </td>
              <td>
                <div className="actions">
                  {canEdit && (
                    <ActionButton
                      label="Restore"
                      action={restoreRevision}
                      input={{
                        postId: post.id,
                        revisionId: revision.id,
                        expectedVersion: post.version,
                      }}
                    />
                  )}
                  {canPublish && (
                    <ActionButton
                      label="Publish"
                      action={publishPost}
                      input={{
                        postId: post.id,
                        revisionId: revision.id,
                        expectedVersion: post.version,
                      }}
                    />
                  )}
                  {canSchedule && (
                    <ScheduleForm
                      postId={post.id}
                      revisionId={revision.id}
                      expectedVersion={post.version}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
