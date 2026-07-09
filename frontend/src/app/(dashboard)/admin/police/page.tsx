"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BellRing,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import api from "@/lib/axios";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdminPoliceAlert, PoliceMatchStatus } from "@/types/api";

const STATUS_BADGE: Record<
  PoliceMatchStatus,
  { label: string; variant: "destructive" | "success" | "secondary" }
> = {
  PENDING_REVIEW: { label: "PENDING REVIEW", variant: "destructive" },
  CONFIRMED: { label: "Confirmed", variant: "success" },
  DISMISSED: { label: "Dismissed", variant: "secondary" },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminPoliceAlertsPage() {
  const [alerts, setAlerts] = useState<AdminPoliceAlert[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<AdminPoliceAlert[]>(
        "/admin/police-alerts"
      );
      setAlerts(data);
    } catch {
      toast({
        variant: "destructive",
        title: "Could not load police alerts",
        description: "Check your connection and retry.",
      });
      setAlerts((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pendingCount = useMemo(
    () => (alerts ?? []).filter((a) => a.status === "PENDING_REVIEW").length,
    [alerts]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Police Alerts
          </h2>
          <p className="text-sm text-muted-foreground">
            Redacted oversight of wanted-person matches — enough to confirm
            screening is working and where a hit occurred.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Provenance note: this is metadata only; dispatch lives elsewhere. */}
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Operator view — no registry number or identity document is exposed
          (matching runs on a salted hash the platform never sees). Case
          handling and dispatch are the police realm&apos;s own, separately
          credentialed responsibility.
        </span>
      </div>

      {pendingCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
          <BellRing className="h-4 w-4 shrink-0" />
          {pendingCount} match{pendingCount === 1 ? "" : "es"} awaiting police
          review.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            Match feed
          </CardTitle>
          <CardDescription>
            Newest first. Guest name is what was given at check-in and may be
            an alias.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {alerts === null ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : alerts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <ShieldCheck className="h-8 w-8 text-emerald-500" />
              <p className="font-medium">No matches</p>
              <p className="text-sm text-muted-foreground">
                No wanted-person matches have been recorded.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Guest name</TableHead>
                  <TableHead>Booking</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Match reason</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((alert) => {
                  const badge = STATUS_BADGE[alert.status] ?? {
                    label: alert.status,
                    variant: "secondary" as const,
                  };
                  const pending = alert.status === "PENDING_REVIEW";
                  return (
                    <TableRow
                      key={alert.match_id}
                      className={cn(pending && "bg-destructive/5")}
                    >
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(alert.matched_at)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {alert.guest_full_name}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {alert.booking_code}
                      </TableCell>
                      <TableCell>
                        <span className="block font-medium">
                          {alert.hotel_name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Room {alert.room_number}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="block font-medium">
                          {alert.wanted_full_name}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {alert.case_reference ?? "no case ref."}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
