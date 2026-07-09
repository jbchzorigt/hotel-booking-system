"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isAxiosError } from "axios";
import {
  BellRing,
  Gavel,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  PoliceResolutionAction,
  PoliceWsEvent,
  ResolveResponse,
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

export default function LiveAlertsPage() {
  const [matches, setMatches] = useState<PoliceMatch[] | null>(null);
  const [resolving, setResolving] = useState<PoliceMatch | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<PoliceMatch[]>("/police/matches");
      setMatches(data);
    } catch {
      toast({ variant: "destructive", title: "Could not load the match feed" });
      setMatches((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // -- Real-time: a new match means a wanted guest just checked in -------- //
  const handleAlert = useCallback(
    (event: PoliceWsEvent) => {
      if (event.type !== "POLICE_MATCH_ALERT") return;
      const alert = event as PoliceMatchAlert;
      toast({
        variant: "destructive",
        title: `⚠ Match — ${alert.wanted_full_name}`,
        description: `${alert.hotel_name}, Room ${alert.room_number} · booking ${alert.booking_code}`,
      });
      void refresh(); // the alert is a notification; refetch the full row
    },
    [refresh]
  );

  const { status: wsStatus } = useWebSocket<PoliceWsEvent>(
    "/ws/police/alerts",
    { onEvent: handleAlert }
  );

  const applyResolution = useCallback((res: ResolveResponse) => {
    setMatches((current) =>
      (current ?? []).map((m) =>
        m.match_id === res.match_id
          ? { ...m, status: res.status, wanted_status: res.wanted_status }
          : m
      )
    );
  }, []);

  const pendingCount = useMemo(
    () => (matches ?? []).filter((m) => m.status === "PENDING_REVIEW").length,
    [matches]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Live Alerts</h1>
          <p className="text-sm text-muted-foreground">
            A match fires when a checked-in guest matches the watchlist —
            with the exact district, hotel and room.
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

      {pendingCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
          <BellRing className="h-4 w-4 shrink-0" />
          {pendingCount} match{pendingCount === 1 ? "" : "es"} awaiting review.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Match feed</CardTitle>
          <CardDescription>
            Newest first. Guest name is what was given at check-in and may be
            an alias.
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
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Guest (alias)</TableHead>
                    <TableHead>Wanted person</TableHead>
                    <TableHead>District</TableHead>
                    <TableHead>Hotel / Room</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
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
                          <span className="block font-mono text-xs text-muted-foreground">
                            {match.booking_code}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="block font-medium">
                            {match.wanted_full_name}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {match.case_reference ?? "no case ref."}
                          </span>
                        </TableCell>
                        <TableCell>{match.district ?? "—"}</TableCell>
                        <TableCell>
                          <span className="block font-medium">
                            {match.hotel_name}
                          </span>
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <MapPin className="h-3 w-3" />
                            Room {match.room_number}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                          {match.wanted_status === "ARRESTED" && (
                            <Badge variant="success" className="ml-1">
                              Arrested
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {pending ? (
                            <Button
                              size="sm"
                              onClick={() => setResolving(match)}
                            >
                              <Gavel className="h-4 w-4" />
                              Resolve
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {match.reviewed_at
                                ? `Reviewed ${formatDateTime(match.reviewed_at)}`
                                : "—"}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ResolveDialog
        match={resolving}
        onClose={() => setResolving(null)}
        onResolved={(res) => {
          applyResolution(res);
          setResolving(null);
        }}
      />
    </div>
  );
}

// ===========================================================================
// Resolve dialog — ARRESTED (de-lists the suspect), CONFIRMED, or DISMISSED.
// Single-shot server-side: a concurrent resolve returns 409.
// ===========================================================================
function ResolveDialog({
  match,
  onClose,
  onResolved,
}: {
  match: PoliceMatch | null;
  onClose: () => void;
  onResolved: (res: ResolveResponse) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<PoliceResolutionAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNote("");
    setBusy(null);
    setError(null);
  }, [match?.match_id]);

  const resolve = async (action: PoliceResolutionAction) => {
    if (!match) return;
    setBusy(action);
    setError(null);
    try {
      const { data } = await api.post<ResolveResponse>(
        `/police/matches/${match.match_id}/resolve`,
        { action, note: note.trim() || null }
      );
      const verb =
        action === "ARRESTED"
          ? "Suspect marked arrested"
          : action === "CONFIRMED"
            ? "Match confirmed"
            : "Match dismissed";
      toast({ title: verb });
      onResolved(data);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        setError(
          (err.response.data as { detail?: string }).detail ??
            "This match was already resolved."
        );
      } else {
        setError("Could not resolve the match. Please try again.");
      }
      setBusy(null);
    }
  };

  return (
    <Dialog open={match !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve match</DialogTitle>
          <DialogDescription>
            {match && (
              <>
                <span className="font-medium text-foreground">
                  {match.wanted_full_name}
                </span>{" "}
                at {match.hotel_name}, Room {match.room_number}
                {match.district ? ` · ${match.district}` : ""}.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="resolve-note">Note (optional)</Label>
            <Input
              id="resolve-note"
              placeholder="e.g. apprehended at front desk"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              disabled={busy !== null}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Marking arrested confirms the hit and de-lists the suspect from
            future matching. This is single-shot and cannot be undone here.
          </p>

          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="outline"
            onClick={() => void resolve("DISMISSED")}
            disabled={busy !== null}
          >
            {busy === "DISMISSED" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Dismiss (false positive)
          </Button>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => void resolve("CONFIRMED")}
              disabled={busy !== null}
            >
              {busy === "CONFIRMED" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Confirm
            </Button>
            <Button
              onClick={() => void resolve("ARRESTED")}
              disabled={busy !== null}
            >
              {busy === "ARRESTED" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Gavel className="h-4 w-4" />
              )}
              Mark Arrested
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
