import type { Role } from "@prisma/client";
import { clock } from "../clock";
import { forbidden, unauthenticated } from "../errors";
import type { Actor } from "./actor";
import { readCookie, resolveSession, SESSION_COOKIE } from "./session";

export async function requireActor(req: Request): Promise<Actor> {
  const actor = await resolveSession(readCookie(req, SESSION_COOKIE), clock.now());
  if (!actor) throw unauthenticated();
  return actor;
}

export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) throw forbidden();
}
