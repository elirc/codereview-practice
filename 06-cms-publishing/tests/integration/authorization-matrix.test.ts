import { describe, expect, it } from "vitest";
import {
  changeSlug,
  createPost,
  deletePost,
  restoreRevision,
  saveRevision,
} from "@/actions/posts";
import type { ActionResult } from "@/actions/result";
import { createUser } from "@/actions/users";
import {
  archivePost,
  cancelSchedule,
  publishPost,
  schedulePost,
  submitForReview,
  unarchivePost,
  unpublishPost,
  withdrawFromReview,
} from "@/actions/workflow";
import { db } from "@/db/client";
import { posts, users } from "@/db/schema";
import { revalidatedTags } from "./support/fake-next-cache";
import {
  FIXED_NOW,
  createTestUser,
  secondsAfter,
  signInAs,
  signOut,
  type TestUser,
} from "./support/fixtures";
import { addRevision, getPost, getRevisions, makePost, snapshotPost } from "./support/records";
import { toState } from "./support/states";

type ActorKey = "owner" | "otherAuthor" | "editor" | "admin" | "anonymous";
type Outcome = "ok" | "unauthenticated" | "forbidden" | "not_found";
type Scene = Record<Exclude<ActorKey, "anonymous">, TestUser> & {
  postId: string;
  version: number;
  firstRevisionId: string;
  latestRevisionId: string;
};

type PostScenario = {
  name: string;
  setup?: (scene: Omit<Scene, "version" | "latestRevisionId">) => Promise<void>;
  call: (scene: Scene) => Promise<ActionResult<unknown>>;
  expected: Record<ActorKey, Outcome>;
};

const actorKeys: ActorKey[] = ["owner", "otherAuthor", "editor", "admin", "anonymous"];

function staffOnly(): Record<ActorKey, Outcome> {
  return {
    owner: "forbidden",
    otherAuthor: "not_found",
    editor: "ok",
    admin: "ok",
    anonymous: "unauthenticated",
  };
}

function ownerOrStaff(): Record<ActorKey, Outcome> {
  return {
    owner: "ok",
    otherAuthor: "not_found",
    editor: "ok",
    admin: "ok",
    anonymous: "unauthenticated",
  };
}

const cmd = (scene: Scene) => ({ postId: scene.postId, expectedVersion: scene.version });
const later = () => secondsAfter(FIXED_NOW, 7200).toISOString();

const postScenarios: PostScenario[] = [
  {
    name: "saveRevision on a draft",
    call: (s) => saveRevision({ ...cmd(s), title: "Changed", body: "changed body" }),
    expected: ownerOrStaff(),
  },
  {
    name: "saveRevision on an archived post",
    setup: (s) => toState.archived(s.editor, s.postId),
    call: (s) => saveRevision({ ...cmd(s), title: "Changed", body: "changed body" }),
    expected: { ...ownerOrStaff(), owner: "forbidden" },
  },
  {
    name: "restoreRevision",
    call: (s) => restoreRevision({ ...cmd(s), revisionId: s.firstRevisionId }),
    expected: ownerOrStaff(),
  },
  {
    name: "submitForReview",
    call: (s) => submitForReview(cmd(s)),
    expected: ownerOrStaff(),
  },
  {
    name: "withdrawFromReview",
    setup: (s) => toState.inReview(s.editor, s.postId),
    call: (s) => withdrawFromReview(cmd(s)),
    expected: ownerOrStaff(),
  },
  {
    name: "publishPost",
    setup: (s) => toState.inReview(s.editor, s.postId),
    call: (s) => publishPost({ ...cmd(s), revisionId: s.latestRevisionId }),
    expected: staffOnly(),
  },
  {
    name: "schedulePost",
    call: (s) => schedulePost({ ...cmd(s), revisionId: s.latestRevisionId, scheduledFor: later() }),
    expected: staffOnly(),
  },
  {
    name: "cancelSchedule",
    setup: (s) => toState.scheduled(s.editor, s.postId),
    call: (s) => cancelSchedule(cmd(s)),
    expected: staffOnly(),
  },
  {
    name: "unpublishPost",
    setup: (s) => toState.published(s.editor, s.postId),
    call: (s) => unpublishPost(cmd(s)),
    expected: staffOnly(),
  },
  {
    name: "archivePost",
    call: (s) => archivePost(cmd(s)),
    expected: staffOnly(),
  },
  {
    name: "unarchivePost",
    setup: (s) => toState.archived(s.editor, s.postId),
    call: (s) => unarchivePost(cmd(s)),
    expected: staffOnly(),
  },
  {
    name: "changeSlug on a never-published post",
    call: (s) => changeSlug({ ...cmd(s), slug: "renamed-post" }),
    expected: ownerOrStaff(),
  },
  {
    name: "changeSlug on a once-published post",
    setup: (s) => toState.unpublished(s.editor, s.postId),
    call: (s) => changeSlug({ ...cmd(s), slug: "renamed-post" }),
    expected: { ...ownerOrStaff(), owner: "forbidden" },
  },
  {
    name: "deletePost on a never-published post",
    call: (s) => deletePost(cmd(s)),
    expected: { ...ownerOrStaff(), editor: "forbidden" },
  },
  {
    name: "deletePost on a published post",
    setup: (s) => toState.published(s.editor, s.postId),
    call: (s) => deletePost(cmd(s)),
    expected: { ...staffOnly(), editor: "forbidden" },
  },
];

async function buildScene(setup?: PostScenario["setup"]): Promise<Scene> {
  const owner = await createTestUser("author");
  const otherAuthor = await createTestUser("author");
  const editor = await createTestUser("editor");
  const admin = await createTestUser("admin");
  const post = await makePost(owner, "matrix-post");
  await addRevision(owner, post.id, { title: "Second", body: "second body" });
  const base = {
    owner,
    otherAuthor,
    editor,
    admin,
    postId: post.id,
    firstRevisionId: post.latestRevisionId!,
  };
  await setup?.(base);
  const current = await getPost(post.id);
  return { ...base, version: current.version, latestRevisionId: current.latestRevisionId! };
}

async function actAs(scene: Scene, key: ActorKey) {
  if (key === "anonymous") signOut();
  else await signInAs(scene[key]);
}

describe("authorisation of post actions", () => {
  for (const scenario of postScenarios) {
    describe(scenario.name, () => {
      it.each(actorKeys)("as %s", async (key) => {
        const scene = await buildScene(scenario.setup);
        const before = await snapshotPost(scene.postId);
        const tagsBefore = revalidatedTags.length;

        await actAs(scene, key);
        const result = await scenario.call(scene);

        const outcome = result.ok ? "ok" : result.error.code;
        expect(outcome).toBe(scenario.expected[key]);
        if (!result.ok) {
          expect(await snapshotPost(scene.postId)).toEqual(before);
          expect(revalidatedTags.length).toBe(tagsBefore);
        }
      });
    });
  }
});

describe("authorisation of non-post actions", () => {
  it.each([
    ["author", "ok"],
    ["editor", "ok"],
    ["admin", "ok"],
    ["anonymous", "unauthenticated"],
  ] as const)("createPost as %s → %s", async (role, expected) => {
    if (role !== "anonymous") await signInAs(await createTestUser(role));
    const before = (await db.select().from(posts)).length;

    const result = await createPost({ slug: "brand-new", title: "Brand new" });

    expect(result.ok ? "ok" : result.error.code).toBe(expected);
    const after = (await db.select().from(posts)).length;
    expect(after).toBe(result.ok ? before + 1 : before);
    if (result.ok) expect(await getRevisions(result.data.id)).toHaveLength(1);
  });

  it.each([
    ["author", "forbidden"],
    ["editor", "forbidden"],
    ["admin", "ok"],
    ["anonymous", "unauthenticated"],
  ] as const)("createUser as %s → %s", async (role, expected) => {
    if (role !== "anonymous") await signInAs(await createTestUser(role));
    const before = (await db.select().from(users)).length;

    const result = await createUser({
      email: "someone@example.test",
      name: "Someone",
      role: "editor",
      password: "long enough password",
    });

    expect(result.ok ? "ok" : result.error.code).toBe(expected);
    expect((await db.select().from(users)).length).toBe(result.ok ? before + 1 : before);
  });

  it("rejects a session whose user was deactivated before the action", async () => {
    const editor = await createTestUser("editor");
    const author = await createTestUser("author");
    const post = await makePost(author, "victim");
    await signInAs(editor);
    await db.update(users).set({ active: false });

    const result = await publishPost({
      postId: post.id,
      revisionId: post.latestRevisionId!,
      expectedVersion: 1,
    });

    expect(result.ok ? "ok" : result.error.code).toBe("unauthenticated");
    expect((await getPost(post.id)).status).toBe("draft");
  });
});
