CREATE TYPE "public"."post_status" AS ENUM('draft', 'in_review', 'scheduled', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('author', 'editor', 'admin');--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "media_content_type_allowed" CHECK ("media"."content_type" IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf')),
	CONSTRAINT "media_size_range" CHECK ("media"."size_bytes" BETWEEN 1 AND 10485760),
	CONSTRAINT "media_filename_length" CHECK (char_length("media"."original_filename") BETWEEN 1 AND 200),
	CONSTRAINT "media_sha256_format" CHECK ("media"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"author_id" uuid NOT NULL,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"latest_revision_id" uuid,
	"published_revision_id" uuid,
	"scheduled_revision_id" uuid,
	"scheduled_for" timestamp with time zone,
	"first_published_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_slug_unique" UNIQUE("slug"),
	CONSTRAINT "posts_slug_format" CHECK ("posts"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length("posts"."slug") <= 120),
	CONSTRAINT "posts_scheduled_fields" CHECK (("posts"."status" = 'scheduled') = ("posts"."scheduled_for" IS NOT NULL AND "posts"."scheduled_revision_id" IS NOT NULL)),
	CONSTRAINT "posts_schedule_fields_paired" CHECK (("posts"."scheduled_for" IS NULL) = ("posts"."scheduled_revision_id" IS NULL)),
	CONSTRAINT "posts_published_has_revision" CHECK ("posts"."status" <> 'published' OR "posts"."published_revision_id" IS NOT NULL),
	CONSTRAINT "posts_published_revision_visible" CHECK ("posts"."published_revision_id" IS NULL OR "posts"."status" IN ('published', 'scheduled')),
	CONSTRAINT "posts_published_at_paired" CHECK (("posts"."published_at" IS NULL) = ("posts"."published_revision_id" IS NULL)),
	CONSTRAINT "posts_version_positive" CHECK ("posts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "revision_media" (
	"revision_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	CONSTRAINT "revision_media_revision_id_media_id_pk" PRIMARY KEY("revision_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"cover_media_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_from_number" integer,
	CONSTRAINT "revisions_post_number_unique" UNIQUE("post_id","number"),
	CONSTRAINT "revisions_id_post_unique" UNIQUE("id","post_id"),
	CONSTRAINT "revisions_number_positive" CHECK ("revisions"."number" > 0),
	CONSTRAINT "revisions_title_length" CHECK (char_length("revisions"."title") BETWEEN 1 AND 200),
	CONSTRAINT "revisions_excerpt_length" CHECK (char_length("revisions"."excerpt") <= 500),
	CONSTRAINT "revisions_body_length" CHECK (char_length("revisions"."body") <= 200000)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "slug_redirects" (
	"old_slug" text PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_latest_revision_fk" FOREIGN KEY ("latest_revision_id","id") REFERENCES "public"."revisions"("id","post_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_published_revision_fk" FOREIGN KEY ("published_revision_id","id") REFERENCES "public"."revisions"("id","post_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_scheduled_revision_fk" FOREIGN KEY ("scheduled_revision_id","id") REFERENCES "public"."revisions"("id","post_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_media" ADD CONSTRAINT "revision_media_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_media" ADD CONSTRAINT "revision_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slug_redirects" ADD CONSTRAINT "slug_redirects_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_status_scheduled_for_idx" ON "posts" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "posts_author_id_idx" ON "posts" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "posts_published_at_idx" ON "posts" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "revision_media_media_id_idx" ON "revision_media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "slug_redirects_post_id_idx" ON "slug_redirects" USING btree ("post_id");
