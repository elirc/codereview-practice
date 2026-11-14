import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getPageActor } from "@/server/auth/page";
import { LogoutButton } from "./_components/LogoutButton";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clinic Booking",
  description: "Book, reschedule and manage clinic appointments.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const actor = await getPageActor();

  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            Clinic Booking
          </Link>
          <nav>
            {actor?.role === "PATIENT" && (
              <>
                <Link href="/book">Book</Link>
                <Link href="/appointments">My appointments</Link>
              </>
            )}
            {actor && actor.role !== "PATIENT" && <Link href="/staff/day">Day view</Link>}
            {actor?.role === "ADMIN" && <Link href="/admin">Admin</Link>}
            {actor ? (
              <LogoutButton email={actor.email} />
            ) : (
              <>
                <Link href="/login">Sign in</Link>
                <Link href="/register">Register</Link>
              </>
            )}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
