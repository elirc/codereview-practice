import { z } from "zod";

export const id = z.string().uuid().toLowerCase();

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, "Use at least 12 characters.").max(200);
const role = z.enum(["author", "editor", "admin"]);

export const loginSchema = z
  .object({
    email,
    password: z.string().min(1).max(200),
  })
  .strict();

export const createUserSchema = z
  .object({
    email,
    name: z.string().trim().min(1).max(100),
    role,
    password,
  })
  .strict();

export const updateUserSchema = z
  .object({
    userId: id,
    name: z.string().trim().min(1).max(100).optional(),
    role: role.optional(),
    active: z.boolean().optional(),
    password: password.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.role !== undefined ||
      value.active !== undefined ||
      value.password !== undefined,
    { message: "Nothing to update." },
  );

export const slug = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lower-case letters, digits and single hyphens.");

export const expectedVersion = z.number().int().positive();

const title = z.string().trim().min(1, "A title is required.").max(200);

export const createPostSchema = z.object({ slug, title }).strict();

export const saveRevisionSchema = z
  .object({
    postId: id,
    expectedVersion,
    title,
    excerpt: z.string().max(500).default(""),
    body: z.string().max(200_000).default(""),
    coverMediaId: id.nullable().default(null),
  })
  .strict();

export const restoreRevisionSchema = z
  .object({ postId: id, revisionId: id, expectedVersion })
  .strict();

export const postCommandSchema = z.object({ postId: id, expectedVersion }).strict();

export const publishSchema = z.object({ postId: id, revisionId: id, expectedVersion }).strict();

export const scheduleSchema = z
  .object({
    postId: id,
    revisionId: id,
    expectedVersion,
    scheduledFor: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value)),
  })
  .strict();

export const changeSlugSchema = z.object({ postId: id, expectedVersion, slug }).strict();

export const duplicatePostSchema = z.object({ postId: id, slug }).strict();

export const deleteMediaSchema = z.object({ mediaId: id }).strict();

export const previewQuerySchema = z.object({ postId: id, revisionId: id }).strict();
