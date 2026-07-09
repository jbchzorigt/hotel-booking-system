"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ClipboardList,
  Loader2,
  LogOut,
  ScrollText,
  ShieldAlert,
  Siren,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/lib/utils";

const LOGIN_PATH = "/police/login";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { href: "/police/watchlist", label: "Watchlist", icon: ClipboardList },
  { href: "/police/alerts", label: "Live Alerts", icon: Siren },
  { href: "/police/audit", label: "Audit Logs", icon: ScrollText },
];

/**
 * Standalone police portal chrome + client guard — the UI counterpart of
 * the backend's `require_police`. It admits ONLY tokens whose realm is
 * "police"; anything else is bounced to the police login. This is UX only:
 * every `/police/*` API call is independently gated server-side by the
 * police DB role, which holds grants no app credential has.
 *
 * The login route is intentionally exempt (you can't require a police token
 * to reach the page that mints one) and renders without the guard/chrome.
 */
export default function PoliceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const realm = useAuthStore((s) => s.realm);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logout = useAuthStore((s) => s.logout);

  const isLoginRoute = pathname === LOGIN_PATH;
  const authedPolice = hasHydrated && isAuthenticated() && realm === "police";

  useEffect(() => {
    if (isLoginRoute) return;
    if (hasHydrated && !(isAuthenticated() && realm === "police")) {
      router.replace(LOGIN_PATH);
    }
  }, [isLoginRoute, hasHydrated, isAuthenticated, realm, router]);

  // The login page owns its own full-screen layout — render it bare.
  if (isLoginRoute) return <>{children}</>;

  if (!authedPolice) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const handleSignOut = () => {
    logout();
    router.replace(LOGIN_PATH);
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2 border-b px-6">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive text-destructive-foreground">
          <ShieldAlert className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-semibold leading-none">Police Portal</p>
          <p className="text-xs text-muted-foreground">Dispatch &amp; Watchlist</p>
        </div>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-destructive text-destructive-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t p-4">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-muted-foreground"
          onClick={handleSignOut}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-muted/40">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r bg-background lg:block">
        {sidebar}
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background px-4 sm:px-6">
          <span className="flex items-center gap-2 lg:hidden">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            <span className="text-sm font-semibold">Police Portal</span>
          </span>
          <span className="ml-auto rounded-full border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            Police realm · on duty
          </span>
        </header>

        {/* Mobile nav */}
        <div className="flex gap-1 border-b bg-background px-2 py-2 lg:hidden">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium",
                  active
                    ? "bg-destructive text-destructive-foreground"
                    : "text-muted-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Link>
            );
          })}
        </div>

        <main className="p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
