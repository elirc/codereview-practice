"use client";

import { useState, type FormEvent } from "react";
import { changeSlug } from "@/actions/posts";
import { ErrorMessage } from "./error-message";
import { useActionRunner } from "./use-action";

type Props = { postId: string; expectedVersion: number; slug: string };

export function SlugForm({ postId, expectedVersion, slug: currentSlug }: Props) {
  const { run, error, pending } = useActionRunner();
  const [slug, setSlug] = useState(currentSlug);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    run(() => changeSlug({ postId, expectedVersion, slug }));
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <label>
        Slug
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxLength={120}
          required
        />
      </label>
      <button type="submit" disabled={pending || slug === currentSlug}>
        Change slug
      </button>
      <ErrorMessage error={error} />
    </form>
  );
}
