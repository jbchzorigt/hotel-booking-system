"use client";

import { useCallback, useEffect, useState } from "react";
import { ChefHat, ReceiptText, Wifi, WifiOff } from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWebSocket } from "@/hooks/useWebSocket";
import { toast } from "@/hooks/use-toast";
import MenuSection from "@/components/restaurant/MenuSection";
import OrdersSection from "@/components/restaurant/OrdersSection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { FoodOrder, NewFoodOrderEvent, RestaurantWsEvent } from "@/types/api";

export default function RestaurantPage() {
  const [orders, setOrders] = useState<FoodOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshOrders = useCallback(async () => {
    try {
      const { data } = await api.get<FoodOrder[]>("/restaurant/orders");
      setOrders(data);
    } catch {
      toast({ variant: "destructive", title: "Failed to load orders" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshOrders();
  }, [refreshOrders]);

  // -- Real-time: paid orders (escrow HELD) from the kitchen topic -------- //
  const handleWsEvent = useCallback(
    (event: RestaurantWsEvent) => {
      if (event.type !== "NEW_FOOD_ORDER") return;
      const order = event as NewFoodOrderEvent;
      toast({
        title: `New order — Room ${order.room_number}`,
        description: `${order.items
          .map((i) => `${i.quantity}× ${i.name}`)
          .join(", ")} · ${formatMNT(order.total_amount)} (paid, escrow held)`,
      });
      // The event is a notification, not the full order row — refetch so
      // the list carries escrow status, snapshots and timestamps.
      void refreshOrders();
    },
    [refreshOrders]
  );

  const { status: wsStatus } = useWebSocket<RestaurantWsEvent>(
    "/ws/restaurant/orders",
    { onEvent: handleWsEvent }
  );

  const handleOrderUpdated = useCallback((updated: FoodOrder) => {
    setOrders((current) =>
      current.map((o) => (o.id === updated.id ? updated : o))
    );
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Restaurant Dashboard
          </h2>
          <p className="text-sm text-muted-foreground">
            Orders are paid into escrow before they reach you; delivery
            releases your 95% share.
          </p>
        </div>
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
      </div>

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">
            <ReceiptText className="h-4 w-4" />
            Live Orders
          </TabsTrigger>
          <TabsTrigger value="menu">
            <ChefHat className="h-4 w-4" />
            Menu
          </TabsTrigger>
        </TabsList>

        <TabsContent value="orders">
          <OrdersSection
            orders={orders}
            loading={loading}
            onOrderUpdated={handleOrderUpdated}
          />
        </TabsContent>
        <TabsContent value="menu">
          <MenuSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
