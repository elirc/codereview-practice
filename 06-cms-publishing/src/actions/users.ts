"use server";

import { requireUser } from "@/auth/current-user";
import { assertCan } from "@/auth/policy";
import { createUser as createUserRecord, updateUser as updateUserRecord } from "@/services/users";
import type { PublicUser } from "@/services/users";
import { runAction, type ActionResult } from "./result";
import { createUserSchema, updateUserSchema } from "./schemas";

export async function createUser(input: unknown): Promise<ActionResult<PublicUser>> {
  return runAction("createUser", async () => {
    const data = createUserSchema.parse(input);
    const actor = await requireUser();
    assertCan(actor, "manageUsers");
    return createUserRecord(data);
  });
}

export async function updateUser(input: unknown): Promise<ActionResult<PublicUser>> {
  return runAction("updateUser", async () => {
    const data = updateUserSchema.parse(input);
    const actor = await requireUser();
    assertCan(actor, "manageUsers");
    return updateUserRecord(data);
  });
}
