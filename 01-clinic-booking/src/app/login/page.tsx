import Link from "next/link";
import { redirect } from "next/navigation";
import { getPageActor } from "@/server/auth/page";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  if (await getPageActor()) redirect("/");
  return (
    <>
      <h1>Sign in</h1>
      <LoginForm />
      <p>
        New patient? <Link href="/register">Create an account</Link>.
      </p>
    </>
  );
}
