import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { deletePost } from "@/actions/posts";
import {
  archivePost,
  cancelSchedule,
  publishPost,
  submitForReview,
  unarchivePost,
  unpublishPost,
  withdrawFromReview,
} from "@/actions/workflow";
import { orNotFound, requirePageUser } from "@/auth/page-guards";
import { canOnPost, type PostPermission } from "@/auth/policy";
import { listMediaLibrary } from "@/services/media";
import { getPostForActor } from "@/services/posts";
import { listRevisions } from "@/services/revisions";
import { nextStatus, type WorkflowAction } from "@/services/workflow-rules";
import { ActionButton } from "../../_components/action-button";
import { PostEditor } from "../../_components/post-editor";
import { ScheduleForm } from "../../_components/schedule-form";
import { SlugForm } from "../../_components/slug-form";
import { formatInstant } from "../../format";

export const metadata = { title: "Edit post" };

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();

  const post = await orNotFound(getPostForActor(user, id.data));
  const [revisions, library] = await Promise.all([
    listRevisions(user, post.id),
    listMediaLibrary(),
  ]);
  const latest = revisions.find((revision) => revision.id === post.latestRevisionId);
  if (!latest) notFound();

  const numberOf = (revisionId: string | null) =>
    revisions.find((revision) => revision.id === revisionId)?.number ?? null;
  const allowed = (permission: PostPermission) => canOnPost(user, permission, post);
  const legal = (action: WorkflowAction) =>
    nextStatus(post.status, action, post.publishedRevisionId !== null) !== null;
  const command = { postId: post.id, expectedVersion: post.version };
  const coverOptions = library
    .filter((item) => item.contentType.startsWith("image/"))
    .map((item) => ({ id: item.id, label: item.originalFilename }));
  const publishedNumber = numberOf(post.publishedRevisionId);
  const scheduledNumber = numberOf(post.scheduledRevisionId);

  return (
    <>
      <h1>{latest.title}</h1>
      <div className="status-bar">
        <span>
          Status: <strong>{post.status}</strong>
        </span>
        <span>Version {post.version}</span>
        <span>Latest revision {latest.number}</span>
        <span>
          Live: {publishedNumber ? `revision ${publishedNumber}` : "no"}
          {post.publishedAt && ` since ${formatInstant(post.publishedAt)}`}
        </span>
        {scheduledNumber && (
          <span>
            Scheduled: revision {scheduledNumber} at {formatInstant(post.scheduledFor)}
          </span>
        )}
        <Link href={`/admin/posts/${post.id}/revisions`}>Revisions</Link>
        <a href={`/api/preview?postId=${post.id}&revisionId=${latest.id}`}>Preview</a>
        {post.publishedRevisionId && <Link href={`/posts/${post.slug}`}>View live</Link>}
      </div>

      <div className="actions">
        {allowed("submit") && legal("submit") && (
          <ActionButton label="Submit for review" action={submitForReview} input={command} />
        )}
        {allowed("withdraw") && legal("withdraw") && (
          <ActionButton label="Back to draft" action={withdrawFromReview} input={command} />
        )}
        {allowed("publish") && legal("publish") && (
          <ActionButton
            label={`Publish revision ${latest.number}`}
            action={publishPost}
            input={{ ...command, revisionId: latest.id }}
          />
        )}
        {allowed("publish") && legal("cancelSchedule") && (
          <ActionButton label="Cancel schedule" action={cancelSchedule} input={command} />
        )}
        {allowed("publish") && legal("unpublish") && (
          <ActionButton
            label="Unpublish"
            action={unpublishPost}
            input={command}
            confirmMessage="Take this post off the public site?"
          />
        )}
        {allowed("publish") && legal("archive") && (
          <ActionButton
            label="Archive"
            action={archivePost}
            input={command}
            confirmMessage="Archive this post? It will be removed from the public site."
          />
        )}
        {allowed("publish") && legal("unarchive") && (
          <ActionButton label="Unarchive" action={unarchivePost} input={command} />
        )}
        {allowed("delete") && (
          <ActionButton
            label="Delete post"
            action={deletePost}
            input={command}
            confirmMessage="Delete this post and all of its revisions?"
            redirectTo="/admin/posts"
          />
        )}
      </div>

      {allowed("publish") && legal("schedule") && (
        <ScheduleForm
          postId={post.id}
          revisionId={latest.id}
          expectedVersion={post.version}
          label={`Schedule revision ${latest.number}`}
        />
      )}
      {allowed("changeSlug") ? (
        <SlugForm postId={post.id} expectedVersion={post.version} slug={post.slug} />
      ) : (
        <p className="muted">Slug: {post.slug}</p>
      )}

      <PostEditor
        key={`${latest.id}:${post.version}`}
        postId={post.id}
        expectedVersion={post.version}
        initial={{
          title: latest.title,
          excerpt: latest.excerpt,
          body: latest.body,
          coverMediaId: latest.coverMediaId,
        }}
        coverOptions={coverOptions}
        readOnly={!allowed("editContent")}
      />
    </>
  );
}
