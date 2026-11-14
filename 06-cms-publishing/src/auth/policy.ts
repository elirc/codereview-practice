import type { PostStatus, Role } from "@/db/schema";
import { DomainError, forbiddenError, notFoundError } from "@/services/errors";

export type Actor = { id: string; role: Role };

export type PostFacts = {
  authorId: string;
  status: PostStatus;
  firstPublishedAt: Date | null;
};

export type PostPermission =
  | "view"
  | "editContent"
  | "submit"
  | "withdraw"
  | "publish"
  | "changeSlug"
  | "delete";

export type GlobalPermission = "createPost" | "uploadMedia" | "manageUsers";

export type MediaFacts = {
  uploadedBy: string;
  referencedByAnyRevision: boolean;
  referencedByLiveRevision: boolean;
};

function isStaff(actor: Actor): boolean {
  return actor.role === "editor" || actor.role === "admin";
}

/**
 * Whether `actor` may perform `permission` on a post. "publish" covers every editorial
 * transition: publish, schedule, cancel schedule, unpublish, archive and unarchive.
 */
export function canOnPost(actor: Actor, permission: PostPermission, post: PostFacts): boolean {
  const owns = post.authorId === actor.id;
  const neverPublished = post.firstPublishedAt === null;

  switch (permission) {
    case "view":
    case "submit":
    case "withdraw":
      return isStaff(actor) || owns;
    case "editContent":
      return isStaff(actor) || (owns && post.status !== "archived");
    case "publish":
      return isStaff(actor);
    case "changeSlug":
      return isStaff(actor) || (owns && neverPublished);
    case "delete":
      if (actor.role === "admin") return true;
      return actor.role === "author" && owns && neverPublished;
  }
}

/** Throws `not_found` when the post is not visible to the actor, `forbidden` when it is but the action is not allowed. */
export function authorizePost(actor: Actor, permission: PostPermission, post: PostFacts): void {
  if (!canOnPost(actor, "view", post)) throw notFoundError("Post not found.");
  if (!canOnPost(actor, permission, post)) throw forbiddenError();
}

export function can(actor: Actor, permission: GlobalPermission): boolean {
  switch (permission) {
    case "createPost":
    case "uploadMedia":
      return true;
    case "manageUsers":
      return actor.role === "admin";
  }
}

export function assertCan(actor: Actor, permission: GlobalPermission): void {
  if (!can(actor, permission)) throw forbiddenError();
}

/** Returns the refusal code for deleting a media item, or null when the delete is allowed. */
export function mediaDeleteRefusal(
  actor: Actor,
  media: MediaFacts,
): "forbidden" | "media_in_use" | null {
  if (media.referencedByLiveRevision) return "media_in_use";
  if (actor.role === "admin") return null;
  if (actor.role === "author" && media.uploadedBy !== actor.id) return "forbidden";
  if (media.referencedByAnyRevision) return "media_in_use";
  return null;
}

export function assertCanDeleteMedia(actor: Actor, media: MediaFacts): void {
  const refusal = mediaDeleteRefusal(actor, media);
  if (refusal === "forbidden") throw forbiddenError();
  if (refusal === "media_in_use") {
    throw new DomainError("media_in_use", "This file is used by a post and cannot be deleted.");
  }
}
