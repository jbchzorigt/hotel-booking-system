"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { BadgeCheck, Copy, Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { BookResponse, PublicRoom } from "@/types/api";

const MAX_STAY_NIGHTS = 30;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Mirrors BookRequest + the /book endpoint's date rules.
const bookingSchema = z
  .object({
    guest_full_name: z
      .string()
      .min(2, "At least 2 characters")
      .max(255, "At most 255 characters"),
    guest_phone: z
      .string()
      .min(6, "At least 6 characters")
      .max(32, "At most 32 characters"),
    guest_email: z
      .string()
      .email("Not a valid email")
      .optional()
      .or(z.literal("")),
    check_in_date: z.string().min(1, "Required"),
    check_out_date: z.string().min(1, "Required"),
  })
  .refine((v) => v.check_in_date >= todayISO(), {
    message: "Check-in cannot be in the past",
    path: ["check_in_date"],
  })
  .refine((v) => v.check_out_date > v.check_in_date, {
    message: "Check-out must be after check-in",
    path: ["check_out_date"],
  })
  .refine(
    (v) => {
      const nights =
        (new Date(v.check_out_date).getTime() -
          new Date(v.check_in_date).getTime()) /
        86_400_000;
      return nights <= MAX_STAY_NIGHTS;
    },
    { message: `Stays are limited to ${MAX_STAY_NIGHTS} nights`, path: ["check_out_date"] }
  );

type BookingFormValues = z.infer<typeof bookingSchema>;

export default function BookingDialog({
  room,
  hotelName,
  defaultCheckIn,
  defaultCheckOut,
  onClose,
}: {
  room: PublicRoom | null;
  hotelName: string;
  defaultCheckIn?: string;
  defaultCheckOut?: string;
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState<BookResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // One idempotency key per dialog session: retries after a payment
  // decline reuse it (safe replay), a fresh dialog gets a fresh key.
  const idempotencyKey = useRef<string>("");

  const form = useForm<BookingFormValues>({
    resolver: zodResolver(bookingSchema),
    defaultValues: {
      guest_full_name: "",
      guest_phone: "",
      guest_email: "",
      check_in_date: defaultCheckIn ?? "",
      check_out_date: defaultCheckOut ?? "",
    },
  });

  useEffect(() => {
    if (room) {
      idempotencyKey.current = crypto.randomUUID();
      setConfirmation(null);
      setSubmitError(null);
      form.reset({
        guest_full_name: "",
        guest_phone: "",
        guest_email: "",
        check_in_date: defaultCheckIn ?? "",
        check_out_date: defaultCheckOut ?? "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  const checkIn = form.watch("check_in_date");
  const checkOut = form.watch("check_out_date");
  const nights = useMemo(() => {
    if (!checkIn || !checkOut || checkOut <= checkIn) return 0;
    return Math.round(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000
    );
  }, [checkIn, checkOut]);
  const total = room ? Number(room.base_price) * nights : 0;

  const onSubmit = async (values: BookingFormValues) => {
    if (!room) return;
    setSubmitError(null);
    try {
      const { data } = await api.post<BookResponse>(
        "/marketplace/book",
        {
          room_id: room.id,
          guest_full_name: values.guest_full_name,
          guest_phone: values.guest_phone,
          guest_email: values.guest_email || null,
          check_in_date: values.check_in_date,
          check_out_date: values.check_out_date,
        },
        { headers: { "Idempotency-Key": idempotencyKey.current } }
      );
      setConfirmation(data);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 402) {
        setSubmitError(
          "Payment was declined. Your reservation is held — you can retry " +
            "payment safely (the same request is replayed, never doubled)."
        );
      } else if (isAxiosError(err) && err.response?.status === 409) {
        setSubmitError(
          (err.response.data as { detail?: string }).detail ??
            "This room is already booked for (part of) these dates."
        );
      } else if (isAxiosError(err) && err.response?.status === 422) {
        setSubmitError("Check the dates and guest details.");
      } else {
        setSubmitError("Booking failed. Please try again.");
      }
    }
  };

  const copyCode = async () => {
    if (!confirmation) return;
    try {
      await navigator.clipboard.writeText(confirmation.booking_code);
      toast({ title: "Booking code copied" });
    } catch {
      /* clipboard unavailable — the code stays visible */
    }
  };

  return (
    <Dialog open={room !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {confirmation ? (
          // ---------------- Success state ---------------- //
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <BadgeCheck className="h-5 w-5 text-emerald-600" />
                Booking confirmed
              </DialogTitle>
              <DialogDescription>
                Payment is held in escrow — the hotel is paid after your stay.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/50 p-4 text-center">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Your booking code — you need it at check-in
                </p>
                <p className="mt-1 font-mono text-2xl font-bold tracking-widest">
                  {confirmation.booking_code}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void copyCode()}
                >
                  <Copy className="h-4 w-4" />
                  Copy code
                </Button>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Hotel</dt>
                <dd className="text-right font-medium">
                  {confirmation.hotel_name}
                </dd>
                <dt className="text-muted-foreground">Room</dt>
                <dd className="text-right font-medium">
                  {confirmation.room_number}
                </dd>
                <dt className="text-muted-foreground">Stay</dt>
                <dd className="text-right font-medium">
                  {confirmation.check_in_date} → {confirmation.check_out_date}{" "}
                  ({confirmation.nights} night
                  {confirmation.nights === 1 ? "" : "s"})
                </dd>
                <dt className="text-muted-foreground">Paid (escrow)</dt>
                <dd className="text-right font-semibold">
                  {formatMNT(confirmation.total_amount)}
                </dd>
              </dl>
            </div>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          // ---------------- Booking form ---------------- //
          <>
            <DialogHeader>
              <DialogTitle>
                Book Room {room?.room_number} · {hotelName}
              </DialogTitle>
              <DialogDescription>
                {room && (
                  <>
                    <span className="capitalize">
                      {room.room_type.toLowerCase()}
                    </span>{" "}
                    · {room.beds} bed{room.beds === 1 ? "" : "s"} · floor{" "}
                    {room.floor} · {formatMNT(room.base_price)} / night
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-4"
                noValidate
              >
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="check_in_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Check-in</FormLabel>
                        <FormControl>
                          <Input type="date" min={todayISO()} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="check_out_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Check-out</FormLabel>
                        <FormControl>
                          <Input type="date" min={todayISO()} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="guest_full_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full name</FormLabel>
                      <FormControl>
                        <Input placeholder="As on your ID" {...field} />
                      </FormControl>
                      <FormDescription>
                        Identity is verified against the state registry at
                        check-in.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="guest_phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl>
                          <Input placeholder="+976 9911 2233" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="guest_email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email (optional)</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="you@mail.com"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {nights > 0 && (
                  <div className="flex items-center justify-between rounded-md border bg-muted/50 px-4 py-3 text-sm">
                    <span className="text-muted-foreground">
                      {nights} night{nights === 1 ? "" : "s"} ×{" "}
                      {room && formatMNT(room.base_price)}
                    </span>
                    <span className="text-base font-semibold">
                      {formatMNT(total)}
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

                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onClose}
                    disabled={form.formState.isSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={form.formState.isSubmitting}>
                    {form.formState.isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Booking…
                      </>
                    ) : (
                      `Book & pay${nights > 0 ? ` ${formatMNT(total)}` : ""}`
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
