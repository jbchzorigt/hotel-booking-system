import Link from "next/link";
import { Hotel } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

/**
 * Clean B2C marketplace shell — modern navbar + footer, no dashboard or
 * police chrome. Public and unauthenticated; guests browse and book
 * anonymously (identity is confirmed via e-Mongolia only at checkout).
 */
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Hotel className="h-4 w-4" />
            </span>
            <span className="text-lg font-semibold tracking-tight">
              Stayline
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link
              href="/"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Stays
            </Link>
            <Link
              href="/join"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              List your hotel
            </Link>
            <Link
              href="/login"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Staff sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t bg-muted/30">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-8 sm:flex-row sm:px-6 lg:px-8">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Hotel className="h-4 w-4" />
            <span>© {new Date().getFullYear()} Stayline · Ulaanbaatar</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Escrow-protected payments · Verified check-in · Powered by QPay &amp;
            e-Mongolia
          </p>
        </div>
      </footer>
    </div>
  );
}
