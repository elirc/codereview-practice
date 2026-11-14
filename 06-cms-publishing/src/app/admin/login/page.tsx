import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/current-user";
import { LoginForm } from "../_components/login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/admin/posts");
  return (
    <>
      <h1>Sign in</h1>
      <LoginForm />
    </>
  );
}
