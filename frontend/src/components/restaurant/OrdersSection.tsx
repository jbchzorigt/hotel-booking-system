"use client";

import { useMemo, useState } from "react";
import { isAxiosError } from "axios";
import {
  BellRing,
  CheckCheck,
  ChefHat,
  Clock,
  Loader2,
  PackageCheck,
} from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { FoodOrder, FoodOrderStatus } from "@/types/api";

/**
 * Kitchen Display System — Kanban lanes for the fulfilment ladder.
 *
 * Lane order mirrors the backend's legal transitions exactly
 * (PLACED -> ACCEPTED -> PREPARING -> DELIVERED; skipping a step 409s),
 * so each card's action advances one lane. DELIVERED releases the
 * escrow (95% restaurant / 5% platform) server-side.
 */
const LANES: {
  status: FoodOrderStatus;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  next: FoodOrderStatus | null;
  actionLabel: string | null;
}[] = [
  {
    status: "PLACED",
    title: "New",
    icon: BellRing,
    accent: "border-t-sky-500",
    next: "ACCEPTED",
    actionLabel: "Accept",
  },
  {
    status: "ACCEPTED",
    title: "Accepted",
    icon: CheckCheck,
    accent: "border-t-amber-500",
    next: "PREPARING",
    actionLabel: "Start preparing",
  },
  {
    status: "PREPARING",
    title: "Preparing",
    icon: ChefHat,
    accent: "border-t-orange-500",
    next: "DELIVERED",
    actionLabel: "Mark delivered",
  },
  {
    status: "DELIVERED",
    title: "Delivered",
    icon: PackageCheck,
    accent: "border-t-emerald-500",
    next: null,
    actionLabel: null,
  },
];

function ageMinutes(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

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

  const byLane = useMemo(() => {
    const map = new Map<FoodOrderStatus, FoodOrder[]>();
    for (const lane of LANES) map.set(lane.status, []);
    for (const order of orders) {
      if (map.has(order.status)) map.get(order.status)!.push(order);
    }
    // Kitchen priority: oldest first in working lanes, newest first in Delivered.
    for (const lane of LANES) {
      const list = map.get(lane.status)!;
      list.sort((a, b) =>
        lane.status === "DELIVERED"
          ? b.created_at.localeCompare(a.created_at)
          : a.created_at.localeCompare(b.created_at)
      );
    }
    return map;
  }, [orders]);

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
          title: "Delivered — payment released",
          description: `${formatMNT(data.total_amount)}: 95% to your wallet, 5% platform commission.`,
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
        toast({ variant: "destructive", title: "Could not update the order" });
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

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {LANES.map((lane) => {
        const laneOrders = byLane.get(lane.status)!;
        return (
          <section
            key={lane.status}
            className={cn(
              "flex min-h-[16rem] flex-col rounded-lg border border-t-4 bg-muted/30",
              lane.accent
            )}
          >
            <header className="flex items-center justify-between px-3 py-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <lane.icon className="h-4 w-4 text-muted-foreground" />
                {lane.title}
              </h3>
              <Badge
                variant={
                  lane.status === "PLACED" && laneOrders.length > 0
                    ? "destructive"
                    : "secondary"
                }
                className="tabular-nums"
              >
                {laneOrders.length}
              </Badge>
            </header>

            <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {laneOrders.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  Empty
                </p>
              ) : (
                laneOrders.map((order) => {
                  const minutes = ageMinutes(order.created_at);
                  const overdue = lane.next !== null && minutes >= 20;
                  return (
                    <article
                      key={order.id}
                      className="rounded-md border bg-background p-2.5 shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          #{order.id.slice(0, 8)}
                        </span>
                        <span
                          className={cn(
                            "flex items-center gap-1 text-xs tabular-nums",
                            overdue
                              ? "font-semibold text-destructive"
                              : "text-muted-foreground"
                          )}
                        >
                          <Clock className="h-3 w-3" />
                          {minutes}m
                        </span>
                      </div>

                      <ul className="mt-1.5 space-y-0.5 text-sm">
                        {order.items.map((line, index) => (
                          <li key={index} className="flex justify-between gap-2">
                            <span className="truncate">
                              <span className="font-semibold tabular-nums">
                                {line.quantity}×
                              </span>{" "}
                              {line.item_name}
                            </span>
                          </li>
                        ))}
                      </ul>

                      <div className="mt-2 flex items-center justify-between border-t pt-2">
                        <span className="text-sm font-semibold tabular-nums">
                          {formatMNT(order.total_amount)}
                        </span>
                        {lane.next !== null && lane.actionLabel !== null ? (
                          <Button
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => void advance(order, lane.next!)}
                            disabled={advancingId === order.id}
                          >
                            {advancingId === order.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              lane.actionLabel
                            )}
                          </Button>
                        ) : (
                          <Badge variant="success" className="text-xs">
                            Paid out
                          </Badge>
                        )}
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
