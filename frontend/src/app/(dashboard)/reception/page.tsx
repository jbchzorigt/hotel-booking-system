"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BedDouble,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  UserPlus,
  Wifi,
  WifiOff,
} from "lucide-react";

import api from "@/lib/axios";
import { formatDate, formatMNT } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWebSocket } from "@/hooks/useWebSocket";
import { toast } from "@/hooks/use-toast";
import CheckInDialog from "@/components/reception/CheckInDialog";
import CheckoutDialog from "@/components/reception/CheckoutDialog";
import WalkInDialog from "@/components/reception/WalkInDialog";
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
  BookingStatus,
  DeskBooking,
  DeskRoom,
  ReceptionWsEvent,
  RoomState,
} from "@/types/api";

const ROOM_STATE_BADGE: Record<
  RoomState,
  { label: string; variant: "success" | "info" | "warning" }
> = {
  VACANT_CLEAN: { label: "Vacant · Clean", variant: "success" },
  OCCUPIED: { label: "Occupied", variant: "info" },
  VACANT_DIRTY: { label: "Vacant · Dirty", variant: "warning" },
};

const BOOKING_STATUS_BADGE: Record<
  BookingStatus,
  { label: string; variant: "info" | "warning" | "success" | "secondary" | "destructive" }
> = {
  PENDING: { label: "Awaiting payment", variant: "warning" },
  CONFIRMED: { label: "Confirmed", variant: "info" },
  CHECKED_IN: { label: "In house", variant: "success" },
  CHECKED_OUT: { label: "Checked out", variant: "secondary" },
  CANCELLED: { label: "Cancelled", variant: "secondary" },
  NO_SHOW: { label: "No-show", variant: "destructive" },
};

type DeskFilter = "active" | "all";

export default function ReceptionPage() {
  const [rooms, setRooms] = useState<DeskRoom[]>([]);
  const [bookings, setBookings] = useState<DeskBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<DeskFilter>("active");

  const [walkInOpen, setWalkInOpen] = useState(false);
  const [checkInBooking, setCheckInBooking] = useState<DeskBooking | null>(null);
  const [checkoutBooking, setCheckoutBooking] = useState<DeskBooking | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const [roomsRes, bookingsRes] = await Promise.all([
        api.get<DeskRoom[]>("/reception/rooms"),
        api.get<DeskBooking[]>("/reception/bookings", {
          params: { include_all: true },
        }),
      ]);
      setRooms(roomsRes.data);
      setBookings(bookingsRes.data);
    } catch {
      toast({
        variant: "destructive",
        title: "Failed to load the desk board",
        description: "Check your connection and try refreshing.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // -- Real-time: minibar reports from housekeeping ---------------------- //
  const handleWsEvent = useCallback((event: ReceptionWsEvent) => {
    if (event.type !== "MINIBAR_REPORT") return;
    const report = event as Extract<
      ReceptionWsEvent,
      { type: "MINIBAR_REPORT" }
    >;
    toast({
      title: `Minibar charge — Room ${report.room_number}`,
      description: `${report.items
        .map((i) => `${i.quantity}× ${i.name}`)
        .join(", ")} · ${formatMNT(report.total_amount)} (booking ${
        report.booking_code
      })`,
    });
  }, []);

  const { status: wsStatus } = useWebSocket<ReceptionWsEvent>("/ws/reception", {
    onEvent: handleWsEvent,
  });

  const visibleBookings = useMemo(
    () =>
      filter === "active"
        ? bookings.filter(
            (b) =>
              b.status === "PENDING" ||
              b.status === "CONFIRMED" ||
              b.status === "CHECKED_IN"
          )
        : bookings,
    [bookings, filter]
  );
  const inHouseCount = bookings.filter((b) => b.status === "CHECKED_IN").length;
  const arrivalCount = bookings.filter((b) => b.status === "CONFIRMED").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Reception Desk
          </h2>
          <p className="text-sm text-muted-foreground">
            {arrivalCount} arrival{arrivalCount === 1 ? "" : "s"} pending ·{" "}
            {inHouseCount} in house
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            {wsStatus === "open" ? "Live" : "Reconnecting…"}
          </span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setWalkInOpen(true)}>
            <UserPlus className="h-4 w-4" />
            Register Walk-in
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* ---------------- Bookings ---------------- */}
          <Card>
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div className="space-y-1.5">
                <CardTitle className="text-base">Bookings</CardTitle>
                <CardDescription>
                  Check-in runs KHUR identity verification; checkout settles
                  the desk payment and releases the escrow.
                </CardDescription>
              </div>
              <div className="flex rounded-md border p-0.5">
                {(["active", "all"] as const).map((value) => (
                  <button
                    key={value}
                    onClick={() => setFilter(value)}
                    className={cn(
                      "rounded px-3 py-1 text-xs font-medium capitalize transition-colors",
                      filter === value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {visibleBookings.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {filter === "active"
                    ? "No active bookings — register a walk-in or wait for marketplace arrivals."
                    : "No bookings yet."}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Booking</TableHead>
                      <TableHead>Guest</TableHead>
                      <TableHead>Room</TableHead>
                      <TableHead>Dates</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleBookings.map((booking) => {
                      const badge = BOOKING_STATUS_BADGE[booking.status];
                      return (
                        <TableRow key={booking.id}>
                          <TableCell className="font-mono text-xs">
                            {booking.code}
                          </TableCell>
                          <TableCell>
                            <span className="font-medium">
                              {booking.guest_full_name}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {booking.guest_phone}
                            </span>
                          </TableCell>
                          <TableCell>{booking.room_number}</TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDate(booking.check_in_date)} –{" "}
                            {formatDate(booking.check_out_date)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {booking.status === "CONFIRMED" && (
                              <Button
                                size="sm"
                                onClick={() => setCheckInBooking(booking)}
                                title="Verifies the guest's identity against the state KHUR registry"
                              >
                                <LogIn className="h-4 w-4" />
                                Check-In
                              </Button>
                            )}
                            {booking.status === "CHECKED_IN" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setCheckoutBooking(booking)}
                              >
                                <LogOut className="h-4 w-4" />
                                Check-Out &amp; Pay
                              </Button>
                            )}
                            {booking.status === "PENDING" && (
                              <span className="text-xs text-muted-foreground">
                                Unpaid — cannot check in
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* ---------------- Room board ---------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BedDouble className="h-4 w-4 text-muted-foreground" />
                Room board
              </CardTitle>
              <CardDescription>
                Live housekeeping state for every active room.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Room</TableHead>
                    <TableHead>Floor</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rooms.map((room) => {
                    const badge = ROOM_STATE_BADGE[room.state];
                    return (
                      <TableRow key={room.id}>
                        <TableCell className="font-medium">
                          {room.room_number}
                        </TableCell>
                        <TableCell>{room.floor}</TableCell>
                        <TableCell className="capitalize">
                          {room.room_type.toLowerCase()}
                        </TableCell>
                        <TableCell>
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <WalkInDialog
        open={walkInOpen}
        rooms={rooms}
        onClose={() => setWalkInOpen(false)}
        onCreated={() => void refresh()}
      />
      <CheckInDialog
        booking={checkInBooking}
        onClose={() => setCheckInBooking(null)}
        onCheckedIn={() => {
          setCheckInBooking(null);
          void refresh();
        }}
      />
      <CheckoutDialog
        booking={checkoutBooking}
        onClose={() => setCheckoutBooking(null)}
        onCheckedOut={() => void refresh()}
      />
    </div>
  );
}
