"use client";

import type { FormEvent, ReactNode } from "react";
import { deletePosts } from "@/actions/posts";
import { ErrorMessage } from "./error-message";
import { useActionRunner } from "./use-action";

/** Wraps the post table; checked `postId` boxes are deleted together. */
export function BulkDeleteForm({ children }: { children: ReactNode }) {
  const { run, error, pending } = useActionRunner();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const postIds = new FormData(event.currentTarget).getAll("postId").map(String);
    if (postIds.length === 0) return;
    const noun = postIds.length === 1 ? "post" : "posts";
    if (!window.confirm(`Delete ${postIds.length} ${noun} and all of their revisions?`)) return;
    run(() => deletePosts({ postIds }));
  }

  return (
    <form onSubmit={onSubmit}>
      {children}
      <div className="actions">
        <button type="submit" disabled={pending}>
          Delete selected
        </button>
        <ErrorMessage error={error} />
      </div>
    </form>
  );
}
