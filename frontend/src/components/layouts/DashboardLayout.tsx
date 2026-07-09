"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BedDouble,
  CalendarCheck,
  ChefHat,
  Hotel,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuthStore, type UserRole } from "@/store/authStore";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV_BY_ROLE: Record<UserRole, NavItem[]> = {
  PLATFORM_ADMIN: [
    { href: "/admin", label: "Overview", icon: LayoutDashboard },
  ],
  HOTEL_ADMIN: [
    { href: "/hotel", label: "Overview", icon: LayoutDashboard },
    { href: "/manager", label: "Management", icon: BedDouble },
    { href: "/reception", label: "Front Desk", icon: CalendarCheck },
    { href: "/cleaner", label: "Housekeeping", icon: Sparkles },
  ],
  MANAGER: [
    { href: "/manager", label: "Management", icon: LayoutDashboard },
    { href: "/reception", label: "Front Desk", icon: CalendarCheck },
    { href: "/cleaner", label: "Housekeeping", icon: Sparkles },
  ],
  RECEPTION: [
    { href: "/reception", label: "Front Desk", icon: LayoutDashboard },
  ],
  CLEANER: [
    { href: "/cleaner", label: "My Rooms", icon: Sparkles },
  ],
  RESTAURANT_OWNER: [
    { href: "/restaurant", label: "Orders & Menu", icon: ChefHat },
  ],
};

const ROLE_LABEL: Record<UserRole, string> = {
  PLATFORM_ADMIN: "Platform Admin",
  HOTEL_ADMIN: "Hotel Admin",
  MANAGER: "Manager",
  RECEPTION: "Reception",
  CLEANER: "Housekeeping",
  RESTAURANT_OWNER: "Restaurant Owner",
};

function isActive(pathname: string, href: string, navRoot: string): boolean {
  // The section root is active only on exact match so it doesn't stay
  // highlighted for every child route.
  return href === navRoot ? pathname === href : pathname.startsWith(href);
}

/**
 * Authenticated chrome for staff/admin realms: role-aware sidebar,
 * header with identity + sign-out, and a client-side auth guard.
 *
 * The guard is UX only — the API enforces authorization on every call.
 * It waits for the persisted store to rehydrate before deciding, so a
 * hard refresh doesn't bounce a valid session to /login.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const role = useAuthStore((s) => s.role);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logout = useAuthStore((s) => s.logout);

  const authed = hasHydrated && isAuthenticated();

  useEffect(() => {
    if (hasHydrated && !isAuthenticated()) {
      const next = encodeURIComponent(pathname);
      router.replace(`/login?next=${next}`);
    }
  }, [hasHydrated, isAuthenticated, pathname, router]);

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  if (!authed || !role) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const navItems = NAV_BY_ROLE[role];
  const navRoot = navItems[0].href;

  const handleLogout = () => {
    logout();
    router.replace("/login");
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2 border-b px-6">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Hotel className="h-4 w-4" />
        </span>
        <span className="text-lg font-semibold tracking-tight">Stayline</span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-4">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive(pathname, href, navRoot)
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>

      <div className="border-t p-4">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-muted-foreground"
          onClick={handleLogout}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-muted/40">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r bg-background lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 w-64 border-r bg-background shadow-xl">
            <button
              className="absolute right-3 top-5 text-muted-foreground hover:text-foreground"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <h1 className="text-sm font-semibold sm:text-base">
              {navItems.find(({ href }) => isActive(pathname, href, navRoot))
                ?.label ?? ROLE_LABEL[role]}
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden rounded-full border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground sm:inline-block">
              {ROLE_LABEL[role]}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              aria-label="Sign out"
              className="sm:hidden"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <main className="p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
