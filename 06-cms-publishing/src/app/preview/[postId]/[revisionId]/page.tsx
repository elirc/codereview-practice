import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { previewQuerySchema } from "@/actions/schemas";
import { getCurrentUser } from "@/auth/current-user";
import { orNotFound } from "@/auth/page-guards";
import { PostArticle } from "@/components/post-article";
import { loadPreview } from "@/services/preview";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Preview",
  robots: { index: false, follow: false },
};

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ postId: string; revisionId: string }>;
}) {
  const ids = previewQuerySchema.safeParse(await params);
  if (!ids.success) notFound();

  const actor = await getCurrentUser();
  if (!actor) notFound();
  const { post, revision, html } = await orNotFound(
    loadPreview(actor, ids.data.postId, ids.data.revisionId),
  );

  return (
    <>
      <div className="banner">
        Preview of revision {revision.number} ({post.status}).{" "}
        <Link href={`/admin/posts/${post.id}`}>Back to editor</Link>
        {" · "}
        <Link href={`/posts/${post.slug}`}>Latest revision on the site</Link>
      </div>
      <main>
        <PostArticle
          title={revision.title}
          excerpt={revision.excerpt}
          coverMediaId={revision.coverMediaId}
          html={html}
          publishedAt={null}
        />
      </main>
    </>
  );
}
