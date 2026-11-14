import { redirect } from "next/navigation";
import { getPageActor } from "@/server/auth/page";

export default async function HomePage() {
  const actor = await getPageActor();
  if (!actor) redirect("/login");
  if (actor.role === "PATIENT") redirect("/appointments");
  if (actor.role === "ADMIN") redirect("/admin");
  redirect("/staff/day");
}
