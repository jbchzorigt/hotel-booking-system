"use client";

import { useEffect, useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { BadgeCheck, Loader2 } from "lucide-react";

import api from "@/lib/axios";
import { formatDate, formatMNT } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { useRegistryLookup } from "@/hooks/useRegistryLookup";
import RegistryField from "@/components/reception/RegistryField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DeskRoom, WalkInResponse } from "@/types/api";

const MAX_WALK_IN_NIGHTS = 30;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowISO(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Register a guest standing at the desk. Identity is KHUR-verified at
 * creation (the check-in step then needs no registry number) and the room
 * charge is collected at CHECKOUT — the backend creates the booking
 * CONFIRMED with escrow NOT_FUNDED (pay-at-desk model).
 */
export default function WalkInDialog({
  open,
  rooms,
  onClose,
  onCreated,
}: {
  open: boolean;
  rooms: DeskRoom[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [roomId, setRoomId] = useState("");
  const [checkIn, setCheckIn] = useState(todayISO());
  const [checkOut, setCheckOut] = useState(tomorrowISO());
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<WalkInResponse | null>(null);
  const registryLookup = useRegistryLookup();

  useEffect(() => {
    if (open) {
      setRoomId("");
      setCheckIn(todayISO());
      setCheckOut(tomorrowISO());
      setPhone("");
      setSubmitting(false);
      setSubmitError(null);
      setConfirmation(null);
      registryLookup.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedRoom = rooms.find((r) => r.id === roomId);
  const nights = useMemo(() => {
    if (!checkIn || !checkOut || checkOut <= checkIn) return 0;
    return Math.round(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000
    );
  }, [checkIn, checkOut]);

  const sameDayNotReady =
    checkIn === todayISO() &&
    selectedRoom !== undefined &&
    selectedRoom.state !== "VACANT_CLEAN";

  const dateError =
    checkIn < todayISO()
      ? "Check-in cannot be in the past"
      : nights < 1
        ? "Check-out must be after check-in"
        : nights > MAX_WALK_IN_NIGHTS
          ? `Stays are limited to ${MAX_WALK_IN_NIGHTS} nights`
          : null;

  const canSubmit =
    roomId !== "" &&
    registryLookup.isValidShape &&
    dateError === null &&
    !submitting;

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { data } = await api.post<WalkInResponse>("/reception/walk-in", {
        room_id: roomId,
        guest_registry_number: registryLookup.registry,
        check_in_date: checkIn,
        check_out_date: checkOut,
        guest_phone: phone.trim() || null,
      });
      setConfirmation(data);
      toast({
        title: `Walk-in registered — Room ${data.room_number}`,
        description: `${data.verified_full_name} · booking ${data.booking_code}`,
      });
      onCreated();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        setSubmitError(
          (err.response.data as { detail?: string }).detail ??
            "The room is not available for these dates."
        );
      } else if (isAxiosError(err) && err.response?.status === 404) {
        setSubmitError(
          "No citizen record for this registry number (or the room is gone)."
        );
      } else if (isAxiosError(err) && err.response?.status === 422) {
        setSubmitError(
          (err.response.data as { detail?: string }).detail?.toString?.() ??
            "Check the registry number and dates."
        );
      } else if (isAxiosError(err) && err.response?.status === 502) {
        setSubmitError("State registry unavailable — try again shortly.");
      } else {
        setSubmitError("Registration failed. Please try again.");
      }
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        {confirmation ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <BadgeCheck className="h-5 w-5 text-emerald-600" />
                Walk-in registered
              </DialogTitle>
              <DialogDescription>
                Identity verified — the check-in button needs no registry
                number for this booking.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/50 p-4 text-center">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Booking code
                </p>
                <p className="mt-1 font-mono text-2xl font-bold tracking-widest">
                  {confirmation.booking_code}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Guest (verified)</dt>
                <dd className="text-right font-medium">
                  {confirmation.verified_full_name}
                </dd>
                <dt className="text-muted-foreground">Room</dt>
                <dd className="text-right font-medium">
                  {confirmation.room_number}
                </dd>
                <dt className="text-muted-foreground">Stay</dt>
                <dd className="text-right font-medium">
                  {formatDate(confirmation.check_in_date)} –{" "}
                  {formatDate(confirmation.check_out_date)} (
                  {confirmation.nights} night
                  {confirmation.nights === 1 ? "" : "s"})
                </dd>
                <dt className="text-muted-foreground">Room total</dt>
                <dd className="text-right font-semibold">
                  {formatMNT(confirmation.total_amount)}
                </dd>
              </dl>
              {confirmation.payment_due_at_checkout && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                  Payment is collected at the desk during checkout (room +
                  any minibar charges).
                </p>
              )}
            </div>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Register walk-in guest</DialogTitle>
              <DialogDescription>
                Identity is KHUR-verified now; the room charge is collected
                at checkout.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Room</Label>
                <Select value={roomId} onValueChange={setRoomId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a room" />
                  </SelectTrigger>
                  <SelectContent>
                    {rooms.map((room) => (
                      <SelectItem key={room.id} value={room.id}>
                        <span className="flex items-center gap-2">
                          Room {room.room_number} · floor {room.floor} ·{" "}
                          <span className="capitalize">
                            {room.room_type.toLowerCase()}
                          </span>
                          {room.state !== "VACANT_CLEAN" && (
                            <Badge variant="warning">
                              {room.state === "OCCUPIED"
                                ? "occupied"
                                : "needs cleaning"}
                            </Badge>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sameDayNotReady && (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    Same-day walk-ins need a Vacant · Clean room — this one
                    will be rejected until housekeeping clears it.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="wi-check-in">Check-in</Label>
                  <Input
                    id="wi-check-in"
                    type="date"
                    min={todayISO()}
                    value={checkIn}
                    onChange={(e) => setCheckIn(e.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wi-check-out">Check-out</Label>
                  <Input
                    id="wi-check-out"
                    type="date"
                    min={todayISO()}
                    value={checkOut}
                    onChange={(e) => setCheckOut(e.target.value)}
                    disabled={submitting}
                  />
                </div>
              </div>
              {dateError && (
                <p className="text-sm text-destructive">{dateError}</p>
              )}

              <RegistryField
                id="wi-registry"
                registry={registryLookup.registry}
                onChange={registryLookup.setRegistry}
                lookupState={registryLookup.lookupState}
                citizen={registryLookup.citizen}
                disabled={submitting}
              />

              <div className="space-y-2">
                <Label htmlFor="wi-phone">Phone (optional)</Label>
                <Input
                  id="wi-phone"
                  placeholder="+976 9911 2233"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={submitting}
                />
              </div>

              {selectedRoom && nights > 0 && (
                <div className="flex items-center justify-between rounded-md border bg-muted/50 px-4 py-3 text-sm">
                  <span className="text-muted-foreground">
                    Room {selectedRoom.room_number} · {nights} night
                    {nights === 1 ? "" : "s"}
                  </span>
                  <span className="font-medium">
                    room charge due at checkout
                  </span>
                </div>
              )}

              {submitError && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {submitError}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Registering…
                  </>
                ) : (
                  "Register walk-in"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
