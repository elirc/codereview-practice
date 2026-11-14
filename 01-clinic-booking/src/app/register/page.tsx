import { redirect } from "next/navigation";
import { getPageActor } from "@/server/auth/page";
import { RegisterForm } from "./RegisterForm";

export default async function RegisterPage() {
  if (await getPageActor()) redirect("/");
  return (
    <>
      <h1>Create a patient account</h1>
      <RegisterForm />
    </>
  );
}
