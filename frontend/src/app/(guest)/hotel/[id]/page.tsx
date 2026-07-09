"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  BedDouble,
  Loader2,
  MapPin,
  Sparkles,
  UtensilsCrossed,
} from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import BookingDialog from "@/components/guest/BookingDialog";
import RoomServiceTab from "@/components/guest/RoomServiceTab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { HotelDetail, PublicRoom } from "@/types/api";

function isValidISODate(value: string | null): value is string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function HotelDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const checkInParam = searchParams.get("check_in");
  const checkOutParam = searchParams.get("check_out");

  const [hotel, setHotel] = useState<HotelDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [bookingRoom, setBookingRoom] = useState<PublicRoom | null>(null);

  useEffect(() => {
    api
      .get<HotelDetail>(`/marketplace/hotels/${params.id}`)
      .then(({ data }) => setHotel(data))
      .catch((err) => {
        if (err?.response?.status === 404) {
          setNotFound(true);
        } else {
          toast({ variant: "destructive", title: "Could not load the hotel" });
        }
      });
  }, [params.id]);

  if (notFound) {
    return (
      <div className="py-24 text-center">
        <h1 className="text-xl font-semibold">Hotel not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This hotel may no longer be accepting bookings.
        </p>
      </div>
    );
  }

  if (hotel === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ---------------- Hotel header ---------------- */}
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">{hotel.name}</h1>
        {hotel.address && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4" />
            {hotel.address}
            <a
              href={`https://www.google.com/maps?q=${hotel.maps_lat},${hotel.maps_lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 underline underline-offset-2 hover:text-foreground"
            >
              Open in Maps
            </a>
          </p>
        )}
      </div>

      <Tabs defaultValue="rooms">
        <TabsList>
          <TabsTrigger value="rooms">
            <BedDouble className="h-4 w-4" />
            Rooms
          </TabsTrigger>
          <TabsTrigger value="food">
            <UtensilsCrossed className="h-4 w-4" />
            Room Service (Food)
          </TabsTrigger>
        </TabsList>

        {/* ---------------- Rooms ---------------- */}
        <TabsContent value="rooms">
          {hotel.rooms.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                This hotel has no rooms listed right now.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {hotel.rooms.map((room) => (
                <Card key={room.id} className="flex flex-col">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-base">
                      <span>Room {room.room_number}</span>
                      {room.state === "VACANT_CLEAN" && (
                        <Badge variant="success">
                          <Sparkles className="mr-1 h-3 w-3" />
                          Ready today
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col justify-between gap-4">
                    <div className="space-y-1 text-sm text-muted-foreground">
                      <p className="capitalize">
                        {room.room_type.toLowerCase()} · {room.beds} bed
                        {room.beds === 1 ? "" : "s"} · floor {room.floor}
                      </p>
                      <p>
                        <span className="text-lg font-semibold text-foreground">
                          {formatMNT(room.base_price)}
                        </span>{" "}
                        / night
                      </p>
                    </div>
                    <Button onClick={() => setBookingRoom(room)}>
                      Book Room
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ---------------- Room service ---------------- */}
        <TabsContent value="food">
          <RoomServiceTab tenantId={hotel.tenant_id} />
        </TabsContent>
      </Tabs>

      <BookingDialog
        room={bookingRoom}
        hotelName={hotel.name}
        defaultCheckIn={isValidISODate(checkInParam) ? checkInParam : undefined}
        defaultCheckOut={
          isValidISODate(checkOutParam) ? checkOutParam : undefined
        }
        onClose={() => setBookingRoom(null)}
      />
    </div>
  );
}

export default function HotelDetailPageWithBoundary() {
  // useSearchParams requires a Suspense boundary during static rendering.
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <HotelDetailPage />
    </Suspense>
  );
}
