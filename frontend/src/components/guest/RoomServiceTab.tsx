"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { isAxiosError } from "axios";
import {
  ArrowLeft,
  ChefHat,
  Loader2,
  Minus,
  Phone,
  Plus,
  UtensilsCrossed,
} from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
import type {
  FoodOrderResponse,
  MenuItemPublic,
  RestaurantMenu,
  RestaurantPublic,
} from "@/types/api";

export default function RoomServiceTab({ tenantId }: { tenantId: string }) {
  const [restaurants, setRestaurants] = useState<RestaurantPublic[] | null>(
    null
  );
  const [selected, setSelected] = useState<RestaurantPublic | null>(null);
  const [menu, setMenu] = useState<RestaurantMenu | null>(null);
  const [menuLoading, setMenuLoading] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  useEffect(() => {
    api
      .get<RestaurantPublic[]>(`/marketplace/hotels/${tenantId}/restaurants`)
      .then(({ data }) => setRestaurants(data))
      .catch(() =>
        toast({
          variant: "destructive",
          title: "Could not load nearby restaurants",
        })
      );
  }, [tenantId]);

  const openMenu = async (restaurant: RestaurantPublic) => {
    setSelected(restaurant);
    setMenu(null);
    setQuantities({});
    setMenuLoading(true);
    try {
      const { data } = await api.get<RestaurantMenu>(
        `/marketplace/restaurants/${restaurant.id}/menu`
      );
      setMenu(data);
    } catch {
      toast({ variant: "destructive", title: "Could not load the menu" });
      setSelected(null);
    } finally {
      setMenuLoading(false);
    }
  };

  const adjust = (itemId: string, delta: number) =>
    setQuantities((current) => {
      const next = Math.min(20, Math.max(0, (current[itemId] ?? 0) + delta));
      const updated = { ...current, [itemId]: next };
      if (next === 0) delete updated[itemId];
      return updated;
    });

  const lines = Object.entries(quantities).filter(([, qty]) => qty > 0);
  const total = lines.reduce((sum, [itemId, qty]) => {
    const item = menu?.items.find((i) => i.id === itemId);
    return sum + (item ? Number(item.price) * qty : 0);
  }, 0);

  const groupedMenu = useMemo(() => {
    if (!menu) return [];
    const groups = new Map<string, MenuItemPublic[]>();
    for (const item of menu.items) {
      const key = item.category ?? "Other";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()];
  }, [menu]);

  // ---------------- Restaurant list ---------------- //
  if (selected === null) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Order from restaurants near this hotel — delivered to your room.
          You&apos;ll need your booking code (you must be checked in).
        </p>
        {restaurants === null ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : restaurants.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No restaurants deliver to this hotel yet.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {restaurants.map((restaurant) => (
              <Card key={restaurant.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <UtensilsCrossed className="h-4 w-4 text-muted-foreground" />
                    {restaurant.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {restaurant.description && (
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {restaurant.description}
                    </p>
                  )}
                  <div className="flex items-center justify-between">
                    {restaurant.phone ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Phone className="h-3 w-3" />
                        {restaurant.phone}
                      </span>
                    ) : (
                      <span />
                    )}
                    <Button size="sm" onClick={() => void openMenu(restaurant)}>
                      <ChefHat className="h-4 w-4" />
                      View menu
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---------------- Menu + cart ---------------- //
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
          <ArrowLeft className="h-4 w-4" />
          All restaurants
        </Button>
        <h3 className="font-semibold">{selected.name}</h3>
      </div>

      {menuLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : menu && menu.items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            This restaurant has no available items right now.
          </CardContent>
        </Card>
      ) : (
        menu && (
          <>
            <div className="space-y-6 pb-24">
              {groupedMenu.map(([category, items]) => (
                <section key={category} className="space-y-2">
                  <h4 className="text-sm font-semibold text-muted-foreground">
                    {category}
                  </h4>
                  <div className="divide-y rounded-md border">
                    {items.map((item) => {
                      const qty = quantities[item.id] ?? 0;
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 p-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{item.name}</p>
                            {item.description && (
                              <p className="line-clamp-1 text-xs text-muted-foreground">
                                {item.description}
                              </p>
                            )}
                            <p className="text-xs font-medium">
                              {formatMNT(item.price)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => adjust(item.id, -1)}
                              disabled={qty === 0}
                              aria-label={`Remove one ${item.name}`}
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                            <span className="w-5 text-center text-sm font-semibold tabular-nums">
                              {qty}
                            </span>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => adjust(item.id, 1)}
                              disabled={qty >= 20}
                              aria-label={`Add one ${item.name}`}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            {lines.length > 0 && (
              <div className="sticky bottom-4 flex items-center justify-between rounded-lg border bg-background p-4 shadow-lg">
                <div>
                  <p className="text-sm text-muted-foreground">
                    {lines.reduce((n, [, q]) => n + q, 0)} item
                    {lines.reduce((n, [, q]) => n + q, 0) === 1 ? "" : "s"}
                  </p>
                  <p className="text-lg font-semibold">{formatMNT(total)}</p>
                </div>
                <Button onClick={() => setCheckoutOpen(true)}>
                  Order to my room
                </Button>
              </div>
            )}
          </>
        )
      )}

      <OrderCheckoutDialog
        open={checkoutOpen}
        restaurant={selected}
        lines={lines}
        menu={menu}
        total={total}
        onClose={() => setCheckoutOpen(false)}
        onOrdered={() => {
          setCheckoutOpen(false);
          setQuantities({});
        }}
      />
    </div>
  );
}

// ===========================================================================
// Checkout: proof of stay (booking code + room number) -> escrow hold ->
// kitchen alert. Only the booking code authorizes; the room number is a
// guest-facing confirmation check against the server's answer.
// ===========================================================================
function OrderCheckoutDialog({
  open,
  restaurant,
  lines,
  menu,
  total,
  onClose,
  onOrdered,
}: {
  open: boolean;
  restaurant: RestaurantPublic;
  lines: [string, number][];
  menu: RestaurantMenu | null;
  total: number;
  onClose: () => void;
  onOrdered: () => void;
}) {
  const [bookingCode, setBookingCode] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string>("");

  useEffect(() => {
    if (open) {
      idempotencyKey.current = crypto.randomUUID();
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post<FoodOrderResponse>(
        "/marketplace/order",
        {
          booking_code: bookingCode.trim().toUpperCase(),
          restaurant_id: restaurant.id,
          items: lines.map(([food_item_id, quantity]) => ({
            food_item_id,
            quantity,
          })),
        },
        { headers: { "Idempotency-Key": idempotencyKey.current } }
      );
      if (roomNumber.trim() && roomNumber.trim() !== data.room_number) {
        toast({
          title: `Order placed — delivering to Room ${data.room_number}`,
          description:
            "Note: delivery goes to the room on your booking, not the number you typed.",
        });
      } else {
        toast({
          title: `Order placed — Room ${data.room_number}`,
          description: `${formatMNT(
            data.total_amount
          )} held in escrow. ${data.restaurant_name} has been notified.`,
        });
      }
      onOrdered();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 404) {
        setError("No booking found for this code.");
      } else if (isAxiosError(err) && err.response?.status === 409) {
        setError(
          (err.response.data as { detail?: string }).detail ??
            "You must be checked in at this hotel to order."
        );
      } else if (isAxiosError(err) && err.response?.status === 422) {
        setError("Some items became unavailable — go back and review the cart.");
      } else if (isAxiosError(err) && err.response?.status === 402) {
        setError("Payment was declined — you can retry safely.");
      } else {
        setError("Order failed. Please try again.");
      }
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm your order</DialogTitle>
          <DialogDescription>
            {restaurant.name} · payment is held in escrow and released to the
            kitchen after delivery.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <ul className="space-y-1 rounded-md border bg-muted/50 p-3 text-sm">
            {lines.map(([itemId, qty]) => {
              const item = menu?.items.find((i) => i.id === itemId);
              if (!item) return null;
              return (
                <li key={itemId} className="flex justify-between">
                  <span>
                    {qty}× {item.name}
                  </span>
                  <span className="tabular-nums">
                    {formatMNT(Number(item.price) * qty)}
                  </span>
                </li>
              );
            })}
            <li className="flex justify-between border-t pt-1 font-semibold">
              <span>Total</span>
              <span>{formatMNT(total)}</span>
            </li>
          </ul>

          <div className="space-y-2">
            <Label htmlFor="booking-code">Booking code (proof of stay)</Label>
            <Input
              id="booking-code"
              placeholder="BK-7F3A21"
              value={bookingCode}
              onChange={(e) => setBookingCode(e.target.value)}
              className="font-mono uppercase"
              autoComplete="off"
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              From your booking confirmation — you must be checked in.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="room-number">Room number</Label>
            <Input
              id="room-number"
              placeholder="101"
              value={roomNumber}
              onChange={(e) => setRoomNumber(e.target.value)}
              autoComplete="off"
              disabled={submitting}
            />
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
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || bookingCode.trim().length < 4}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Placing order…
              </>
            ) : (
              <>Pay {formatMNT(total)}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
