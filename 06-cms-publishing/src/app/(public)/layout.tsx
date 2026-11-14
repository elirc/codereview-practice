import Link from "next/link";
import type { ReactNode } from "react";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="site">
        <Link href="/">
          <strong>Field Notes</strong>
        </Link>
      </header>
      <main>{children}</main>
    </>
  );
}
