"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isAxiosError } from "axios";
import { Eye, EyeOff, Loader2, ShieldAlert } from "lucide-react";

import api from "@/lib/axios";
import { useAuthStore } from "@/store/authStore";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PoliceLoginResponse } from "@/types/api";

export default function PoliceLoginPage() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const realm = useAuthStore((s) => s.realm);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [badge, setBadge] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in as police → skip the form.
  useEffect(() => {
    if (hasHydrated && isAuthenticated() && realm === "police") {
      router.replace("/police/watchlist");
    }
  }, [hasHydrated, isAuthenticated, realm, router]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await api.post<PoliceLoginResponse>("/police/login", {
        badge_number: badge.trim(),
        password,
      });
      // The store derives realm/role from the token's own claims.
      login(data.access_token);
      router.replace("/police/watchlist");
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 401) {
        setError("Invalid badge number or password.");
      } else if (isAxiosError(err) && err.response?.status === 422) {
        setError("Enter a valid badge number and an 8+ character password.");
      } else {
        setError("Something went wrong. Please try again.");
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-destructive text-destructive-foreground shadow-sm">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">
            Police Portal
          </h1>
          <p className="text-xs text-muted-foreground">
            General Police Department · restricted access
          </p>
        </div>

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-lg">Officer sign in</CardTitle>
            <CardDescription>Badge number and password</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="badge">Badge number</Label>
                <Input
                  id="badge"
                  autoComplete="username"
                  placeholder="P-1000"
                  value={badge}
                  onChange={(e) => setBadge(e.target.value)}
                  required
                  autoFocus
                  disabled={submitting}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    disabled={submitting}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </p>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={submitting || !badge || !password}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          This portal is isolated from the hotel platform. Accounts are
          issued by the department.
        </p>
      </div>
    </div>
  );
}
