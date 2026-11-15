import Link from "next/link";
import { z } from "zod";
import { requirePageUser } from "@/auth/page-guards";
import { canOnPost } from "@/auth/policy";
import { postStatus } from "@/db/schema";
import { listPostAuthors, listPostsForActor } from "@/services/posts";
import { BulkDeleteForm } from "../_components/bulk-delete-form";
import { CreatePostForm } from "../_components/create-post-form";
import { firstParam, formatInstant } from "../format";

export const metadata = { title: "Posts" };

const filtersSchema = z.object({
  status: z.enum(postStatus.enumValues).optional().catch(undefined),
  author: z.string().uuid().optional().catch(undefined),
});

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const params = await searchParams;
  const filters = filtersSchema.parse({
    status: firstParam(params.status),
    author: firstParam(params.author),
  });
  const showAuthors = user.role !== "author";
  const [items, authors] = await Promise.all([
    listPostsForActor(user, { status: filters.status, authorId: filters.author }),
    showAuthors ? listPostAuthors() : Promise.resolve([]),
  ]);

  const deletable = new Set(
    items.filter((post) => canOnPost(user, "delete", post)).map((post) => post.id),
  );
  const anyDeletable = deletable.size > 0;
  const table = (
    <table>
      <thead>
        <tr>
          {anyDeletable && <th aria-label="Select" />}
          <th>Title</th>
          <th>Slug</th>
          <th>Status</th>
          <th>Author</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {items.map((post) => (
          <tr key={post.id}>
            {anyDeletable && (
              <td>
                {deletable.has(post.id) && (
                  <input
                    type="checkbox"
                    name="postId"
                    value={post.id}
                    aria-label={`Select ${post.title ?? post.slug}`}
                  />
                )}
              </td>
            )}
            <td>
              <Link href={`/admin/posts/${post.id}`}>{post.title ?? "(untitled)"}</Link>
            </td>
            <td>{post.slug}</td>
            <td>
              {post.status}
              {post.scheduledFor && (
                <span className="muted"> for {formatInstant(post.scheduledFor)}</span>
              )}
            </td>
            <td>{post.authorName}</td>
            <td>{formatInstant(post.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <h1>Posts</h1>
      <CreatePostForm />
      <form className="inline" method="get">
        <label>
          Status
          <select name="status" defaultValue={filters.status ?? ""}>
            <option value="">Any</option>
            {postStatus.enumValues.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        {showAuthors && (
          <label>
            Author
            <select name="author" defaultValue={filters.author ?? ""}>
              <option value="">Anyone</option>
              {authors.map((author) => (
                <option key={author.id} value={author.id}>
                  {author.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit">Filter</button>
      </form>
      {anyDeletable ? <BulkDeleteForm>{table}</BulkDeleteForm> : table}
      {items.length === 0 && <p className="muted">No posts match.</p>}
    </>
  );
}
