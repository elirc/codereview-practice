"use client";

import { useRouter } from "next/navigation";
import { logout } from "@/actions/auth";
import { useActionRunner } from "./use-action";

export function LogoutButton() {
  const router = useRouter();
  const { run, pending } = useActionRunner();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => run(() => logout(), (data) => router.replace(data.redirectTo))}
    >
      Sign out
    </button>
  );
}
