"use client";

import { useState } from "react";
import { isAxiosError } from "axios";
import { CheckCheck, ChefHat, Loader2, PackageCheck } from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { FoodOrder, FoodOrderStatus } from "@/types/api";

const STATUS_BADGE: Record<
  FoodOrderStatus,
  { label: string; variant: "info" | "warning" | "success" | "secondary" }
> = {
  PLACED: { label: "New", variant: "info" },
  ACCEPTED: { label: "Accepted", variant: "warning" },
  PREPARING: { label: "Preparing", variant: "warning" },
  DELIVERED: { label: "Delivered", variant: "success" },
  CANCELLED: { label: "Cancelled", variant: "secondary" },
};

/** Next legal fulfilment step per app/api/restaurant_router.py. */
const NEXT_STEP: Partial<
  Record<
    FoodOrderStatus,
    { to: FoodOrderStatus; label: string; icon: React.ComponentType<{ className?: string }> }
  >
> = {
  PLACED: { to: "ACCEPTED", label: "Accept", icon: CheckCheck },
  ACCEPTED: { to: "PREPARING", label: "Start preparing", icon: ChefHat },
  PREPARING: { to: "DELIVERED", label: "Mark Delivered", icon: PackageCheck },
};

export default function OrdersSection({
  orders,
  onOrderUpdated,
  loading,
}: {
  orders: FoodOrder[];
  onOrderUpdated: (order: FoodOrder) => void;
  loading: boolean;
}) {
  const [advancingId, setAdvancingId] = useState<string | null>(null);

  const advance = async (order: FoodOrder, to: FoodOrderStatus) => {
    setAdvancingId(order.id);
    try {
      const { data } = await api.patch<FoodOrder>(
        `/restaurant/orders/${order.id}/status`,
        { status: to }
      );
      onOrderUpdated(data);
      if (to === "DELIVERED") {
        toast({
          title: "Order delivered — payment released",
          description: `${formatMNT(
            data.total_amount
          )} settled: 95% to your wallet, 5% platform commission.`,
        });
      }
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        toast({
          variant: "destructive",
          title: "Order state changed",
          description:
            (err.response.data as { detail?: string }).detail ??
            "Someone else updated this order.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Could not update the order",
        });
      }
    } finally {
      setAdvancingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const active = orders.filter(
    (o) => o.status !== "DELIVERED" && o.status !== "CANCELLED"
  );
  const done = orders.filter(
    (o) => o.status === "DELIVERED" || o.status === "CANCELLED"
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">
          Active orders ({active.length})
        </h3>
        {active.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No active orders. New paid orders appear here in real time.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {active.map((order) => {
              const step = NEXT_STEP[order.status];
              const badge = STATUS_BADGE[order.status];
              return (
                <Card key={order.id}>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center justify-between text-sm">
                      <span className="font-mono text-xs text-muted-foreground">
                        #{order.id.slice(0, 8)}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        <Badge variant="outline">
                          Escrow {order.escrow_status.toLowerCase()}
                        </Badge>
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <ul className="space-y-1 text-sm">
                      {order.items.map((line, index) => (
                        <li
                          key={index}
                          className="flex items-center justify-between"
                        >
                          <span>
                            {line.quantity}× {line.item_name}
                          </span>
                          <span className="tabular-nums text-muted-foreground">
                            {formatMNT(Number(line.unit_price) * line.quantity)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-center justify-between border-t pt-3">
                      <span className="text-sm font-semibold">
                        {formatMNT(order.total_amount)}
                      </span>
                      {step && (
                        <Button
                          size="sm"
                          onClick={() => void advance(order, step.to)}
                          disabled={advancingId === order.id}
                        >
                          {advancingId === order.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <step.icon className="h-4 w-4" />
                          )}
                          {step.label}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {done.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground">
            Completed ({done.length})
          </h3>
          <div className="space-y-2">
            {done.map((order) => {
              const badge = STATUS_BADGE[order.status];
              return (
                <div
                  key={order.id}
                  className="flex items-center justify-between rounded-md border px-4 py-2 text-sm"
                >
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-xs text-muted-foreground">
                      #{order.id.slice(0, 8)}
                    </span>
                    <span className="text-muted-foreground">
                      {order.items
                        .map((l) => `${l.quantity}× ${l.item_name}`)
                        .join(", ")}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-medium tabular-nums">
                      {formatMNT(order.total_amount)}
                    </span>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
