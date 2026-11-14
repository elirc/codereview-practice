import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { and, eq } from "drizzle-orm";
import type { Actor } from "@/auth/policy";
import { closeDb, db } from "@/db/client";
import { media, posts, slugRedirects, users, type Role } from "@/db/schema";
import { logger } from "@/logger";
import { getMediaStorage } from "@/media/storage-provider";
import { ingestUpload } from "@/media/upload";
import { clock } from "@/services/clock";
import { changeSlug, createPost } from "@/services/posts";
import { saveRevision } from "@/services/revisions";
import * as workflow from "@/services/workflow";
import { createUser } from "@/services/users";

const PASSWORD = "field-notes-dev-password";

const ACCOUNTS: Array<{ key: string; email: string; name: string; role: Role }> = [
  { key: "admin", email: "admin@example.com", name: "Ada Admin", role: "admin" },
  { key: "editor", email: "editor@example.com", name: "Eli Editor", role: "editor" },
  { key: "author", email: "author@example.com", name: "Ana Author", role: "author" },
  { key: "author2", email: "author2@example.com", name: "Sam Writer", role: "author" },
];

type PostSeed = {
  slug: string;
  author: string;
  titles: string[];
  state: "draft" | "in_review" | "published" | "published_with_draft" | "scheduled" | "archived";
  renameTo?: string;
  withCover?: boolean;
};

const POSTS: PostSeed[] = [
  {
    slug: "welcome-to-field-notes",
    author: "author",
    titles: ["Welcome", "Welcome to Field Notes"],
    state: "published",
    withCover: true,
  },
  {
    slug: "spring-garden-notes",
    author: "author",
    titles: ["Spring garden notes", "Spring garden notes (revised)"],
    state: "published_with_draft",
  },
  {
    slug: "community-meetup-recap",
    author: "author",
    titles: ["Community meetup recap"],
    state: "in_review",
  },
  {
    slug: "upcoming-release-plan",
    author: "author2",
    titles: ["Upcoming release plan"],
    state: "scheduled",
  },
  {
    slug: "notes-on-typography",
    author: "author2",
    titles: ["Notes on typography"],
    state: "draft",
  },
  {
    slug: "old-announcement",
    author: "author2",
    titles: ["Old announcement"],
    state: "archived",
  },
  {
    slug: "getting-started",
    author: "author",
    titles: ["Getting started"],
    state: "published",
    renameTo: "getting-started-guide",
  },
];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A small solid-colour PNG so the media library and cover images have something to show. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  const pixels = deflateSync(Buffer.concat(Array(height).fill(row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", new Uint8Array()),
  ]);
}

async function ensureUsers(): Promise<Record<string, Actor>> {
  const actors: Record<string, Actor> = {};
  for (const account of ACCOUNTS) {
    const [existing] = await db.select().from(users).where(eq(users.email, account.email));
    const user =
      existing ??
      (await createUser({
        email: account.email,
        name: account.name,
        role: account.role,
        password: PASSWORD,
      }));
    actors[account.key] = { id: user.id, role: user.role };
  }
  return actors;
}

async function ensureCover(admin: Actor): Promise<string | null> {
  const filename = "seed-cover.png";
  const [existing] = await db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.originalFilename, filename), eq(media.uploadedBy, admin.id)));
  if (existing) return existing.id;
  try {
    const stored = await ingestUpload(
      { filename, bytes: solidPng(48, 32, [46, 125, 50]) },
      admin.id,
      { storage: getMediaStorage(), now: clock.now(), newId: randomUUID },
    );
    return stored.id;
  } catch (err) {
    logger.warn({ err }, "could not store the seed cover image; is object storage running?");
    return null;
  }
}

async function slugInUse(slug: string): Promise<boolean> {
  const [post] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, slug));
  const [redirect] = await db
    .select({ postId: slugRedirects.postId })
    .from(slugRedirects)
    .where(eq(slugRedirects.oldSlug, slug));
  return post !== undefined || redirect !== undefined;
}

async function seedPost(seed: PostSeed, actors: Record<string, Actor>, coverId: string | null) {
  if (await slugInUse(seed.slug)) return;
  const author = actors[seed.author];
  const editor = actors.editor;
  const now = clock.now();

  let post = await createPost({ actor: author, slug: seed.slug, title: seed.titles[0], now });
  for (const [index, title] of seed.titles.entries()) {
    const saved = await saveRevision({
      actor: author,
      postId: post.id,
      expectedVersion: post.version,
      content: {
        title,
        excerpt: `${title}: a short summary for the front page.`,
        body: `## ${title}\n\nRevision ${index + 1} of this post.\n\n- one point\n- another\n`,
        coverMediaId: seed.withCover ? coverId : null,
      },
      now,
    });
    post = saved.post;
  }

  const command = () => ({ actor: editor, postId: post.id, expectedVersion: post.version, now });
  const publishLatest = async () => {
    const outcome = await workflow.publishPost({
      ...command(),
      revisionId: post.latestRevisionId!,
    });
    post = outcome.post;
  };

  switch (seed.state) {
    case "in_review":
      post = (await workflow.submitForReview(command())).post;
      break;
    case "published":
      await publishLatest();
      break;
    case "published_with_draft": {
      const [first] = seed.titles;
      await publishLatest();
      post = (
        await saveRevision({
          actor: author,
          postId: post.id,
          expectedVersion: post.version,
          content: {
            title: `${first} (draft)`,
            excerpt: "",
            body: "Unpublished edits.",
            coverMediaId: null,
          },
          now,
        })
      ).post;
      break;
    }
    case "scheduled":
      post = (
        await workflow.schedulePost({
          ...command(),
          revisionId: post.latestRevisionId!,
          scheduledFor: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
        })
      ).post;
      break;
    case "archived":
      post = (await workflow.archivePost(command())).post;
      break;
    case "draft":
      break;
  }

  if (seed.renameTo) {
    await changeSlug({ ...command(), slug: seed.renameTo });
  }
}

async function main() {
  const actors = await ensureUsers();
  const coverId = await ensureCover(actors.admin);
  for (const seed of POSTS) await seedPost(seed, actors, coverId);
  logger.info({ users: ACCOUNTS.length, posts: POSTS.length }, "seed complete");
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "seed failed");
    process.exitCode = 1;
  })
  .finally(() => closeDb());
