"use client";

import { BedDouble, GlassWater, UtensilsCrossed } from "lucide-react";

import MinibarTab from "@/components/manager/MinibarTab";
import RestaurantsTab from "@/components/manager/RestaurantsTab";
import RoomsTab from "@/components/manager/RoomsTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function ManagerPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">
          Hotel Management
        </h2>
        <p className="text-sm text-muted-foreground">
          Rooms, minibar catalogue and vicinity restaurants for your hotel.
        </p>
      </div>

      <Tabs defaultValue="rooms">
        <TabsList>
          <TabsTrigger value="rooms">
            <BedDouble className="h-4 w-4" />
            Rooms
          </TabsTrigger>
          <TabsTrigger value="minibar">
            <GlassWater className="h-4 w-4" />
            Minibar
          </TabsTrigger>
          <TabsTrigger value="restaurants">
            <UtensilsCrossed className="h-4 w-4" />
            Vicinity Restaurants
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rooms">
          <RoomsTab />
        </TabsContent>
        <TabsContent value="minibar">
          <MinibarTab />
        </TabsContent>
        <TabsContent value="restaurants">
          <RestaurantsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
