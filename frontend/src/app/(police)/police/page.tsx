"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BellRing,
  Loader2,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";

import api from "@/lib/axios";
import { cn } from "@/lib/utils";
import { useWebSocket } from "@/hooks/useWebSocket";
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
import type {
  PoliceMatch,
  PoliceMatchAlert,
  PoliceMatchStatus,
  PoliceWsEvent,
} from "@/types/api";

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

export default function PoliceDashboardPage() {
  const [matches, setMatches] = useState<PoliceMatch[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<PoliceMatch[]>("/police/matches");
      setMatches(data);
    } catch {
      toast({
        variant: "destructive",
        title: "Could not load match feed",
        description: "Check your connection and retry.",
      });
      setMatches((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // -- Real-time: a new match alert means a wanted guest just checked in --- //
  const handleAlert = useCallback(
    (event: PoliceWsEvent) => {
      if (event.type !== "POLICE_MATCH_ALERT") return;
      const alert = event as PoliceMatchAlert;
      toast({
        variant: "destructive",
        title: `⚠ Match — ${alert.wanted_full_name}`,
        description: `${alert.hotel_name}, Room ${alert.room_number} · booking ${alert.booking_code}`,
      });
      // The alert is a notification, not the full row (no status/dates) —
      // refetch so the table stays authoritative.
      void refresh();
    },
    [refresh]
  );

  const { status: wsStatus } = useWebSocket<PoliceWsEvent>(
    "/ws/police/alerts",
    { onEvent: handleAlert }
  );

  const pendingCount = useMemo(
    () => (matches ?? []).filter((m) => m.status === "PENDING_REVIEW").length,
    [matches]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Wanted-person matches
          </h1>
          <p className="text-sm text-muted-foreground">
            Triggered automatically when a checked-in guest matches the
            wanted-persons registry.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
              wsStatus === "open"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
            )}
          >
            {wsStatus === "open" ? (
              <Wifi className="h-3 w-3" />
            ) : (
              <WifiOff className="h-3 w-3" />
            )}
            {wsStatus === "open" ? "Live feed" : "Reconnecting…"}
          </span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Pending-review banner: the operational priority. */}
      {pendingCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
          <BellRing className="h-4 w-4 shrink-0" />
          {pendingCount} match{pendingCount === 1 ? "" : "es"} awaiting review.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            Match feed
          </CardTitle>
          <CardDescription>
            Newest first. Guest name is what was given at check-in and may be
            an alias; identity is matched on a salted hash, never a plaintext
            registry number.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {matches === null ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : matches.length === 0 ? (
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
                  <TableHead>Wanted name</TableHead>
                  <TableHead>Case ref.</TableHead>
                  <TableHead>Hotel</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.map((match) => {
                  const badge = STATUS_BADGE[match.status];
                  const pending = match.status === "PENDING_REVIEW";
                  return (
                    <TableRow
                      key={match.match_id}
                      className={cn(pending && "bg-destructive/5")}
                    >
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(match.matched_at)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {match.guest_full_name}
                      </TableCell>
                      <TableCell className="font-medium">
                        {match.wanted_full_name}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {match.case_reference ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span className="block font-medium">
                          {match.hotel_name}
                        </span>
                        {match.hotel_address && (
                          <a
                            href={`https://www.google.com/maps?q=${match.hotel_maps_lat},${match.hotel_maps_lng}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                          >
                            <MapPin className="h-3 w-3" />
                            {match.hotel_address}
                          </a>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">
                        {match.room_number}
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
