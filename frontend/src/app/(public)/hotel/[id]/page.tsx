"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  BedDouble,
  Loader2,
  MapPin,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

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
import type { HotelDetail, PublicRoom } from "@/types/api";

function isISODate(v: string | null): v is string {
  return v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function HotelDetailInner() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();

  const checkIn = isISODate(searchParams.get("check_in"))
    ? (searchParams.get("check_in") as string)
    : new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const checkOut = isISODate(searchParams.get("check_out"))
    ? (searchParams.get("check_out") as string)
    : new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  const [hotel, setHotel] = useState<HotelDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api
      .get<HotelDetail>(`/marketplace/hotels/${params.id}`)
      .then(({ data }) => setHotel(data))
      .catch((err) => {
        if (err?.response?.status === 404) setNotFound(true);
        else toast({ variant: "destructive", title: "Could not load hotel" });
      });
  }, [params.id]);

  const nights = useMemo(() => {
    if (checkOut <= checkIn) return 0;
    return Math.round(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000
    );
  }, [checkIn, checkOut]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-24 text-center sm:px-6 lg:px-8">
        <h1 className="text-xl font-semibold">Hotel not available</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          It may no longer be accepting bookings.
        </p>
        <Link href="/" className="mt-4 inline-block">
          <Button variant="outline">Back to search</Button>
        </Link>
      </div>
    );
  }

  if (hotel === null) {
    return (
      <div className="flex h-72 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const checkoutHref = (room: PublicRoom) =>
    `/checkout?room_id=${room.id}` +
    `&hotel=${encodeURIComponent(hotel.name)}` +
    `&room=${encodeURIComponent(room.room_number)}` +
    `&type=${encodeURIComponent(room.room_type)}` +
    `&rate=${room.base_price}` +
    `&check_in=${checkIn}&check_out=${checkOut}`;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Hotel header */}
      <div className="overflow-hidden rounded-2xl border">
        <div className="flex h-48 items-center justify-center bg-gradient-to-br from-muted to-muted/40">
          <BedDouble className="h-16 w-16 text-muted-foreground/30" />
        </div>
        <div className="space-y-2 p-6">
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
                Map
              </a>
            </p>
          )}
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            Payment held in escrow until check-in
          </p>
        </div>
      </div>

      {/* Stay summary */}
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="font-medium">
          {new Date(`${checkIn}T00:00:00`).toLocaleDateString()} →{" "}
          {new Date(`${checkOut}T00:00:00`).toLocaleDateString()}
        </span>
        <span className="text-muted-foreground">
          {nights} night{nights === 1 ? "" : "s"}
        </span>
        <Link
          href="/"
          className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Change dates
        </Link>
      </div>

      {/* Rooms */}
      <h2 className="mb-4 mt-8 text-lg font-semibold tracking-tight">
        Choose your room
      </h2>
      {hotel.rooms.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No rooms listed for this hotel right now.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {hotel.rooms.map((room) => (
            <Card key={room.id} className="flex flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="capitalize">
                    {room.room_type.toLowerCase()}
                  </span>
                  {room.state === "VACANT_CLEAN" && (
                    <Badge variant="success">
                      <Sparkles className="mr-1 h-3 w-3" />
                      Ready
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" />
                    {room.beds} bed{room.beds === 1 ? "" : "s"} · Room{" "}
                    {room.room_number} · floor {room.floor}
                  </p>
                  <p>
                    <span className="text-lg font-semibold text-foreground">
                      {formatMNT(room.base_price)}
                    </span>{" "}
                    / night
                    {nights > 0 && (
                      <span className="ml-1 text-xs">
                        · {formatMNT(Number(room.base_price) * nights)} total
                      </span>
                    )}
                  </p>
                </div>
                <Link href={checkoutHref(room)} className="w-full">
                  <Button className="w-full" disabled={nights < 1}>
                    Book Now
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HotelDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-72 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <HotelDetailInner />
    </Suspense>
  );
}
