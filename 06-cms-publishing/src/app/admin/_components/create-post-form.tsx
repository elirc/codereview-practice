"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createPost } from "@/actions/posts";
import { ErrorMessage } from "./error-message";
import { useActionRunner } from "./use-action";

export function CreatePostForm() {
  const router = useRouter();
  const { run, error, pending } = useActionRunner();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    run(
      () => createPost({ title, slug }),
      (post) => router.push(`/admin/posts/${post.id}`),
    );
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <input
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
      <input
        placeholder="slug-like-this"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        pattern="[a-z0-9]+(-[a-z0-9]+)*"
        required
      />
      <button type="submit" disabled={pending}>
        New post
      </button>
      <ErrorMessage error={error} />
    </form>
  );
}
