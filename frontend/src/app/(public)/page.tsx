"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { isAxiosError } from "axios";
import {
  BedDouble,
  Loader2,
  MapPin,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
} from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PublicHotel } from "@/types/api";

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export default function MarketplaceHome() {
  const [destination, setDestination] = useState("");
  const [checkIn, setCheckIn] = useState(addDays(1));
  const [checkOut, setCheckOut] = useState(addDays(3));
  const [hotels, setHotels] = useState<PublicHotel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    async (ci: string, co: string) => {
      if (co <= ci) {
        setError("Check-out must be after check-in.");
        return;
      }
      setError(null);
      setLoading(true);
      try {
        const { data } = await api.get<PublicHotel[]>("/public/hotels", {
          params: { check_in: ci, check_out: co },
        });
        setHotels(data);
      } catch (err) {
        if (isAxiosError(err) && err.response?.status === 422) {
          setError("Please choose valid check-in and check-out dates.");
        } else {
          toast({ variant: "destructive", title: "Search failed" });
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Show results immediately on first load with the default date window.
  useEffect(() => {
    void search(addDays(1), addDays(3));
  }, [search]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void search(checkIn, checkOut);
  };

  const nights = useMemo(() => {
    if (!checkIn || !checkOut || checkOut <= checkIn) return 0;
    return Math.round(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000
    );
  }, [checkIn, checkOut]);

  // "Destination" filters the returned list client-side (the API filters by
  // availability + optional geo, not free-text).
  const visible = useMemo(() => {
    const list = hotels ?? [];
    const q = destination.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        (h.address ?? "").toLowerCase().includes(q)
    );
  }, [hotels, destination]);

  return (
    <div>
      {/* ---------------- Hero + search ---------------- */}
      <section className="relative overflow-hidden border-b bg-gradient-to-br from-primary via-primary/90 to-primary/70 text-primary-foreground">
        <div
          aria-hidden
          className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-primary-foreground/10 blur-3xl"
        />
        <div className="relative z-10 mx-auto max-w-6xl px-4 pb-28 pt-16 sm:px-6 lg:px-8">
          <Badge
            variant="outline"
            className="border-primary-foreground/30 text-primary-foreground"
          >
            <Star className="mr-1 h-3 w-3" />
            Escrow-protected · Verified check-in
          </Badge>
          <h1 className="mt-4 max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
            Book your stay in Ulaanbaatar
          </h1>
          <p className="mt-3 max-w-xl text-primary-foreground/80 sm:text-lg">
            Real-time availability, instant QPay checkout, and payment held
            safely until you&apos;re checked in.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <Card className="relative z-20 -mt-16 shadow-lg">
          <CardContent className="pt-6">
            <form
              onSubmit={handleSubmit}
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_auto] lg:items-end"
            >
              <div className="space-y-2">
                <Label htmlFor="destination">Destination</Label>
                <Input
                  id="destination"
                  placeholder="Hotel name or area"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="check-in">Check-in</Label>
                <Input
                  id="check-in"
                  type="date"
                  min={addDays(0)}
                  value={checkIn}
                  onChange={(e) => setCheckIn(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="check-out">Check-out</Label>
                <Input
                  id="check-out"
                  type="date"
                  min={addDays(0)}
                  value={checkOut}
                  onChange={(e) => setCheckOut(e.target.value)}
                />
              </div>
              <Button type="submit" className="h-9 lg:w-full" disabled={loading}>
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                Search
              </Button>
            </form>
            {error && (
              <p className="mt-2 text-sm text-destructive">{error}</p>
            )}
          </CardContent>
        </Card>

        {/* ---------------- Results ---------------- */}
        <section className="py-10">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">
              {hotels === null
                ? "Finding stays…"
                : `${visible.length} stay${visible.length === 1 ? "" : "s"} available`}
            </h2>
            {nights > 0 && (
              <span className="text-sm text-muted-foreground">
                {nights} night{nights === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {loading || hotels === null ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : visible.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                No hotels match these dates. Try a different window.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((hotel) => {
                const bookable = hotel.available_rooms > 0;
                return (
                  <Card key={hotel.tenant_id} className="flex flex-col overflow-hidden">
                    <div className="flex h-32 items-center justify-center bg-gradient-to-br from-muted to-muted/40">
                      <BedDouble className="h-10 w-10 text-muted-foreground/40" />
                    </div>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-start justify-between gap-2 text-base">
                        <span>{hotel.name}</span>
                        {bookable ? (
                          <Badge variant="success" className="shrink-0">
                            <Sparkles className="mr-1 h-3 w-3" />
                            {hotel.available_rooms} left
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="shrink-0">
                            Full
                          </Badge>
                        )}
                      </CardTitle>
                      {hotel.address && (
                        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          {hotel.address}
                        </p>
                      )}
                    </CardHeader>
                    <CardContent className="flex-1">
                      {hotel.min_nightly_rate !== null ? (
                        <p className="text-sm text-muted-foreground">
                          from{" "}
                          <span className="text-lg font-semibold text-foreground">
                            {formatMNT(hotel.min_nightly_rate)}
                          </span>{" "}
                          / night
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Rates on request
                        </p>
                      )}
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        Free cancellation until payment
                      </p>
                    </CardContent>
                    <CardFooter>
                      <Link
                        href={`/hotel/${hotel.tenant_id}?check_in=${checkIn}&check_out=${checkOut}`}
                        className="w-full"
                      >
                        <Button className="w-full" disabled={!bookable}>
                          {bookable ? "View rooms" : "Sold out"}
                        </Button>
                      </Link>
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
