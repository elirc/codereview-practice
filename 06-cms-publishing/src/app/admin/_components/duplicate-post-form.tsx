"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { duplicatePost } from "@/actions/posts";
import { ErrorMessage } from "./error-message";
import { useActionRunner } from "./use-action";

type Props = { postId: string; slug: string };

export function DuplicatePostForm({ postId, slug: sourceSlug }: Props) {
  const router = useRouter();
  const { run, error, pending } = useActionRunner();
  const [slug, setSlug] = useState(`${sourceSlug}-copy`.slice(0, 120));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    run(
      () => duplicatePost({ postId, slug }),
      (post) => router.push(`/admin/posts/${post.id}`),
    );
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <label>
        New slug
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={120}
          required
        />
      </label>
      <button type="submit" disabled={pending}>
        Duplicate as new draft
      </button>
      <ErrorMessage error={error} />
    </form>
  );
}
