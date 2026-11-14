import { describe, expect, it } from "vitest";
import {
  authorizePost,
  can,
  canOnPost,
  mediaDeleteRefusal,
  type Actor,
  type PostPermission,
} from "@/auth/policy";
import type { PostStatus, Role } from "@/db/schema";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const roles: Role[] = ["author", "editor", "admin"];
const statuses: PostStatus[] = ["draft", "in_review", "scheduled", "published", "archived"];

type Rule = "none" | "all" | "own" | "own-unless-archived" | "own-never-published";

/** The permission table, written the way the product requirements state it. */
const table: Record<PostPermission, Record<Role, Rule>> = {
  view: { author: "own", editor: "all", admin: "all" },
  editContent: { author: "own-unless-archived", editor: "all", admin: "all" },
  submit: { author: "own", editor: "all", admin: "all" },
  withdraw: { author: "own", editor: "all", admin: "all" },
  publish: { author: "none", editor: "all", admin: "all" },
  changeSlug: { author: "own-never-published", editor: "all", admin: "all" },
  delete: { author: "own-never-published", editor: "none", admin: "all" },
};

function expected(rule: Rule, own: boolean, status: PostStatus, everPublished: boolean): boolean {
  switch (rule) {
    case "none":
      return false;
    case "all":
      return true;
    case "own":
      return own;
    case "own-unless-archived":
      return own && status !== "archived";
    case "own-never-published":
      return own && !everPublished;
  }
}

const cases = roles.flatMap((role) =>
  [true, false].flatMap((own) =>
    statuses.flatMap((status) =>
      [false, true].map((everPublished) => ({ role, own, status, everPublished })),
    ),
  ),
);

describe("post permissions", () => {
  for (const permission of Object.keys(table) as PostPermission[]) {
    it.each(cases)(
      `${permission}: $role own=$own status=$status everPublished=$everPublished`,
      ({ role, own, status, everPublished }) => {
        const actor: Actor = { id: OWNER_ID, role };
        const post = {
          authorId: own ? OWNER_ID : OTHER_ID,
          status,
          firstPublishedAt: everPublished ? new Date("2030-01-01T00:00:00Z") : null,
        };
        expect(canOnPost(actor, permission, post)).toBe(
          expected(table[permission][role], own, status, everPublished),
        );
      },
    );
  }
});

describe("authorizePost", () => {
  const draft = { authorId: OTHER_ID, status: "draft" as const, firstPublishedAt: null };

  it("hides posts the actor cannot view behind not_found", () => {
    expect(() => authorizePost({ id: OWNER_ID, role: "author" }, "editContent", draft)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  it("reports forbidden for a visible post the actor may not change", () => {
    const own = { ...draft, authorId: OWNER_ID };
    expect(() => authorizePost({ id: OWNER_ID, role: "author" }, "publish", own)).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => authorizePost({ id: OWNER_ID, role: "editor" }, "delete", draft)).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
  });

  it("passes when allowed", () => {
    expect(() => authorizePost({ id: OWNER_ID, role: "editor" }, "publish", draft)).not.toThrow();
  });
});

describe("global permissions", () => {
  it.each(roles)("%s may create posts and upload media", (role) => {
    const actor = { id: OWNER_ID, role };
    expect(can(actor, "createPost")).toBe(true);
    expect(can(actor, "uploadMedia")).toBe(true);
  });

  it("only admins manage users", () => {
    expect(can({ id: OWNER_ID, role: "author" }, "manageUsers")).toBe(false);
    expect(can({ id: OWNER_ID, role: "editor" }, "manageUsers")).toBe(false);
    expect(can({ id: OWNER_ID, role: "admin" }, "manageUsers")).toBe(true);
  });
});

describe("media deletion", () => {
  const usage = [
    { any: false, live: false },
    { any: true, live: false },
    { any: true, live: true },
  ];

  const expectations: Record<Role, Record<"own" | "other", Array<string | null>>> = {
    author: {
      own: [null, "media_in_use", "media_in_use"],
      other: ["forbidden", "forbidden", "media_in_use"],
    },
    editor: {
      own: [null, "media_in_use", "media_in_use"],
      other: [null, "media_in_use", "media_in_use"],
    },
    admin: {
      own: [null, null, "media_in_use"],
      other: [null, null, "media_in_use"],
    },
  };

  for (const role of roles) {
    for (const ownership of ["own", "other"] as const) {
      it.each(usage.map((u, index) => ({ ...u, index })))(
        `${role} deleting ${ownership} media referenced=$any live=$live`,
        ({ any, live, index }) => {
          const refusal = mediaDeleteRefusal(
            { id: OWNER_ID, role },
            {
              uploadedBy: ownership === "own" ? OWNER_ID : OTHER_ID,
              referencedByAnyRevision: any,
              referencedByLiveRevision: live,
            },
          );
          expect(refusal).toBe(expectations[role][ownership][index]);
        },
      );
    }
  }
});
