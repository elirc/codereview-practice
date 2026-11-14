import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getPublishedPostBySlug } from "@/cache/readers";
import { PostArticle } from "@/components/post-article";
import { SLUG_PATTERN } from "@/services/slugs";

type Params = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  if (slug.length > 120 || !SLUG_PATTERN.test(slug)) return null;
  return getPublishedPostBySlug(slug);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const result = await load((await params).slug);
  if (result?.kind !== "post") return {};
  return { title: result.title, description: result.excerpt || undefined };
}

export default async function PostPage({ params }: Params) {
  const { slug } = await params;
  const result = await load(slug);
  if (!result) notFound();
  if (result.kind === "redirect") permanentRedirect(`/posts/${result.slug}`);

  return (
    <PostArticle
      title={result.title}
      excerpt={result.excerpt}
      coverMediaId={result.coverMediaId}
      html={result.html}
      publishedAt={result.publishedAt}
    />
  );
}
