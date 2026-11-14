import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/services/errors";
import { getCurrentUser } from "./current-user";
import type { SessionUser } from "./session";

/** The signed-in user for an admin page; redirects to the login page otherwise. */
export async function requirePageUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/admin/login");
  return user;
}

/** Awaits a loader and turns its `not_found` error into the framework's 404 page. */
export async function orNotFound<T>(load: Promise<T>): Promise<T> {
  try {
    return await load;
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_found") notFound();
    throw err;
  }
}
