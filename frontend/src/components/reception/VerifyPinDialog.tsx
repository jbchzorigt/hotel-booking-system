"use client";

import { useEffect, useState } from "react";
import { isAxiosError } from "axios";
import { KeyRound, Loader2, ShieldQuestion } from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
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
import type {
  DeskBooking,
  OverrideRequestResponse,
  VerifyPinResponse,
} from "@/types/api";

const PIN_RE = /^\d{6}$/;

/**
 * Zero-trust check-in: the guest proves arrival with the 6-digit PIN they
 * received when the booking was funded, and ONLY then does the escrow
 * release to the hotel. The PIN never appears in any reception API — this
 * dialog is the guest speaking, not the desk reading.
 *
 * Fallback: "Guest lost PIN" escalates to a platform-admin manual override
 * (idempotent server-side); the row shows a Pending Admin Approval badge.
 */
export default function VerifyPinDialog({
  booking,
  onClose,
  onCheckedIn,
  onOverrideRequested,
}: {
  booking: DeskBooking | null;
  onClose: () => void;
  onCheckedIn: () => void;
  onOverrideRequested: (bookingId: string) => void;
}) {
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requestingOverride, setRequestingOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registryLookup = useRegistryLookup();

  useEffect(() => {
    setPin("");
    setSubmitting(false);
    setRequestingOverride(false);
    setError(null);
    registryLookup.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.id]);

  const busy = submitting || requestingOverride;

  const handleVerify = async () => {
    if (!booking) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post<VerifyPinResponse>(
        `/reception/bookings/${booking.id}/verify-pin`,
        {
          pin,
          // Optional РД: KHUR-verifies identity + fires police screening,
          // exactly like the classic check-in path.
          registry_number: registryLookup.registry || null,
        }
      );
      toast({
        title: `PIN verified — Room ${data.room_number}`,
        description: `Checked in · escrow released: ${formatMNT(
          data.hotel_amount
        )} to your hotel, ${formatMNT(data.commission_amount)} commission.`,
      });
      onCheckedIn();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 400) {
        setError("Incorrect PIN — please ask the guest to re-check it.");
      } else if (isAxiosError(err) && err.response?.status === 409) {
        setError(
          (err.response.data as { detail?: string }).detail ??
            "This booking cannot be PIN-verified right now."
        );
      } else if (isAxiosError(err) && err.response?.status === 404) {
        setError("No citizen record for this registry number.");
      } else if (isAxiosError(err) && err.response?.status === 502) {
        setError("State registry unavailable — try again, or omit the РД.");
      } else {
        setError("Verification failed. Please try again.");
      }
      setSubmitting(false);
    }
  };

  const handleOverrideRequest = async () => {
    if (!booking) return;
    setRequestingOverride(true);
    setError(null);
    try {
      const { data } = await api.post<OverrideRequestResponse>(
        `/reception/bookings/${booking.id}/request-override`
      );
      toast({
        title: "Override requested",
        description: `Booking ${data.booking_code} is waiting for platform-admin approval.`,
      });
      onOverrideRequested(booking.id);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        setError(
          (err.response.data as { detail?: string }).detail ??
            "An override cannot be requested for this booking."
        );
      } else {
        setError("Could not request the override. Please try again.");
      }
      setRequestingOverride(false);
    }
  };

  return (
    <Dialog open={booking !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            Verify arrival PIN
          </DialogTitle>
          <DialogDescription>
            {booking && (
              <>
                Booking{" "}
                <span className="font-mono text-xs">{booking.code}</span> ·
                Room {booking.room_number} ·{" "}
                <span className="font-medium text-foreground">
                  {booking.guest_full_name}
                </span>
                . A correct PIN checks the guest in and releases the escrow
                to your hotel.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {booking?.override_requested && (
            <Badge variant="warning" className="w-full justify-center py-1.5">
              Pending Admin Approval — override already requested
            </Badge>
          )}

          <div className="space-y-2">
            <Label htmlFor="arrival-pin">Guest&apos;s 6-digit PIN</Label>
            <Input
              id="arrival-pin"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="••••••"
              maxLength={6}
              value={pin}
              onChange={(e) =>
                setPin(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              disabled={busy}
              autoFocus
              className="h-14 text-center font-mono text-2xl tracking-[0.5em]"
            />
            <p className="text-xs text-muted-foreground">
              The guest received this PIN on their booking confirmation after
              payment.
            </p>
          </div>

          <RegistryField
            id="pin-registry"
            registry={registryLookup.registry}
            onChange={registryLookup.setRegistry}
            lookupState={registryLookup.lookupState}
            citizen={registryLookup.citizen}
            disabled={busy}
            optionalNote="Optional — adds KHUR identity verification to the check-in."
          />

          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            className="w-full"
            onClick={() => void handleVerify()}
            disabled={busy || !PIN_RE.test(pin)}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Verifying…
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4" />
                Verify PIN &amp; Check-In
              </>
            )}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void handleOverrideRequest()}
            disabled={busy || booking?.override_requested}
          >
            {requestingOverride ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Requesting…
              </>
            ) : (
              <>
                <ShieldQuestion className="h-4 w-4" />
                {booking?.override_requested
                  ? "Override already pending"
                  : "Guest lost PIN (Request Admin Override)"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
