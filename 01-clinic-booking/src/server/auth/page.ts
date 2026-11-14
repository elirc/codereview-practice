import type { Role } from "@prisma/client";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clock } from "../clock";
import type { Actor } from "./actor";
import { resolveSession, SESSION_COOKIE } from "./session";

/** The signed-in user for a server component, or null. */
export async function getPageActor(): Promise<Actor | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value, clock.now());
}

/** Redirects to the login page when signed out, and home when the role may not see the page. */
export async function requirePageActor(...roles: Role[]): Promise<Actor> {
  const actor = await getPageActor();
  if (!actor) redirect("/login");
  if (roles.length > 0 && !roles.includes(actor.role)) redirect("/");
  return actor;
}
