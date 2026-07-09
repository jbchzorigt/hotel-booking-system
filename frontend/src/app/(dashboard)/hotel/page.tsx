"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CalendarClock,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Wallet,
} from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import StaffSection from "@/components/hotel/StaffSection";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { HotelProfile, SubscriptionPlan } from "@/types/api";

const PLAN_LABEL: Record<SubscriptionPlan, string> = {
  "3_MONTHS": "3-month plan",
  "6_MONTHS": "6-month plan",
  "9_MONTHS": "9-month plan",
  "12_MONTHS": "12-month plan",
};

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export default function HotelAdminPage() {
  const [profile, setProfile] = useState<HotelProfile | null>(null);

  useEffect(() => {
    api
      .get<HotelProfile>("/manager/hotel")
      .then(({ data }) => setProfile(data))
      .catch(() =>
        toast({
          variant: "destructive",
          title: "Could not load your hotel profile",
        })
      );
  }, []);

  if (profile === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const daysLeft = daysUntil(profile.subscription_expires_at);
  const expired = daysLeft <= 0;
  const expiringSoon = !expired && daysLeft <= 14;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {profile.name}
          </h2>
          <p className="text-sm text-muted-foreground">
            marketplace slug: <span className="font-mono">{profile.slug}</span>
          </p>
        </div>
        <Badge variant={profile.is_active ? "success" : "destructive"}>
          {profile.is_active ? "Live on marketplace" : "Suspended"}
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---------------- Subscription ---------------- */}
        <Card
          className={
            expired
              ? "border-destructive/50"
              : expiringSoon
                ? "border-amber-300 dark:border-amber-800"
                : undefined
          }
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Subscription
            </CardTitle>
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-semibold tracking-tight">
              {PLAN_LABEL[profile.subscription_plan]}
            </p>
            {expired ? (
              <Badge variant="destructive">
                Expired{" "}
                {new Date(
                  profile.subscription_expires_at
                ).toLocaleDateString()}
              </Badge>
            ) : (
              <p className="text-sm text-muted-foreground">
                <span
                  className={
                    expiringSoon
                      ? "font-semibold text-amber-600 dark:text-amber-400"
                      : "font-semibold text-foreground"
                  }
                >
                  {daysLeft} day{daysLeft === 1 ? "" : "s"}
                </span>{" "}
                remaining · renews by{" "}
                {new Date(
                  profile.subscription_expires_at
                ).toLocaleDateString()}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Started{" "}
              {new Date(profile.subscription_started_at).toLocaleDateString()}
            </p>
          </CardContent>
        </Card>

        {/* ---------------- Wallet ---------------- */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Hotel wallet
            </CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums tracking-tight">
              {formatMNT(profile.wallet_balance)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              95% escrow share credited at guest checkout
            </p>
          </CardContent>
        </Card>

        {/* ---------------- Contact ---------------- */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Property details
            </CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              {profile.contact_email}
            </p>
            {profile.contact_phone && (
              <p className="flex items-center gap-2">
                <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                {profile.contact_phone}
              </p>
            )}
            {profile.address && (
              <p className="flex items-start gap-2 text-muted-foreground">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {profile.address}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- Staff management ---------------- */}
      <StaffSection />

      {/* ---------------- Quick links ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Operations</CardTitle>
          <CardDescription>
            Day-to-day management lives in the manager console.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link
            href="/manager"
            className={buttonVariants({ variant: "outline" })}
          >
            Rooms, minibar & restaurants
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/reception"
            className={buttonVariants({ variant: "outline" })}
          >
            Front desk
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/cleaner"
            className={buttonVariants({ variant: "outline" })}
          >
            Housekeeping
            <ArrowRight className="h-4 w-4" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
