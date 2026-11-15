import type { Metadata } from "next";
import { draftMode } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";
import { getPublishedPostBySlug } from "@/cache/readers";
import { PostArticle } from "@/components/post-article";
import { loadLatestBySlug } from "@/services/preview";
import { SLUG_PATTERN } from "@/services/slugs";

type Params = { params: Promise<{ slug: string }> };

async function load(slug: string, draft: boolean) {
  if (slug.length > 120 || !SLUG_PATTERN.test(slug)) return null;
  return draft ? loadLatestBySlug(slug) : getPublishedPostBySlug(slug);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { isEnabled } = await draftMode();
  const result = await load((await params).slug, isEnabled);
  if (result?.kind !== "post") return {};
  return {
    title: result.title,
    description: result.excerpt || undefined,
    robots: isEnabled ? { index: false, follow: false } : undefined,
  };
}

export default async function PostPage({ params }: Params) {
  const { slug } = await params;
  const { isEnabled } = await draftMode();
  const result = await load(slug, isEnabled);
  if (!result) notFound();
  if (result.kind === "redirect") permanentRedirect(`/posts/${result.slug}`);

  return (
    <>
      {isEnabled && (
        <div className="banner">
          Previewing the latest revision, including changes that are not published yet.{" "}
          <a href={`/api/preview/exit?slug=${result.slug}`}>Exit preview</a>
        </div>
      )}
      <PostArticle
        title={result.title}
        excerpt={result.excerpt}
        coverMediaId={result.coverMediaId}
        html={result.html}
        publishedAt={result.publishedAt}
      />
    </>
  );
}
