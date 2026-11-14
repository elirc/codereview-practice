"use client";

import { useRouter } from "next/navigation";
import { apiRequest } from "./api";

export function LogoutButton({ email }: { email: string }) {
  const router = useRouter();

  async function logout() {
    await apiRequest("/api/auth/logout");
    router.push("/login");
    router.refresh();
  }

  return (
    <span className="account">
      {email}{" "}
      <button type="button" className="link" onClick={logout}>
        Sign out
      </button>
    </span>
  );
}
