"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogOut, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/store/authStore";

/**
 * Police-realm chrome + client guard — the UI counterpart of the backend's
 * `require_police`. It admits ONLY tokens whose realm is "police"; an
 * app-realm staff/admin token is bounced. This is UX only: every
 * `/police/*` API call is independently gated server-side by the police DB
 * role, which holds grants no app credential has.
 *
 * The guard waits for the persisted store to rehydrate so a hard refresh
 * of a valid police session doesn't flash-redirect to login.
 */
export default function PoliceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const realm = useAuthStore((s) => s.realm);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logout = useAuthStore((s) => s.logout);

  const authedPolice = hasHydrated && isAuthenticated() && realm === "police";

  useEffect(() => {
    if (hasHydrated && !(isAuthenticated() && realm === "police")) {
      router.replace("/login");
    }
  }, [hasHydrated, isAuthenticated, realm, router]);

  if (!hasHydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Authenticated but WRONG realm (an app-realm token): explicit denial
  // rather than a silent redirect, so misrouted staff understand why.
  if (isAuthenticated() && realm !== "police") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <ShieldAlert className="h-10 w-10 text-destructive" />
        <h1 className="text-lg font-semibold">Police realm only</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          This dashboard requires a police-realm credential. Your current
          session belongs to the hotel platform and cannot access police
          match data.
        </p>
        <Button variant="outline" onClick={() => logout()}>
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    );
  }

  if (!authedPolice) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-30 border-b bg-background">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive text-destructive-foreground">
              <ShieldAlert className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold leading-none">
                Dispatch Console
              </p>
              <p className="text-xs text-muted-foreground">
                General Police Department
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              logout();
              router.replace("/login");
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
