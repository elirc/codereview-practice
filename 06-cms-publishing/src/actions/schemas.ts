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
