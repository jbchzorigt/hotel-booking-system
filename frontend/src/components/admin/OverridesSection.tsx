"use client";

import { useCallback, useEffect, useState } from "react";
import { isAxiosError } from "axios";
import {
  BellRing,
  CalendarX2,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldQuestion,
} from "lucide-react";

import api from "@/lib/axios";
import { formatDate, formatMNT } from "@/lib/format";
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
  NoShowResult,
  OverrideApproved,
  OverrideBooking,
} from "@/types/api";

/**
 * Zero-trust arrivals console for the platform admin:
 *  - Check-in overrides: guests who lost their PIN — approving substitutes
 *    the admin's judgement for the PIN (check-in + escrow release).
 *  - Missed arrivals: CONFIRMED bookings whose check-in date passed —
 *    processing a no-show releases a one-night penalty to the hotel and
 *    refunds the remainder to the guest.
 */
export default function OverridesSection() {
  const [overrides, setOverrides] = useState<OverrideBooking[] | null>(null);
  const [expired, setExpired] = useState<OverrideBooking[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [ovRes, exRes] = await Promise.all([
        api.get<OverrideBooking[]>("/admin/bookings/overrides"),
        api.get<OverrideBooking[]>("/admin/bookings/expired"),
      ]);
      setOverrides(ovRes.data);
      setExpired(exRes.data);
    } catch {
      toast({
        variant: "destructive",
        title: "Could not load the arrivals queues",
      });
      setOverrides((c) => c ?? []);
      setExpired((c) => c ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const approveOverride = async (row: OverrideBooking) => {
    setBusyId(row.booking_id);
    try {
      const { data } = await api.post<OverrideApproved>(
        `/admin/bookings/${row.booking_id}/approve-override`
      );
      toast({
        title: `Check-in approved — ${row.booking_code}`,
        description: `Escrow released: ${formatMNT(
          data.hotel_amount
        )} to ${row.hotel_name}, ${formatMNT(data.commission_amount)} commission.`,
      });
      void refresh();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        toast({
          variant: "destructive",
          title: "Cannot approve",
          description:
            (err.response.data as { detail?: string }).detail ??
            "The booking or room is not in an approvable state.",
        });
      } else {
        toast({ variant: "destructive", title: "Approval failed" });
      }
    } finally {
      setBusyId(null);
    }
  };

  const processNoShow = async (row: OverrideBooking) => {
    setBusyId(row.booking_id);
    try {
      const { data } = await api.post<NoShowResult>(
        `/admin/bookings/${row.booking_id}/process-no-show`
      );
      toast({
        title: `No-show settled — ${row.booking_code}`,
        description: `${formatMNT(data.penalty_amount)} penalty (hotel ${formatMNT(
          data.hotel_amount
        )}), ${formatMNT(data.refunded_amount)} refunded to the guest.`,
      });
      void refresh();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        toast({
          variant: "destructive",
          title: "Cannot settle",
          description:
            (err.response.data as { detail?: string }).detail ??
            "This booking cannot be settled as a no-show.",
        });
      } else {
        toast({ variant: "destructive", title: "No-show settlement failed" });
      }
    } finally {
      setBusyId(null);
    }
  };

  const loading = overrides === null || expired === null;
  const actionCount = (overrides?.length ?? 0) + (expired?.length ?? 0);

  return (
    <Card
      className={
        actionCount > 0 ? "border-amber-300 dark:border-amber-800" : undefined
      }
    >
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 text-muted-foreground" />
            Action Required: Check-In Overrides
            {actionCount > 0 && (
              <Badge variant="warning">{actionCount}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Lost-PIN overrides and missed arrivals — every action here moves
            escrowed money, so it needs a platform-admin decision.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* -------- Lost-PIN override queue -------- */}
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <ShieldQuestion className="h-4 w-4 text-muted-foreground" />
                Lost-PIN override requests ({overrides.length})
              </h3>
              {overrides.length === 0 ? (
                <p className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  No overrides waiting.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Booking</TableHead>
                      <TableHead>Guest</TableHead>
                      <TableHead>Hotel / Room</TableHead>
                      <TableHead>Stay</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overrides.map((row) => (
                      <TableRow key={row.booking_id}>
                        <TableCell className="font-mono text-xs">
                          {row.booking_code}
                        </TableCell>
                        <TableCell className="font-medium">
                          {row.guest_full_name}
                        </TableCell>
                        <TableCell>
                          {row.hotel_name}
                          <span className="block text-xs text-muted-foreground">
                            Room {row.room_number}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDate(row.check_in_date)} –{" "}
                          {formatDate(row.check_out_date)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMNT(row.total_amount)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            onClick={() => void approveOverride(row)}
                            disabled={busyId === row.booking_id}
                          >
                            {busyId === row.booking_id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-4 w-4" />
                            )}
                            Approve Check-In
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            {/* -------- Missed arrivals -------- */}
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <CalendarX2 className="h-4 w-4 text-muted-foreground" />
                Missed arrivals ({expired.length})
              </h3>
              {expired.length === 0 ? (
                <p className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  No expired bookings.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Booking</TableHead>
                      <TableHead>Guest</TableHead>
                      <TableHead>Hotel / Room</TableHead>
                      <TableHead>Was due</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expired.map((row) => (
                      <TableRow key={row.booking_id}>
                        <TableCell className="font-mono text-xs">
                          {row.booking_code}
                        </TableCell>
                        <TableCell className="font-medium">
                          {row.guest_full_name}
                        </TableCell>
                        <TableCell>
                          {row.hotel_name}
                          <span className="block text-xs text-muted-foreground">
                            Room {row.room_number}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDate(row.check_in_date)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMNT(row.total_amount)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void processNoShow(row)}
                            disabled={busyId === row.booking_id}
                            title="One-night penalty to the hotel; remainder refunded; dates freed"
                          >
                            {busyId === row.booking_id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <CalendarX2 className="h-4 w-4" />
                            )}
                            Process No-Show
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
