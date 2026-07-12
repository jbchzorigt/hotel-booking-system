"use client";

import {
  FormEvent,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { isAxiosError } from "axios";
import { QRCodeSVG } from "qrcode.react";
import {
  BadgeCheck,
  CalendarClock,
  Copy,
  Loader2,
  PartyPopper,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  GuestTokenResponse,
  PublicBookingResponse,
  PublicBookingStatus,
} from "@/types/api";

const POLL_INTERVAL_MS = 3000;

interface Guest {
  full_name: string;
  phone: string;
}

interface StayContext {
  roomId: string;
  hotel: string;
  room: string;
  type: string;
  rate: number;
  checkIn: string;
  checkOut: string;
  nights: number;
  total: number;
}

function CheckoutInner() {
  const params = useSearchParams();

  // -- Parse the stay context from the query string -------------------- //
  const roomId = params.get("room_id");
  const checkIn = params.get("check_in") ?? "";
  const checkOut = params.get("check_out") ?? "";
  const rate = Number(params.get("rate") ?? "0");
  const nights =
    checkIn && checkOut && checkOut > checkIn
      ? Math.round(
          (new Date(checkOut).getTime() - new Date(checkIn).getTime()) /
            86_400_000
        )
      : 0;

  const stay: StayContext | null = roomId
    ? {
        roomId,
        hotel: params.get("hotel") ?? "Hotel",
        room: params.get("room") ?? "",
        type: params.get("type") ?? "",
        rate,
        checkIn,
        checkOut,
        nights,
        total: rate * nights,
      }
    : null;

  const [guest, setGuest] = useState<Guest | null>(null);
  const [booking, setBooking] = useState<PublicBookingResponse | null>(null);
  const [funded, setFunded] = useState(false);

  if (!stay || stay.nights < 1) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-lg font-semibold">Nothing to check out</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Start by choosing a room and dates.
        </p>
        <Link href="/" className="mt-4 inline-block">
          <Button variant="outline">Find a stay</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[1fr_360px] lg:px-8">
      {/* ---------------- Left: the active step ---------------- */}
      <div className="order-2 lg:order-1">
        {funded && booking ? (
          <SuccessScreen booking={booking} stay={stay} />
        ) : booking ? (
          <PaymentStep
            booking={booking}
            onFunded={() => setFunded(true)}
          />
        ) : guest ? (
          <ReviewStep
            stay={stay}
            guest={guest}
            onBooked={setBooking}
            onChangeGuest={() => setGuest(null)}
          />
        ) : (
          <EMongoliaLogin onLoggedIn={setGuest} />
        )}
      </div>

      {/* ---------------- Right: sticky order summary ---------------- */}
      <aside className="order-1 lg:order-2">
        <Card className="lg:sticky lg:top-20">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{stay.hotel}</CardTitle>
            <CardDescription className="capitalize">
              {stay.type.toLowerCase()} · Room {stay.room}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <CalendarClock className="h-4 w-4" />
              {new Date(`${stay.checkIn}T00:00:00`).toLocaleDateString()} →{" "}
              {new Date(`${stay.checkOut}T00:00:00`).toLocaleDateString()}
            </div>
            <div className="flex justify-between border-t pt-3">
              <span className="text-muted-foreground">
                {formatMNT(stay.rate)} × {stay.nights} night
                {stay.nights === 1 ? "" : "s"}
              </span>
              <span className="tabular-nums">{formatMNT(stay.total)}</span>
            </div>
            <div className="flex justify-between text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMNT(stay.total)}</span>
            </div>
            <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Held in escrow until check-in
            </p>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

// ===========================================================================
// Step 1 — e-Mongolia mock SSO
// ===========================================================================
function EMongoliaLogin({ onLoggedIn }: { onLoggedIn: (g: Guest) => void }) {
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await api.post<GuestTokenResponse>("/auth/emongolia", {
        phone: phone.trim(),
      });
      onLoggedIn({ full_name: data.full_name, phone: phone.trim() });
      toast({ title: `Welcome, ${data.full_name}` });
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 422) {
        setError("Enter a valid phone number (6+ digits).");
      } else if (isAxiosError(err) && err.response?.status === 401) {
        setError("e-Mongolia could not verify that identity.");
      } else {
        setError("Sign-in failed. Please try again.");
      }
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Smartphone className="h-5 w-5 text-muted-foreground" />
          Sign in to book
        </CardTitle>
        <CardDescription>
          We confirm your identity through e-Mongolia — no account or
          password needed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone number</Label>
            <Input
              id="phone"
              type="tel"
              placeholder="+976 9911 2233"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoFocus
              disabled={submitting}
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || phone.trim().length < 6}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Verifying…
              </>
            ) : (
              "Continue with e-Mongolia"
            )}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Mock SSO for demo — any valid phone number works.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// Step 2 — review guest details + create the PENDING booking
// ===========================================================================
function ReviewStep({
  stay,
  guest,
  onBooked,
  onChangeGuest,
}: {
  stay: StayContext;
  guest: Guest;
  onBooked: (b: PublicBookingResponse) => void;
  onChangeGuest: () => void;
}) {
  const [fullName, setFullName] = useState(guest.full_name);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setConflict(false);
    setSubmitting(true);
    try {
      const { data } = await api.post<PublicBookingResponse>(
        "/public/bookings",
        {
          room_id: stay.roomId,
          guest_full_name: fullName.trim(),
          guest_phone: guest.phone,
          guest_email: email.trim() || null,
          check_in_date: stay.checkIn,
          check_out_date: stay.checkOut,
        }
      );
      onBooked(data);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        setConflict(true);
      } else if (isAxiosError(err) && err.response?.status === 422) {
        setError("Please check your details and dates.");
      } else if (isAxiosError(err) && err.response?.status === 404) {
        setError("This room is no longer available.");
      } else {
        setError("Could not create the booking. Please try again.");
      }
      setSubmitting(false);
    }
  };

  if (conflict) {
    return (
      <Card className="border-amber-300 dark:border-amber-800">
        <CardHeader className="items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50">
            <TriangleAlert className="h-6 w-6 text-amber-600 dark:text-amber-400" />
          </span>
          <CardTitle className="pt-2">Room just taken</CardTitle>
          <CardDescription>
            Someone else booked this room for your dates moments ago. Nothing
            was charged — pick another room.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Link href="/">
            <Button>Find another stay</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Confirm your details</CardTitle>
        <CardDescription>
          Signed in as{" "}
          <span className="font-medium text-foreground">{guest.phone}</span> ·{" "}
          <button
            type="button"
            onClick={onChangeGuest}
            className="underline underline-offset-2 hover:text-foreground"
          >
            change
          </button>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="full-name">Full name</Label>
            <Input
              id="full-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              minLength={2}
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email (optional)</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@mail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || fullName.trim().length < 2}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Reserving…
              </>
            ) : (
              `Reserve & pay ${formatMNT(stay.total)}`
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// Step 3 — QPay: show QR, poll booking status until funded
// ===========================================================================
function PaymentStep({
  booking,
  onFunded,
}: {
  booking: PublicBookingResponse;
  onFunded: () => void;
}) {
  const [simulating, setSimulating] = useState(false);
  const doneRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onFunded();
  }, [onFunded]);

  // Poll the public status endpoint every 3s until the webhook funds it.
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const { data } = await api.get<PublicBookingStatus>(
          `/public/bookings/${booking.booking_id}`
        );
        if (active && data.is_funded) finish();
      } catch {
        /* transient — keep polling */
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    void tick(); // immediate first check
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [booking.booking_id, finish]);

  // Demo helper: fire the mock QPay funding (sandbox-only endpoint).
  const simulatePayment = async () => {
    setSimulating(true);
    try {
      const { data } = await api.post<PublicBookingStatus>(
        `/public/bookings/${booking.booking_id}/simulate-payment`
      );
      if (data.is_funded) finish();
    } catch {
      toast({ variant: "destructive", title: "Could not simulate payment" });
      setSimulating(false);
    }
  };

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-lg">Scan to pay with QPay</CardTitle>
        <CardDescription>
          Open your banking app, scan the code, and pay{" "}
          {formatMNT(booking.total_amount)}. This screen updates the moment
          payment lands.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-5">
        <div className="rounded-xl border bg-white p-4">
          <QRCodeSVG
            value={booking.qpay_invoice.qr_text}
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
          href={booking.qpay_invoice.payment_url}
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
  );
}

// ===========================================================================
// Step 4 — success celebration
// ===========================================================================
function SuccessScreen({
  booking,
  stay,
}: {
  booking: PublicBookingResponse;
  stay: StayContext;
}) {
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(booking.booking_code);
      toast({ title: "Booking code copied" });
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Card className="relative overflow-hidden border-emerald-200 dark:border-emerald-900">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-emerald-50/60 to-transparent dark:from-emerald-950/40"
      />
      <CardHeader className="relative items-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/50">
          <PartyPopper className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
        </span>
        <CardTitle className="pt-3 text-2xl">You&apos;re booked!</CardTitle>
        <CardDescription>
          Payment received and held safely in escrow. See you at {stay.hotel}.
        </CardDescription>
      </CardHeader>
      <CardContent className="relative space-y-4">
        <div className="rounded-lg border bg-background/80 p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Your booking code — bring it to check-in
          </p>
          <p className="mt-1 font-mono text-2xl font-bold tracking-widest">
            {booking.booking_code}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void copyCode()}
          >
            <Copy className="h-4 w-4" />
            Copy code
          </Button>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Room</dt>
          <dd className="text-right font-medium">
            {booking.room_number} · <span className="capitalize">{stay.type.toLowerCase()}</span>
          </dd>
          <dt className="text-muted-foreground">Stay</dt>
          <dd className="text-right font-medium">
            {new Date(`${stay.checkIn}T00:00:00`).toLocaleDateString()} –{" "}
            {new Date(`${stay.checkOut}T00:00:00`).toLocaleDateString()} (
            {booking.nights} night{booking.nights === 1 ? "" : "s"})
          </dd>
          <dt className="text-muted-foreground">Paid</dt>
          <dd className="text-right font-semibold">
            {formatMNT(booking.total_amount)}
          </dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="text-right">
            <Badge variant="success">
              <BadgeCheck className="mr-1 h-3 w-3" />
              Confirmed
            </Badge>
          </dd>
        </dl>

        <Link href={`/booking/${booking.booking_id}/dining`} className="block">
          <Button className="w-full">Order food to your room</Button>
        </Link>
        <Link href="/" className="block">
          <Button variant="outline" className="w-full">
            Back to Stayline
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-72 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <CheckoutInner />
    </Suspense>
  );
}
