"use server";

import { requireUser } from "@/auth/current-user";
import { getMediaStorage } from "@/media/storage-provider";
import { deleteMedia as deleteMediaRecord } from "@/services/media";
import { runAction, type ActionResult } from "./result";
import { deleteMediaSchema } from "./schemas";

export async function deleteMedia(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("deleteMedia", async () => {
    const { mediaId } = deleteMediaSchema.parse(input);
    const actor = await requireUser();
    const deleted = await deleteMediaRecord({ actor, mediaId, storage: getMediaStorage() });
    return { id: deleted.id };
  });
}
