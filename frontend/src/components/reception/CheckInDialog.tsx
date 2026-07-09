"use client";

import { useEffect, useState } from "react";
import { isAxiosError } from "axios";
import { Loader2 } from "lucide-react";

import api from "@/lib/axios";
import { toast } from "@/hooks/use-toast";
import { useRegistryLookup } from "@/hooks/useRegistryLookup";
import RegistryField from "@/components/reception/RegistryField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CheckInResponse, DeskBooking } from "@/types/api";

/**
 * Check-in triggers KHUR identity verification server-side (and the
 * automatic police screening that follows every check-in). Walk-in
 * bookings (WI- codes) were verified at registration, so their check-in
 * needs no registry number.
 */
export default function CheckInDialog({
  booking,
  onClose,
  onCheckedIn,
}: {
  booking: DeskBooking | null;
  onClose: () => void;
  onCheckedIn: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const registryLookup = useRegistryLookup();

  const isWalkIn = booking?.code.startsWith("WI-") ?? false;

  useEffect(() => {
    setSubmitting(false);
    setSubmitError(null);
    registryLookup.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.id]);

  const handleSubmit = async () => {
    if (!booking) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { data } = await api.post<CheckInResponse>(
        `/reception/bookings/${booking.id}/check-in`,
        {
          registry_number: registryLookup.registry || null,
        }
      );
      toast({
        title: `Checked in — Room ${data.room_number}`,
        description: `${data.verified_full_name} · booking ${data.booking_code}`,
      });
      onCheckedIn();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        setSubmitError(
          (err.response.data as { detail?: string }).detail ??
            "Booking or room is not in a check-in-able state."
        );
      } else if (isAxiosError(err) && err.response?.status === 404) {
        setSubmitError("No citizen record for this registry number.");
      } else if (isAxiosError(err) && err.response?.status === 422) {
        setSubmitError(
          "A valid registry number is required for this booking."
        );
      } else if (isAxiosError(err) && err.response?.status === 502) {
        setSubmitError("State registry unavailable — try again shortly.");
      } else {
        setSubmitError("Check-in failed. Please try again.");
      }
      setSubmitting(false);
    }
  };

  const canSubmit = isWalkIn
    ? !submitting
    : registryLookup.isValidShape && !submitting;

  return (
    <Dialog open={booking !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Check in guest</DialogTitle>
          <DialogDescription>
            {booking && (
              <>
                Booking{" "}
                <span className="font-mono text-xs">{booking.code}</span> ·
                Room {booking.room_number} · booked for{" "}
                <span className="font-medium text-foreground">
                  {booking.guest_full_name}
                </span>
                . Check-in runs KHUR identity verification.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <RegistryField
            id="ci-registry"
            registry={registryLookup.registry}
            onChange={registryLookup.setRegistry}
            lookupState={registryLookup.lookupState}
            citizen={registryLookup.citizen}
            disabled={submitting}
            optionalNote={
              isWalkIn
                ? "Optional for walk-ins — identity was KHUR-verified at registration."
                : undefined
            }
          />

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
                Checking in…
              </>
            ) : (
              "Confirm check-in"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
