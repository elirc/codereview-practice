import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["author", "editor", "admin"]);

export const postStatus = pgEnum("post_status", [
  "draft",
  "in_review",
  "scheduled",
  "published",
  "archived",
]);

export type Role = (typeof userRole.enumValues)[number];
export type PostStatus = (typeof postStatus.enumValues)[number];

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [check("users_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    status: postStatus("status").notNull().default("draft"),
    latestRevisionId: uuid("latest_revision_id"),
    publishedRevisionId: uuid("published_revision_id"),
    scheduledRevisionId: uuid("scheduled_revision_id"),
    scheduledFor: timestamptz("scheduled_for"),
    firstPublishedAt: timestamptz("first_published_at"),
    publishedAt: timestamptz("published_at"),
    version: integer("version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "posts_slug_format",
      sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(${t.slug}) <= 120`,
    ),
    check(
      "posts_scheduled_fields",
      sql`(${t.status} = 'scheduled') = (${t.scheduledFor} IS NOT NULL AND ${t.scheduledRevisionId} IS NOT NULL)`,
    ),
    check(
      "posts_schedule_fields_paired",
      sql`(${t.scheduledFor} IS NULL) = (${t.scheduledRevisionId} IS NULL)`,
    ),
    check(
      "posts_published_has_revision",
      sql`${t.status} <> 'published' OR ${t.publishedRevisionId} IS NOT NULL`,
    ),
    check(
      "posts_published_revision_visible",
      sql`${t.publishedRevisionId} IS NULL OR ${t.status} IN ('published', 'scheduled')`,
    ),
    check(
      "posts_published_at_paired",
      sql`(${t.publishedAt} IS NULL) = (${t.publishedRevisionId} IS NULL)`,
    ),
    check("posts_version_positive", sql`${t.version} > 0`),
    foreignKey({
      name: "posts_latest_revision_fk",
      columns: [t.latestRevisionId, t.id],
      foreignColumns: [revisions.id, revisions.postId],
    }),
    foreignKey({
      name: "posts_published_revision_fk",
      columns: [t.publishedRevisionId, t.id],
      foreignColumns: [revisions.id, revisions.postId],
    }),
    foreignKey({
      name: "posts_scheduled_revision_fk",
      columns: [t.scheduledRevisionId, t.id],
      foreignColumns: [revisions.id, revisions.postId],
    }),
    index("posts_status_scheduled_for_idx").on(t.status, t.scheduledFor),
    index("posts_author_id_idx").on(t.authorId),
    index("posts_published_at_idx").on(t.publishedAt),
  ],
);

export const revisions = pgTable(
  "revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references((): AnyPgColumn => posts.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull().default(""),
    body: text("body").notNull().default(""),
    // Not a foreign key: revisions are immutable, and media rows may be removed by an admin.
    coverMediaId: uuid("cover_media_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    restoredFromNumber: integer("restored_from_number"),
  },
  (t) => [
    unique("revisions_post_number_unique").on(t.postId, t.number),
    unique("revisions_id_post_unique").on(t.id, t.postId),
    check("revisions_number_positive", sql`${t.number} > 0`),
    check("revisions_title_length", sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check("revisions_excerpt_length", sql`char_length(${t.excerpt}) <= 500`),
    check("revisions_body_length", sql`char_length(${t.body}) <= 200000`),
  ],
);

export const slugRedirects = pgTable(
  "slug_redirects",
  {
    oldSlug: text("old_slug").primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("slug_redirects_post_id_idx").on(t.postId)],
);

export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storageKey: text("storage_key").notNull().unique(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "media_content_type_allowed",
      sql`${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf')`,
    ),
    check("media_size_range", sql`${t.sizeBytes} BETWEEN 1 AND 10485760`),
    check("media_filename_length", sql`char_length(${t.originalFilename}) BETWEEN 1 AND 200`),
    check("media_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const revisionMedia = pgTable(
  "revision_media",
  {
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.revisionId, t.mediaId] }),
    index("revision_media_media_id_idx").on(t.mediaId),
  ],
);

export type User = typeof users.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type Revision = typeof revisions.$inferSelect;
export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
