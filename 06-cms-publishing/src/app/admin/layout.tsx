import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/auth/current-user";
import { can } from "@/auth/policy";
import { LogoutButton } from "./_components/logout-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Admin" },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  return (
    <>
      {user && (
        <nav className="admin">
          <strong>Field Notes admin</strong>
          <Link href="/admin/posts">Posts</Link>
          <Link href="/admin/media">Media</Link>
          {can(user, "manageUsers") && <Link href="/admin/users">Users</Link>}
          <span className="spacer" />
          <span className="muted">
            {user.name} ({user.role})
          </span>
          <LogoutButton />
        </nav>
      )}
      <main>{children}</main>
    </>
  );
}
