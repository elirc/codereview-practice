import Link from "next/link";
import { z } from "zod";
import { listPublishedPosts } from "@/cache/readers";

const pageParam = z.coerce.number().int().min(1).max(10_000).catch(1);

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { page: rawPage } = await searchParams;
  const page = pageParam.parse(Array.isArray(rawPage) ? rawPage[0] : (rawPage ?? 1));
  const { items, totalPages } = await listPublishedPosts(page);

  return (
    <>
      <h1>Latest posts</h1>
      {items.length === 0 && <p className="muted">Nothing published yet.</p>}
      {items.map((post) => (
        <section key={post.id}>
          <h2>
            <Link href={`/posts/${post.slug}`}>{post.title}</Link>
          </h2>
          <p className="muted">
            <time dateTime={post.publishedAt}>{dateFormat.format(new Date(post.publishedAt))}</time>
          </p>
          {post.excerpt && <p>{post.excerpt}</p>}
        </section>
      ))}
      <nav className="actions">
        {page > 1 && <Link href={`/?page=${page - 1}`}>Newer posts</Link>}
        {page < totalPages && <Link href={`/?page=${page + 1}`}>Older posts</Link>}
      </nav>
    </>
  );
}
