"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { isAxiosError } from "axios";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowLeft,
  ChefHat,
  Loader2,
  Minus,
  PartyPopper,
  Phone,
  Plus,
  ShoppingBag,
  TriangleAlert,
  UtensilsCrossed,
} from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { cn } from "@/lib/utils";
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
import type {
  DiningMenuItem,
  DiningOrderResponse,
  DiningOrderStatus,
  DiningRestaurant,
} from "@/types/api";

const POLL_INTERVAL_MS = 3000;

type PageState =
  | { kind: "loading" }
  | { kind: "invalid"; reason: string }
  | { kind: "browse" }
  | { kind: "paying"; order: DiningOrderResponse }
  | { kind: "success"; order: DiningOrderResponse };

export default function DiningPage() {
  const params = useParams<{ booking_id: string }>();
  const bookingId = params.booking_id;

  const [restaurants, setRestaurants] = useState<DiningRestaurant[]>([]);
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [activeRestaurantId, setActiveRestaurantId] = useState<string | null>(
    null
  );
  const [cart, setCart] = useState<Record<string, number>>({});
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    api
      .get<DiningRestaurant[]>(`/public/bookings/${bookingId}/restaurants`)
      .then(({ data }) => {
        setRestaurants(data);
        setState({ kind: "browse" });
        if (data.length === 1) setActiveRestaurantId(data[0].restaurant_id);
      })
      .catch((err) => {
        if (isAxiosError(err) && err.response?.status === 404) {
          setState({
            kind: "invalid",
            reason: "This dining link doesn't match any booking.",
          });
        } else if (isAxiosError(err) && err.response?.status === 409) {
          setState({
            kind: "invalid",
            reason:
              "In-room dining is available for active stays only — this booking has ended or isn't paid yet.",
          });
        } else {
          setState({
            kind: "invalid",
            reason: "Could not load restaurants. Please try again.",
          });
        }
      });
  }, [bookingId]);

  const activeRestaurant = useMemo(
    () =>
      restaurants.find((r) => r.restaurant_id === activeRestaurantId) ?? null,
    [restaurants, activeRestaurantId]
  );

  const adjust = (itemId: string, delta: number) =>
    setCart((current) => {
      const next = Math.min(20, Math.max(0, (current[itemId] ?? 0) + delta));
      const updated = { ...current, [itemId]: next };
      if (next === 0) delete updated[itemId];
      return updated;
    });

  const cartLines = Object.entries(cart).filter(([, q]) => q > 0);
  const cartCount = cartLines.reduce((n, [, q]) => n + q, 0);
  const cartTotal = cartLines.reduce((sum, [id, q]) => {
    const item = activeRestaurant?.items.find((i) => i.id === id);
    return sum + (item ? Number(item.price) * q : 0);
  }, 0);

  const switchRestaurant = (id: string) => {
    if (id !== activeRestaurantId && cartLines.length > 0) {
      setCart({}); // one order = one restaurant (backend contract)
      toast({ title: "Cart cleared", description: "One order per restaurant." });
    }
    setActiveRestaurantId(id);
  };

  const placeOrder = async () => {
    if (!activeRestaurant || cartLines.length === 0) return;
    setPlacing(true);
    try {
      const { data } = await api.post<DiningOrderResponse>(
        `/public/bookings/${bookingId}/orders`,
        {
          restaurant_id: activeRestaurant.restaurant_id,
          items: cartLines.map(([menu_item_id, quantity]) => ({
            menu_item_id,
            quantity,
          })),
        }
      );
      setState({ kind: "paying", order: data });
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 422) {
        toast({
          variant: "destructive",
          title: "An item just became unavailable",
          description: "Review your cart and try again.",
        });
      } else if (isAxiosError(err) && err.response?.status === 409) {
        toast({
          variant: "destructive",
          title: "Ordering unavailable",
          description:
            (err.response.data as { detail?: string }).detail ??
            "This stay can no longer order.",
        });
      } else {
        toast({ variant: "destructive", title: "Could not place the order" });
      }
      setPlacing(false);
    }
  };

  // ---------------- Invalid / loading ---------------- //
  if (state.kind === "loading") {
    return (
      <div className="flex h-72 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (state.kind === "invalid") {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <TriangleAlert className="mx-auto h-10 w-10 text-amber-500" />
        <h1 className="mt-3 text-lg font-semibold">Dining unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">{state.reason}</p>
        <Link href="/" className="mt-4 inline-block">
          <Button variant="outline">Back to Stayline</Button>
        </Link>
      </div>
    );
  }
  if (state.kind === "paying") {
    return (
      <DiningPayment
        order={state.order}
        onFunded={() => setState({ kind: "success", order: state.order })}
      />
    );
  }
  if (state.kind === "success") {
    return <DiningSuccess order={state.order} />;
  }

  // ---------------- Browse ---------------- //
  return (
    <div className="mx-auto max-w-2xl px-4 pb-32 pt-6 sm:px-6">
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <UtensilsCrossed className="h-5 w-5" />
          In-room dining
        </h1>
        <p className="text-sm text-muted-foreground">
          Order from restaurants near your hotel — delivered to your room and
          paid with QPay.
        </p>
      </div>

      {restaurants.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No restaurants deliver to this hotel yet.
          </CardContent>
        </Card>
      ) : activeRestaurant === null ? (
        // Restaurant picker
        <div className="space-y-3">
          {restaurants.map((r) => (
            <button
              key={r.restaurant_id}
              onClick={() => switchRestaurant(r.restaurant_id)}
              className="w-full text-left"
            >
              <Card className="transition-colors hover:border-primary/50">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span className="flex items-center gap-2">
                      <ChefHat className="h-4 w-4 text-muted-foreground" />
                      {r.name}
                    </span>
                    <Badge variant="secondary">
                      {r.items.length} item{r.items.length === 1 ? "" : "s"}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                {r.description && (
                  <CardContent className="pt-0">
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {r.description}
                    </p>
                  </CardContent>
                )}
              </Card>
            </button>
          ))}
        </div>
      ) : (
        // Menu + cart
        <>
          <div className="mb-4 flex items-center justify-between">
            {restaurants.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveRestaurantId(null)}
              >
                <ArrowLeft className="h-4 w-4" />
                All restaurants
              </Button>
            ) : (
              <span />
            )}
            <div className="text-right">
              <p className="font-semibold">{activeRestaurant.name}</p>
              {activeRestaurant.phone && (
                <p className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                  <Phone className="h-3 w-3" />
                  {activeRestaurant.phone}
                </p>
              )}
            </div>
          </div>

          <MenuList
            items={activeRestaurant.items}
            cart={cart}
            onAdjust={adjust}
            disabled={placing}
          />

          {/* Sticky cart bar */}
          {cartCount > 0 && (
            <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-4 backdrop-blur">
              <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
                <div>
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <ShoppingBag className="h-4 w-4" />
                    {cartCount} item{cartCount === 1 ? "" : "s"}
                  </p>
                  <p className="text-lg font-bold tabular-nums">
                    {formatMNT(cartTotal)}
                  </p>
                </div>
                <Button
                  size="lg"
                  onClick={() => void placeOrder()}
                  disabled={placing}
                >
                  {placing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Placing…
                    </>
                  ) : (
                    "Order & pay with QPay"
                  )}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Menu list grouped by category, with quantity steppers
// ===========================================================================
function MenuList({
  items,
  cart,
  onAdjust,
  disabled,
}: {
  items: DiningMenuItem[];
  cart: Record<string, number>;
  onAdjust: (itemId: string, delta: number) => void;
  disabled: boolean;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, DiningMenuItem[]>();
    for (const item of items) {
      const key = item.category ?? "Menu";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()];
  }, [items]);

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          This restaurant has no available items right now.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {grouped.map(([category, categoryItems]) => (
        <section key={category}>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
            {category}
          </h3>
          <div className="divide-y rounded-xl border">
            {categoryItems.map((item) => {
              const qty = cart[item.id] ?? 0;
              return (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center justify-between gap-3 p-4",
                    qty > 0 && "bg-primary/5"
                  )}
                >
                  <div className="min-w-0">
                    <p className="font-medium">{item.name}</p>
                    {item.description && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {item.description}
                      </p>
                    )}
                    <p className="mt-0.5 text-sm font-semibold">
                      {formatMNT(item.price)}
                    </p>
                  </div>
                  {qty === 0 ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0"
                      onClick={() => onAdjust(item.id, 1)}
                      disabled={disabled}
                    >
                      <Plus className="h-4 w-4" />
                      Add
                    </Button>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-9 w-9"
                        onClick={() => onAdjust(item.id, -1)}
                        disabled={disabled}
                        aria-label={`Remove one ${item.name}`}
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                      <span className="w-5 text-center font-semibold tabular-nums">
                        {qty}
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-9 w-9"
                        onClick={() => onAdjust(item.id, 1)}
                        disabled={disabled || qty >= 20}
                        aria-label={`Add one ${item.name}`}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ===========================================================================
// Payment: QPay QR + poll /public/orders/{id} until funded
// ===========================================================================
function DiningPayment({
  order,
  onFunded,
}: {
  order: DiningOrderResponse;
  onFunded: () => void;
}) {
  const [simulating, setSimulating] = useState(false);
  const doneRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onFunded();
  }, [onFunded]);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const { data } = await api.get<DiningOrderStatus>(
          `/public/orders/${order.order_id}`
        );
        if (active && data.is_funded) finish();
      } catch {
        /* transient — keep polling */
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [order.order_id, finish]);

  const simulatePayment = async () => {
    setSimulating(true);
    try {
      const { data } = await api.post<DiningOrderStatus>(
        `/public/orders/${order.order_id}/simulate-payment`
      );
      if (data.is_funded) finish();
    } catch {
      toast({ variant: "destructive", title: "Could not simulate payment" });
      setSimulating(false);
    }
  };

  return (
    <div className="mx-auto max-w-md px-4 py-8 sm:px-6">
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-lg">Scan to pay with QPay</CardTitle>
          <CardDescription>
            {order.restaurant_name} · {formatMNT(order.total_amount)}. Your
            order reaches the kitchen the moment payment lands.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-5">
          <div className="rounded-xl border bg-white p-4">
            <QRCodeSVG
              value={order.qpay_invoice.qr_text}
              size={200}
              level="M"
              marginSize={2}
            />
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Waiting for payment…
          </div>

          <a
            href={order.qpay_invoice.payment_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Or open the QPay payment link
          </a>

          <div className="w-full border-t pt-4">
            <p className="mb-2 text-center text-xs text-muted-foreground">
              Demo sandbox — no real bank payment
            </p>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => void simulatePayment()}
              disabled={simulating}
            >
              {simulating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Confirming…
                </>
              ) : (
                "Simulate QPay payment"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ===========================================================================
// Success — "Your order is sent to the kitchen!"
// ===========================================================================
function DiningSuccess({ order }: { order: DiningOrderResponse }) {
  return (
    <div className="mx-auto max-w-md px-4 py-10 sm:px-6">
      <Card className="relative overflow-hidden border-emerald-200 text-center dark:border-emerald-900">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-emerald-50/60 to-transparent dark:from-emerald-950/40"
        />
        <CardHeader className="relative items-center">
          <span className="flex h-16 w-16 animate-bounce items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/50">
            <PartyPopper className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
          </span>
          <CardTitle className="pt-3 text-2xl">
            Your order is sent to the kitchen!
          </CardTitle>
          <CardDescription>
            {order.restaurant_name} is preparing it — delivery straight to
            your room.
          </CardDescription>
        </CardHeader>
        <CardContent className="relative space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border bg-background/80 p-4 text-left text-sm">
            <dt className="text-muted-foreground">Order</dt>
            <dd className="text-right font-mono text-xs">
              #{order.order_id.slice(0, 8)}
            </dd>
            <dt className="text-muted-foreground">Paid</dt>
            <dd className="text-right font-semibold">
              {formatMNT(order.total_amount)}
            </dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd className="text-right">
              <Badge variant="success">
                <ChefHat className="mr-1 h-3 w-3" />
                In the kitchen
              </Badge>
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            Payment is held in escrow and released to the restaurant after
            delivery.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
