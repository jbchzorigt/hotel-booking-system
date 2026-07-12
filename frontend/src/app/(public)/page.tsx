"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { isAxiosError } from "axios";
import {
  ArrowRight,
  Building2,
  CalendarDays,
  CheckCircle2,
  Crown,
  Gem,
  Globe,
  Loader2,
  MapPin,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Split,
  Sun,
  Sunrise,
  Sparkles,
  UtensilsCrossed,
  Users,
  Wallet,
} from "lucide-react";

import api from "@/lib/axios";
import { formatDate, formatMNT } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import HotelCard from "@/components/public/HotelCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PublicHotel } from "@/types/api";

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// ===========================================================================
// Folded-paper card — the signature detail of the reference design.
// clip-path slices the corner off; a gradient triangle laid into the cut
// reads as the underside of a folded sheet.
// ===========================================================================
const FOLD = "1.75rem";

function FoldedCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative rounded-2xl bg-white shadow-lg shadow-blue-900/5",
        className
      )}
      style={{
        clipPath: `polygon(0 0, 100% 0, 100% calc(100% - ${FOLD}), calc(100% - ${FOLD}) 100%, 0 100%)`,
      }}
    >
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0"
        style={{
          width: FOLD,
          height: FOLD,
          background:
            "linear-gradient(135deg, #eef4fc 0%, #cdddf2 55%, #a9c4e6 100%)",
          clipPath: "polygon(0 0, 100% 0, 0 100%)",
          filter: "drop-shadow(-1px -1px 2px rgba(30, 64, 175, 0.12))",
        }}
      />
    </div>
  );
}

// ===========================================================================
// Page
// ===========================================================================
export default function MarketplaceHome() {
  const [destination, setDestination] = useState("");
  const [checkIn, setCheckIn] = useState(addDays(1));
  const [checkOut, setCheckOut] = useState(addDays(3));
  const [guests, setGuests] = useState(2);
  const [hotels, setHotels] = useState<PublicHotel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [newsletter, setNewsletter] = useState("");
  const resultsRef = useRef<HTMLElement | null>(null);

  const search = useCallback(async (ci: string, co: string, scroll = false) => {
    if (co <= ci) {
      toast({
        variant: "destructive",
        title: "Check-out must be after check-in",
      });
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get<PublicHotel[]>("/public/hotels", {
        params: { check_in: ci, check_out: co },
      });
      setHotels(data);
      if (scroll) {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 422) {
        toast({ variant: "destructive", title: "Please choose valid dates" });
      } else {
        toast({ variant: "destructive", title: "Search failed" });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void search(addDays(1), addDays(3));
  }, [search]);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void search(checkIn, checkOut, true);
  };

  const visibleHotels = useMemo(() => {
    const list = hotels ?? [];
    const q = destination.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        (h.address ?? "").toLowerCase().includes(q)
    );
  }, [hotels, destination]);

  const nights = useMemo(() => {
    if (checkOut <= checkIn) return 0;
    return Math.round(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000
    );
  }, [checkIn, checkOut]);

  const handleNewsletter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newsletter.trim().length < 5) return;
    setNewsletter("");
    toast({
      title: "You're on the list!",
      description: "We'll send special deals and travel inspiration.",
    });
  };

  return (
    <div className="bg-gradient-to-b from-blue-50 via-white to-blue-50 text-slate-700">
      {/* ================================================================ */}
      {/* 1. HERO — deep-sky gradient with floating search bar overlap     */}
      {/* ================================================================ */}
      <section className="relative overflow-hidden bg-gradient-to-br from-blue-700 via-blue-500 to-sky-400">
        {/* soft clouds */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -left-24 top-10 h-48 w-96 rounded-full bg-white/25 blur-3xl" />
          <div className="absolute right-0 top-32 h-40 w-80 rounded-full bg-white/20 blur-3xl" />
          <div className="absolute -bottom-10 left-1/3 h-44 w-96 rounded-full bg-white/15 blur-3xl" />
          {/* paper plane + dashed flight path */}
          <Send
            className="absolute right-[12%] top-16 hidden h-24 w-24 -rotate-12 text-white/85 drop-shadow-xl md:block"
            strokeWidth={1}
            fill="white"
          />
          <svg
            className="absolute right-[14%] top-36 hidden h-24 w-64 md:block"
            viewBox="0 0 260 100"
            fill="none"
          >
            <path
              d="M255 5 C 180 60, 90 80, 5 95"
              stroke="rgba(255,255,255,0.6)"
              strokeWidth="2"
              strokeDasharray="6 8"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <div className="relative mx-auto max-w-6xl px-4 pb-36 pt-16 sm:px-6 sm:pt-20 lg:px-8">
          <h1 className="max-w-2xl text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
            The Operating System for Modern Hotels &amp; Dining
          </h1>
          <p className="mt-4 max-w-xl text-base text-blue-50/90 sm:text-lg">
            Explore verified stays, book in seconds with e-Mongolia, and enjoy
            in-room dining — every payment protected by escrow.
          </p>
        </div>

        {/* angled white base under the search bar */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-16 bg-blue-50"
          style={{ clipPath: "polygon(0 100%, 100% 100%, 100% 30%, 0 85%)" }}
        />
      </section>

      {/* Floating search bar — overlaps hero bottom */}
      <div className="relative z-20 mx-auto -mt-24 max-w-5xl px-4 sm:px-6 lg:px-8">
        <FoldedCard className="p-3 sm:p-4">
          <form
            onSubmit={handleSearch}
            className="grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr_0.8fr_auto] lg:items-center"
          >
            <label className="flex items-center gap-3 rounded-xl px-3 py-2 transition-colors focus-within:bg-blue-50/70 lg:border-r lg:border-blue-100">
              <MapPin className="h-5 w-5 shrink-0 text-blue-500" />
              <span className="w-full">
                <span className="block text-xs font-medium text-slate-400">
                  Location / Hotel
                </span>
                <Input
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="Anywhere in Ulaanbaatar"
                  className="h-6 border-0 p-0 text-sm font-semibold text-slate-800 shadow-none focus-visible:ring-0"
                />
              </span>
            </label>

            <label className="flex items-center gap-3 rounded-xl px-3 py-2 focus-within:bg-blue-50/70 lg:border-r lg:border-blue-100">
              <CalendarDays className="h-5 w-5 shrink-0 text-blue-500" />
              <span className="w-full">
                <span className="block text-xs font-medium text-slate-400">
                  Check-in
                </span>
                <Input
                  type="date"
                  min={addDays(0)}
                  value={checkIn}
                  onChange={(e) => setCheckIn(e.target.value)}
                  className="h-6 border-0 p-0 text-sm font-semibold text-slate-800 shadow-none focus-visible:ring-0"
                />
              </span>
            </label>

            <label className="flex items-center gap-3 rounded-xl px-3 py-2 focus-within:bg-blue-50/70 lg:border-r lg:border-blue-100">
              <CalendarDays className="h-5 w-5 shrink-0 text-blue-500" />
              <span className="w-full">
                <span className="block text-xs font-medium text-slate-400">
                  Check-out
                </span>
                <Input
                  type="date"
                  min={addDays(0)}
                  value={checkOut}
                  onChange={(e) => setCheckOut(e.target.value)}
                  className="h-6 border-0 p-0 text-sm font-semibold text-slate-800 shadow-none focus-visible:ring-0"
                />
              </span>
            </label>

            <label className="flex items-center gap-3 rounded-xl px-3 py-2 focus-within:bg-blue-50/70">
              <Users className="h-5 w-5 shrink-0 text-blue-500" />
              <span className="w-full">
                <span className="block text-xs font-medium text-slate-400">
                  Guests
                </span>
                <select
                  value={guests}
                  onChange={(e) => setGuests(Number(e.target.value))}
                  className="w-full bg-transparent text-sm font-semibold text-slate-800 outline-none"
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} guest{n === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
              </span>
            </label>

            <Button
              type="submit"
              disabled={loading}
              className="h-12 rounded-xl bg-blue-600 px-6 text-sm font-semibold shadow-md shadow-blue-600/30 hover:bg-blue-700 lg:mr-4"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Search Rooms
            </Button>
          </form>
        </FoldedCard>
      </div>

      {/* ================================================================ */}
      {/* 2. TRUST & INTEGRATIONS BANNER                                    */}
      {/* ================================================================ */}
      <div className="mx-auto mt-6 max-w-5xl px-4 sm:px-6 lg:px-8">
        <FoldedCard className="px-6 py-5">
          <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            {[
              {
                icon: Globe,
                title: "Powered by KHUR",
                text: "State-verified guest identity",
              },
              {
                icon: ShieldCheck,
                title: "Secured by e-Mongolia",
                text: "National SSO — no passwords",
              },
              {
                icon: Wallet,
                title: "Integrated with QPay",
                text: "Scan, pay, escrow-protected",
              },
              {
                icon: CheckCircle2,
                title: "Zero Double-Bookings",
                text: "Guaranteed at the database",
              },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-sky-50 shadow-inner">
                  <Icon className="h-5 w-5 text-blue-600" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-800">
                    {title}
                  </span>
                  <span className="block text-xs text-slate-400">{text}</span>
                </span>
              </div>
            ))}
          </div>
        </FoldedCard>
      </div>

      {/* ================================================================ */}
      {/* 2b. SOCIAL PROOF — infinite logo marquee                          */}
      {/* ================================================================ */}
      <LogoMarquee />

      {/* ================================================================ */}
      {/* 3. FEATURED HOTELS — live availability, package-card styling      */}
      {/* ================================================================ */}
      <section
        ref={resultsRef}
        className="mx-auto max-w-6xl scroll-mt-24 px-4 pb-4 pt-16 sm:px-6 lg:px-8"
      >
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">
              Featured Hotels
            </h2>
            <p className="text-sm text-slate-400">
              {nights} night{nights === 1 ? "" : "s"} ·{" "}
              {new Date(`${checkIn}T00:00:00`).toLocaleDateString()} –{" "}
              {new Date(`${checkOut}T00:00:00`).toLocaleDateString()}
            </p>
          </div>
          <span className="hidden items-center gap-1 text-sm font-medium text-blue-600 sm:flex">
            Live availability
            <ArrowRight className="h-4 w-4" />
          </span>
        </div>

        {hotels === null || loading ? (
          <div className="flex h-56 items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-blue-400" />
          </div>
        ) : visibleHotels.length === 0 ? (
          <FoldedCard className="py-16 text-center">
            <p className="text-sm text-slate-400">
              No hotels match these dates — try a different window.
            </p>
          </FoldedCard>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {visibleHotels.slice(0, 6).map((hotel, index) => {
              const bookable = hotel.available_rooms > 0;
              return (
                <HotelCard
                  key={hotel.tenant_id}
                  title={hotel.name}
                  meta={[
                    `${formatDate(checkIn)} – ${formatDate(checkOut)}`,
                    bookable
                      ? `${hotel.available_rooms} room${
                          hotel.available_rooms === 1 ? "" : "s"
                        } left`
                      : "Fully booked",
                  ]}
                  description={
                    hotel.address
                      ? `${hotel.address}. Escrow-protected booking with verified check-in and in-room dining.`
                      : "Escrow-protected booking with verified check-in and in-room dining."
                  }
                  price={
                    hotel.min_nightly_rate !== null
                      ? formatMNT(hotel.min_nightly_rate)
                      : "—"
                  }
                  rating={4.8 - (index % 3) / 10}
                  tags={
                    index % 2 === 0
                      ? ["Verified", "In-room dining"]
                      : ["Verified"]
                  }
                  topRated={index === 0}
                  href={`/hotel/${hotel.tenant_id}?check_in=${checkIn}&check_out=${checkOut}`}
                  ctaLabel={bookable ? "Book Now" : "Sold out"}
                  disabled={!bookable}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* ================================================================ */}
      {/* 4. HOW IT WORKS — dotted process line                             */}
      {/* ================================================================ */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
        <FoldedCard className="px-6 py-10 sm:px-10">
          <h2 className="mb-10 text-center text-2xl font-bold tracking-tight text-slate-900">
            How It Works
          </h2>
          <div className="flex flex-col gap-8 md:flex-row md:items-start md:gap-0">
            {[
              {
                icon: Search,
                step: "01",
                title: "Search Room",
                text: "Real date-range availability across every hotel.",
              },
              {
                icon: Smartphone,
                step: "02",
                title: "Book with e-Mongolia",
                text: "One-tap national SSO — no accounts, no passwords.",
              },
              {
                icon: UtensilsCrossed,
                step: "03",
                title: "Order In-Room Dining",
                text: "Nearby restaurants deliver straight to your room.",
              },
              {
                icon: Split,
                step: "04",
                title: "Auto-Checkout & Split Escrow",
                text: "Funds release automatically — 95% hotel, 5% platform.",
              },
            ].map(({ icon: Icon, step, title, text }, i, arr) => (
              <div key={step} className="flex flex-1 items-start md:contents">
                <div className="flex flex-1 flex-col items-center text-center">
                  <div className="relative">
                    <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 shadow-lg shadow-blue-600/30">
                      <Icon className="h-9 w-9 text-white" strokeWidth={1.75} />
                    </span>
                    <span className="absolute -bottom-2 -left-2 flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white shadow">
                      {step}
                    </span>
                  </div>
                  <h3 className="mt-4 text-sm font-bold text-slate-800">
                    {title}
                  </h3>
                  <p className="mt-1 max-w-[13rem] text-xs leading-relaxed text-slate-400">
                    {text}
                  </p>
                </div>
                {i < arr.length - 1 && (
                  <div
                    aria-hidden
                    className="mt-10 hidden w-16 shrink-0 border-t-2 border-dashed border-blue-300 md:block"
                  />
                )}
              </div>
            ))}
          </div>
        </FoldedCard>
      </section>

      {/* ================================================================ */}
      {/* 5. PRICING — B2B ecosystem plans, elevated middle card            */}
      {/* ================================================================ */}
      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:px-8">
        <h2 className="mb-2 text-2xl font-bold tracking-tight text-slate-900">
          Ecosystem Plans
        </h2>
        <p className="mb-10 text-sm text-slate-400">
          For guests it&apos;s always free — hotels and restaurants pick a plan.
        </p>

        <div className="grid items-start gap-6 lg:grid-cols-3 lg:gap-8">
          <PricingCard
            icon={Send}
            name="B2C GUEST APP"
            price="Free"
            period="forever"
            features={[
              "Search & book instantly",
              "QPay payments in escrow",
              "e-Mongolia sign-in",
              "In-room dining orders",
            ]}
            cta="Book a stay"
            href="/"
          />
          <PricingCard
            icon={Building2}
            name="HOTEL MANAGER"
            price={formatMNT(490000)}
            period="/month"
            popular
            features={[
              "Front desk & housekeeping",
              "KHUR-verified check-in",
              "Minibar & walk-in billing",
              "Live revenue dashboards",
              "5% marketplace commission",
            ]}
            cta="Request onboarding"
            href="/join"
          />
          <PricingCard
            icon={UtensilsCrossed}
            name="FULL ECOSYSTEM"
            price={formatMNT(790000)}
            period="/month"
            features={[
              "Everything in Hotel Manager",
              "Restaurant partner portal",
              "Kitchen display system",
              "In-room dining marketplace",
              "Priority support",
            ]}
            cta="Talk to sales"
            href="/join"
          />
        </div>
      </section>

      {/* ================================================================ */}
      {/* 6. NEWSLETTER BAND                                                */}
      {/* ================================================================ */}
      <section className="relative overflow-hidden bg-gradient-to-r from-blue-700 via-blue-600 to-sky-500">
        <div
          aria-hidden
          className="absolute -left-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl"
        />
        <Send
          aria-hidden
          className="absolute -bottom-6 left-8 hidden h-24 w-24 rotate-12 text-white/20 md:block"
          strokeWidth={1}
        />
        <div className="relative mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-4 py-10 sm:px-6 md:flex-row lg:px-8">
          <div>
            <h2 className="text-xl font-bold text-white">
              Let&apos;s keep in touch!
            </h2>
            <p className="text-sm text-blue-100/80">
              Subscribe for special deals and travel inspiration.
            </p>
          </div>
          <form
            onSubmit={handleNewsletter}
            className="flex w-full max-w-md overflow-hidden rounded-xl bg-white p-1 shadow-lg"
          >
            <Input
              type="email"
              required
              value={newsletter}
              onChange={(e) => setNewsletter(e.target.value)}
              placeholder="Enter your email"
              className="border-0 shadow-none focus-visible:ring-0"
            />
            <Button
              type="submit"
              className="shrink-0 rounded-lg bg-blue-600 hover:bg-blue-700"
            >
              Subscribe
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}

// ===========================================================================
// Social-proof logo marquee — seamless infinite scroll, pause on hover.
// The track renders the logo list twice; the `marquee` keyframe slides
// exactly -50%, so the restart lands on the duplicate and is invisible.
// ===========================================================================
const HOTEL_LOGOS: {
  name: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  wordmark: string;
  color: string;
  tagline?: string;
}[] = [
  {
    name: "Shangri-La",
    icon: Crown,
    wordmark: "font-serif tracking-[0.25em]",
    color: "text-amber-600",
    tagline: "HOTELS & RESORTS",
  },
  {
    name: "KEMPINSKI",
    icon: Gem,
    wordmark: "font-serif tracking-[0.35em]",
    color: "text-red-700",
    tagline: "HOTELIERS SINCE 1897",
  },
  {
    name: "NOVOTEL",
    icon: Sunrise,
    wordmark: "font-sans font-bold tracking-[0.2em]",
    color: "text-sky-600",
  },
  {
    name: "Blue Sky Tower",
    icon: Building2,
    wordmark: "font-sans font-semibold italic tracking-wide",
    color: "text-blue-600",
    tagline: "ULAANBAATAR",
  },
  {
    name: "Holiday Inn",
    icon: Sun,
    wordmark: "font-serif italic font-bold tracking-tight",
    color: "text-emerald-600",
  },
  {
    name: "RAMADA",
    icon: Sparkles,
    wordmark: "font-sans font-extrabold tracking-[0.15em]",
    color: "text-rose-600",
    tagline: "BY WYNDHAM",
  },
];

function LogoMarquee() {
  const LogoRow = ({ hidden = false }: { hidden?: boolean }) => (
    <ul
      aria-hidden={hidden || undefined}
      className="flex shrink-0 items-center"
    >
      {HOTEL_LOGOS.map(({ name, icon: Icon, wordmark, color, tagline }) => (
        <li
          key={name}
          className="mx-10 flex shrink-0 cursor-default select-none items-center gap-2.5 grayscale opacity-50 transition-all duration-300 hover:grayscale-0 hover:opacity-100"
        >
          <Icon className={cn("h-7 w-7", color)} strokeWidth={1.5} />
          <span className="leading-none">
            <span
              className={cn("block whitespace-nowrap text-lg", wordmark, color)}
            >
              {name.toUpperCase()}
            </span>
            {tagline && (
              <span className="mt-0.5 block text-[0.55rem] font-medium tracking-[0.3em] text-slate-500">
                {tagline}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="mt-12 border-y border-blue-100/70 bg-white/70 py-8">
      <p className="mb-6 text-center text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
        Trusted by top luxury hotels &amp; resorts
      </p>
      {/* group => hovering anywhere pauses the track */}
      <div className="group relative overflow-hidden">
        {/* edge fades */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-white to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-white to-transparent"
        />
        <div className="flex w-max animate-marquee group-hover:[animation-play-state:paused] motion-reduce:[animation-play-state:paused]">
          <LogoRow />
          <LogoRow hidden />
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// Pricing card — folded corner, elevated "MOST POPULAR" middle variant
// ===========================================================================
function PricingCard({
  icon: Icon,
  name,
  price,
  period,
  features,
  cta,
  href,
  popular = false,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  name: string;
  price: string;
  period: string;
  features: string[];
  cta: string;
  href: string;
  popular?: boolean;
}) {
  return (
    <div className={cn("relative", popular && "lg:-mt-6")}>
      {popular && (
        <div
          className="absolute -top-4 left-1/2 z-10 -translate-x-1/2 bg-gradient-to-r from-blue-600 to-blue-500 px-8 py-1.5 text-xs font-bold tracking-wide text-white shadow-md shadow-blue-600/30"
          style={{ clipPath: "polygon(8% 0, 92% 0, 100% 100%, 0 100%)" }}
        >
          MOST POPULAR
        </div>
      )}
      <FoldedCard
        className={cn(
          "flex flex-col p-7",
          popular &&
            "border-2 border-blue-200 shadow-xl shadow-blue-600/10 lg:pb-12"
        )}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-blue-100 to-sky-50">
          <Icon className="h-5 w-5 text-blue-600" strokeWidth={1.75} />
        </span>
        <h3 className="mt-4 text-xs font-bold tracking-widest text-slate-400">
          {name}
        </h3>
        <p className="mt-1">
          <span className="text-3xl font-bold text-slate-900">{price}</span>{" "}
          <span className="text-xs text-slate-400">{period}</span>
        </p>
        <ul className="mt-5 flex-1 space-y-2.5">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
              <span className="text-slate-600">{feature}</span>
            </li>
          ))}
        </ul>
        <Link href={href} className="mt-7 block">
          <Button
            className={cn(
              "w-full rounded-xl",
              popular
                ? "bg-blue-600 shadow-md shadow-blue-600/30 hover:bg-blue-700"
                : "border border-blue-200 bg-white text-blue-700 hover:bg-blue-50"
            )}
          >
            {cta}
          </Button>
        </Link>
      </FoldedCard>
    </div>
  );
}
