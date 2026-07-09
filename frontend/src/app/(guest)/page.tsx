"use client";

import { useState } from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import {
  BedDouble,
  Crosshair,
  Loader2,
  MapPin,
  Search,
  Star,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { HotelSearchResult } from "@/types/api";

// Ulaanbaatar city centre — a sensible default for the demo dataset.
const DEFAULT_LAT = 47.9185;
const DEFAULT_LNG = 106.9177;

// Mirrors the /marketplace/search query constraints.
const searchSchema = z
  .object({
    lat: z.coerce
      .number({ message: "Latitude must be a number" })
      .min(-90, "≥ -90")
      .max(90, "≤ 90"),
    lng: z.coerce
      .number({ message: "Longitude must be a number" })
      .min(-180, "≥ -180")
      .max(180, "≤ 180"),
    radius_km: z.coerce
      .number({ message: "Radius must be a number" })
      .gt(0, "Must be positive")
      .max(50, "At most 50 km"),
    check_in: z.string().optional(),
    check_out: z.string().optional(),
  })
  .refine((v) => !!v.check_in === !!v.check_out, {
    message: "Provide both dates, or neither",
    path: ["check_out"],
  })
  .refine(
    (v) => !v.check_in || !v.check_out || v.check_out > v.check_in,
    { message: "Check-out must be after check-in", path: ["check_out"] }
  );

type SearchFormValues = z.infer<typeof searchSchema>;

export default function MarketplaceHomePage() {
  const [results, setResults] = useState<HotelSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [searchedDates, setSearchedDates] = useState<{
    check_in?: string;
    check_out?: string;
  }>({});

  const form = useForm<SearchFormValues>({
    resolver: zodResolver(searchSchema),
    defaultValues: {
      lat: DEFAULT_LAT,
      lng: DEFAULT_LNG,
      radius_km: 5,
      check_in: "",
      check_out: "",
    },
  });

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      toast({
        variant: "destructive",
        title: "Geolocation is not available in this browser",
      });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        form.setValue("lat", Number(position.coords.latitude.toFixed(6)), {
          shouldValidate: true,
        });
        form.setValue("lng", Number(position.coords.longitude.toFixed(6)), {
          shouldValidate: true,
        });
        setLocating(false);
      },
      () => {
        toast({
          variant: "destructive",
          title: "Could not read your location",
          description: "Enter coordinates manually instead.",
        });
        setLocating(false);
      },
      { timeout: 8000 }
    );
  };

  const onSubmit = async (values: SearchFormValues) => {
    setSearching(true);
    try {
      const { data } = await api.get<HotelSearchResult[]>(
        "/marketplace/search",
        {
          params: {
            lat: values.lat,
            lng: values.lng,
            radius_km: values.radius_km,
            ...(values.check_in && values.check_out
              ? { check_in: values.check_in, check_out: values.check_out }
              : {}),
          },
        }
      );
      setResults(data);
      setSearchedDates({
        check_in: values.check_in || undefined,
        check_out: values.check_out || undefined,
      });
    } catch (err) {
      const detail =
        isAxiosError(err) && err.response?.status === 422
          ? "Check the search inputs and try again."
          : "Please try again in a moment.";
      toast({
        variant: "destructive",
        title: "Search failed",
        description: detail,
      });
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-10">
      {/* ---------------- Hero ---------------- */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary/90 to-primary/70 px-6 py-16 text-primary-foreground sm:px-12">
        <div className="relative z-10 max-w-2xl space-y-4">
          <Badge
            variant="outline"
            className="border-primary-foreground/30 text-primary-foreground"
          >
            <Star className="mr-1 h-3 w-3" />
            Verified check-in · Escrow-protected payments
          </Badge>
          <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">
            Find your stay in Ulaanbaatar
          </h1>
          <p className="max-w-xl text-primary-foreground/80 sm:text-lg">
            Search hotels near you, book instantly, and order food straight
            to your room — your payment is held in escrow until you get what
            you paid for.
          </p>
        </div>
        <div
          aria-hidden
          className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-primary-foreground/10 blur-3xl"
        />
      </section>

      {/* ---------------- Geo search ---------------- */}
      <section className="mx-auto -mt-20 max-w-4xl px-2 sm:px-0">
        <Card className="relative z-20 shadow-lg">
          <CardContent className="pt-6">
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6"
                noValidate
              >
                <FormField
                  control={form.control}
                  name="lat"
                  render={({ field }) => (
                    <FormItem className="lg:col-span-1">
                      <FormLabel>Latitude</FormLabel>
                      <FormControl>
                        <Input type="number" step="any" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="lng"
                  render={({ field }) => (
                    <FormItem className="lg:col-span-1">
                      <FormLabel>Longitude</FormLabel>
                      <FormControl>
                        <Input type="number" step="any" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="radius_km"
                  render={({ field }) => (
                    <FormItem className="lg:col-span-1">
                      <FormLabel>Radius (km)</FormLabel>
                      <FormControl>
                        <Input type="number" min={1} max={50} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="check_in"
                  render={({ field }) => (
                    <FormItem className="lg:col-span-1">
                      <FormLabel>Check-in</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="check_out"
                  render={({ field }) => (
                    <FormItem className="lg:col-span-1">
                      <FormLabel>Check-out</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex items-end gap-2 lg:col-span-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={useMyLocation}
                    disabled={locating}
                    aria-label="Use my location"
                    title="Use my location"
                  >
                    {locating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Crosshair className="h-4 w-4" />
                    )}
                  </Button>
                  <Button type="submit" className="flex-1" disabled={searching}>
                    {searching ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    Search
                  </Button>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      </section>

      {/* ---------------- Results ---------------- */}
      {results !== null && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold tracking-tight">
            {results.length} hotel{results.length === 1 ? "" : "s"} found
          </h2>
          {results.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No hotels in this radius — try widening the search.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {results.map((hotel) => {
                const bookable = hotel.available_rooms > 0;
                const datesQuery =
                  searchedDates.check_in && searchedDates.check_out
                    ? `?check_in=${searchedDates.check_in}&check_out=${searchedDates.check_out}`
                    : "";
                return (
                  <Card key={hotel.tenant_id} className="flex flex-col">
                    <CardHeader>
                      <CardTitle className="flex items-start justify-between gap-2 text-base">
                        <span>{hotel.name}</span>
                        <Badge variant="secondary" className="shrink-0">
                          {hotel.distance_km.toFixed(1)} km
                        </Badge>
                      </CardTitle>
                      {hotel.address && (
                        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          {hotel.address}
                        </p>
                      )}
                    </CardHeader>
                    <CardContent className="flex-1 space-y-2">
                      <p className="flex items-center gap-2 text-sm">
                        <BedDouble className="h-4 w-4 text-muted-foreground" />
                        {bookable ? (
                          <>
                            <span className="font-medium">
                              {hotel.available_rooms} room
                              {hotel.available_rooms === 1 ? "" : "s"}
                            </span>
                            <span className="text-muted-foreground">
                              {searchedDates.check_in
                                ? "free for your dates"
                                : "active"}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">
                            No availability
                          </span>
                        )}
                      </p>
                      {hotel.min_nightly_rate !== null && (
                        <p className="text-sm text-muted-foreground">
                          From{" "}
                          <span className="text-base font-semibold text-foreground">
                            {formatMNT(hotel.min_nightly_rate)}
                          </span>{" "}
                          / night
                        </p>
                      )}
                    </CardContent>
                    <CardFooter>
                      <Link
                        href={`/hotel/${hotel.tenant_id}${datesQuery}`}
                        className="w-full"
                      >
                        <Button className="w-full" disabled={!bookable}>
                          {bookable ? "View rooms" : "Fully booked"}
                        </Button>
                      </Link>
                    </CardFooter>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
