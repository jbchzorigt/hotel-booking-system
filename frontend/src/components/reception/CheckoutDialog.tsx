"use client";

import { useEffect, useState } from "react";
import { isAxiosError } from "axios";
import {
  CalendarClock,
  GlassWater,
  Loader2,
  LogOut,
  Minus,
  Plus,
  ReceiptText,
  Sparkles,
} from "lucide-react";

import api from "@/lib/axios";
import { formatDate, formatMNT } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  BookingDetail,
  CheckoutResponse,
  DeskBooking,
  DeskCatalogueItem,
  DeskMinibarLine,
  PaymentMethod,
} from "@/types/api";

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "QPAY", label: "QPay" },
  { value: "CARD", label: "Card" },
];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check-out & pay. On open it fetches the checkout preview
 * (``GET /reception/bookings/{id}``) so the invoice shows the minibar items
 * HOUSEKEEPING already reported for this stay. The receptionist may add
 * further desk-level items (guest is leaving, housekeeping hasn't seen the
 * room). One desk payment settles all minibar (and, for walk-ins, the
 * room), then the escrow releases 95% hotel / 5% platform. An early
 * checkout truncates the departure date so the unused nights free up for
 * resale. On success the dialog becomes the final receipt.
 */
export default function CheckoutDialog({
  booking,
  onClose,
  onCheckedOut,
}: {
  booking: DeskBooking | null;
  onClose: () => void;
  onCheckedOut: () => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>("QPAY");
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [catalogue, setCatalogue] = useState<DeskCatalogueItem[] | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CheckoutResponse | null>(null);

  // Per-booking reset + fetch of the checkout preview (reported minibar).
  useEffect(() => {
    if (!booking) return;
    setMethod("QPAY");
    setQuantities({});
    setSubmitting(false);
    setError(null);
    setReceipt(null);
    setDetail(null);
    setDetailError(false);

    let cancelled = false;
    api
      .get<BookingDetail>(`/reception/bookings/${booking.id}`)
      .then(({ data }) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => {
        if (!cancelled) setDetailError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [booking?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the catalogue once, lazily, the first time the dialog opens.
  useEffect(() => {
    if (!booking || catalogue !== null) return;
    api
      .get<DeskCatalogueItem[]>("/reception/minibar/items")
      .then(({ data }) => setCatalogue(data))
      .catch(() => {
        setCatalogue([]); // checkout must still work without the catalogue
        toast({
          variant: "destructive",
          title: "Could not load the minibar catalogue",
          description: "You can still check out; desk items are unavailable.",
        });
      });
  }, [booking, catalogue]);

  const adjust = (itemId: string, delta: number) =>
    setQuantities((current) => {
      const next = Math.min(99, Math.max(0, (current[itemId] ?? 0) + delta));
      const updated = { ...current, [itemId]: next };
      if (next === 0) delete updated[itemId];
      return updated;
    });

  const deskLines: DeskMinibarLine[] = Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([catalog_id, quantity]) => ({ catalog_id, quantity }));

  const deskMinibarTotal = deskLines.reduce((sum, line) => {
    const item = catalogue?.find((i) => i.id === line.catalog_id);
    return sum + (item ? Number(item.price) * line.quantity : 0);
  }, 0);

  // Prefer the authoritative preview; fall back to the row snapshot if the
  // detail fetch failed (checkout still works, preview is just coarser).
  const roomTotal = detail
    ? Number(detail.room_total)
    : booking
      ? Number(booking.total_amount)
      : 0;
  const reportedTotal = detail
    ? Number(detail.housekeeping_reported_minibar_total)
    : 0;
  const previewGrandTotal = roomTotal + reportedTotal + deskMinibarTotal;

  // Early checkout = leaving before the booked departure date.
  const isEarlyCheckout =
    detail !== null && detail.check_out_date > todayISO();

  const handleSubmit = async () => {
    if (!booking) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post<CheckoutResponse>(
        `/reception/bookings/${booking.id}/check-out`,
        {
          payment_method: method,
          minibar_items: deskLines.length > 0 ? deskLines : null,
        }
      );
      setReceipt(data);
      toast({
        title: `Checked out — Room ${data.room_number}`,
        description: `${data.guest_full_name} · ${formatMNT(
          data.grand_total
        )} settled`,
      });
      onCheckedOut();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 402) {
        setError(
          "Desk payment was declined — try another method. Retrying is safe: " +
            "the charge is idempotency-keyed and can never double-bill."
        );
      } else if (isAxiosError(err) && err.response?.status === 409) {
        setError(
          (err.response.data as { detail?: string }).detail ??
            "The booking is not in a checkout-able state."
        );
      } else if (isAxiosError(err) && err.response?.status === 422) {
        setError(
          "A selected minibar item is no longer available — remove it and retry."
        );
      } else if (isAxiosError(err) && err.response?.status === 502) {
        setError("Payment gateway unavailable — try again shortly.");
      } else {
        setError("Checkout failed. Please try again.");
      }
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={booking !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        {receipt ? (
          // ---------------- Receipt ---------------- //
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ReceiptText className="h-5 w-5 text-emerald-600" />
                Receipt — {receipt.booking_code}
              </DialogTitle>
              <DialogDescription>
                {receipt.guest_full_name} · Room {receipt.room_number} ·{" "}
                {formatDate(receipt.check_in_date)} –{" "}
                {formatDate(receipt.check_out_date)}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {receipt.early_checkout && (
                <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300">
                  <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Early checkout — booked through{" "}
                    {formatDate(receipt.booked_check_out_date)}. The remaining
                    nights are now free for resale.
                  </span>
                </div>
              )}

              <div className="rounded-md border">
                <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
                  <span>
                    Room · {receipt.nights} night
                    {receipt.nights === 1 ? "" : "s"} ×{" "}
                    {formatMNT(receipt.nightly_rate)}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatMNT(receipt.room_total)}
                  </span>
                </div>
                {receipt.minibar_lines.map((line, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between border-b px-4 py-2 text-sm"
                  >
                    <span className="text-muted-foreground">
                      Minibar · {line.quantity}× {line.item_name}
                    </span>
                    <span className="tabular-nums">
                      {formatMNT(line.line_total)}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="font-semibold">Grand total</span>
                  <span className="text-lg font-bold tabular-nums">
                    {formatMNT(receipt.grand_total)}
                  </span>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <dt>Hotel share (95%)</dt>
                <dd className="text-right tabular-nums">
                  {formatMNT(receipt.hotel_amount)}
                </dd>
                <dt>Platform commission (5%)</dt>
                <dd className="text-right tabular-nums">
                  {formatMNT(receipt.commission_amount)}
                </dd>
                <dt>Settled at</dt>
                <dd className="text-right">
                  {new Date(receipt.settled_at).toLocaleString()}
                </dd>
              </dl>

              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="warning">Vacant · Dirty</Badge>
                Room {receipt.room_number} is now on the housekeeping list.
              </div>
            </div>

            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          // ---------------- Confirm ---------------- //
          <>
            <DialogHeader>
              <DialogTitle>Check out &amp; pay</DialogTitle>
              <DialogDescription>
                {booking && (
                  <>
                    <span className="font-medium text-foreground">
                      {booking.guest_full_name}
                    </span>{" "}
                    · Room {booking.room_number} · booking{" "}
                    <span className="font-mono text-xs">{booking.code}</span>
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* -------- Housekeeping-reported minibar -------- */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-muted-foreground" />
                  Reported by housekeeping
                </Label>
                {detail === null ? (
                  detailError ? (
                    <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                      Couldn&apos;t load reported items — they&apos;ll still be
                      charged and appear on the final receipt.
                    </p>
                  ) : (
                    <div className="flex h-12 items-center justify-center rounded-md border">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )
                ) : detail.housekeeping_reported_minibar_items.length === 0 ? (
                  <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                    Nothing reported by housekeeping for this stay.
                  </p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {detail.housekeeping_reported_minibar_items.map(
                      (line, index) => (
                        <div
                          key={index}
                          className="flex items-center justify-between px-3 py-2 text-sm"
                        >
                          <span className="text-muted-foreground">
                            {line.quantity}× {line.item_name}
                          </span>
                          <span className="tabular-nums">
                            {formatMNT(line.line_total)}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>

              {/* -------- Desk-added minibar -------- */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <GlassWater className="h-4 w-4 text-muted-foreground" />
                  Add at the desk (optional)
                </Label>
                {catalogue === null ? (
                  <div className="flex h-12 items-center justify-center rounded-md border">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : catalogue.length === 0 ? (
                  <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                    No minibar catalogue configured for this hotel.
                  </p>
                ) : (
                  <div className="max-h-44 divide-y overflow-y-auto rounded-md border">
                    {catalogue.map((item) => {
                      const qty = quantities[item.id] ?? 0;
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {item.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatMNT(item.price)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => adjust(item.id, -1)}
                              disabled={qty === 0 || submitting}
                              aria-label={`Remove one ${item.name}`}
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </Button>
                            <span className="w-5 text-center text-sm font-semibold tabular-nums">
                              {qty}
                            </span>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => adjust(item.id, 1)}
                              disabled={qty >= 99 || submitting}
                              aria-label={`Add one ${item.name}`}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* -------- Live invoice preview -------- */}
              <div className="rounded-md border bg-muted/50">
                <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
                  <span className="text-muted-foreground">Room charge</span>
                  <span className="tabular-nums">{formatMNT(roomTotal)}</span>
                </div>
                <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
                  <span className="text-muted-foreground">
                    Minibar · housekeeping
                  </span>
                  <span className="tabular-nums">
                    {formatMNT(reportedTotal)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
                  <span className="text-muted-foreground">Minibar · desk</span>
                  <span className="tabular-nums">
                    {formatMNT(deskMinibarTotal)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm font-semibold">
                    Grand total (preview)
                  </span>
                  <span className="text-base font-bold tabular-nums">
                    {formatMNT(previewGrandTotal)}
                  </span>
                </div>
              </div>

              {isEarlyCheckout && detail && (
                <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300">
                  <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Early checkout — guest is booked through{" "}
                    {formatDate(detail.check_out_date)}. Checking out now
                    automatically frees the remaining nights for resale (the
                    full stay was already paid; this is not a refund).
                  </span>
                </div>
              )}

              <div className="space-y-2">
                <Label>Desk payment method</Label>
                <Select
                  value={method}
                  onValueChange={(v) => setMethod(v as PaymentMethod)}
                  disabled={submitting}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((pm) => (
                      <SelectItem key={pm.value} value={pm.value}>
                        {pm.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={() => void handleSubmit()} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Settling…
                  </>
                ) : (
                  <>
                    <LogOut className="h-4 w-4" />
                    Check out · {formatMNT(previewGrandTotal)}
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
