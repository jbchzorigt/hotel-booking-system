"use client";

import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import {
  BadgeCheck,
  Banknote,
  Building2,
  Loader2,
  PhoneCall,
  ShieldCheck,
  UtensilsCrossed,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import api from "@/lib/axios";
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
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { ContactRequestReceipt } from "@/types/api";

// Mirrors ContactRequestCreate in app/api/onboarding_router.py:
// 6-15 digits, optional leading +, spaces/hyphens tolerated.
const PHONE_RE = /^\+?[\d\s-]+$/;

const leadSchema = z.object({
  hotel_name: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(160, "At most 160 characters"),
  contact_name: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(160, "At most 160 characters"),
  phone: z
    .string()
    .trim()
    .min(6, "At least 6 characters")
    .max(32, "At most 32 characters")
    .regex(PHONE_RE, "Digits only, with an optional leading +")
    .refine(
      (value) => {
        const digits = value.replace(/[\s-]/g, "").replace(/^\+/, "");
        return digits.length >= 6 && digits.length <= 15;
      },
      { message: "Phone must be 6–15 digits" }
    ),
});

type LeadFormValues = z.infer<typeof leadSchema>;

const VALUE_PROPS = [
  {
    icon: Banknote,
    title: "Escrow-protected revenue",
    text: "Guests pay upfront; 95% lands in your wallet at checkout. No chargebacks, no no-show losses on paid bookings.",
  },
  {
    icon: ShieldCheck,
    title: "State-verified check-ins",
    text: "Guest identity is verified against the KHUR registry and screened automatically — compliance built in, not bolted on.",
  },
  {
    icon: UtensilsCrossed,
    title: "Room-service marketplace",
    text: "Vicinity restaurants deliver to your rooms through the platform — a guest amenity you don't have to operate.",
  },
] as const;

export default function JoinPage() {
  const [receipt, setReceipt] = useState<ContactRequestReceipt | null>(null);

  const form = useForm<LeadFormValues>({
    resolver: zodResolver(leadSchema),
    defaultValues: { hotel_name: "", contact_name: "", phone: "" },
  });

  const onSubmit = async (values: LeadFormValues) => {
    try {
      const { data } = await api.post<ContactRequestReceipt>(
        "/onboarding/request",
        values
      );
      setReceipt(data);
      toast({
        title: "Request received",
        description:
          "Our sales team will contact you shortly to verify your business.",
      });
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 429) {
        toast({
          variant: "destructive",
          title: "Too many requests",
          description:
            "We already have your recent requests — please wait a while or call our sales line directly.",
        });
      } else if (isAxiosError(err) && err.response?.status === 422) {
        toast({
          variant: "destructive",
          title: "Check the form",
          description: "Some fields were rejected — please review and resubmit.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Could not send your request",
          description: "Please try again in a moment.",
        });
      }
    }
  };

  return (
    <div className="space-y-12">
      {/* ---------------- Hero ---------------- */}
      <section className="mx-auto max-w-3xl space-y-4 pt-8 text-center">
        <Badge variant="secondary" className="mx-auto">
          <Building2 className="mr-1 h-3 w-3" />
          For hotels & guesthouses
        </Badge>
        <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">
          Put your hotel on the marketplace
        </h1>
        <p className="mx-auto max-w-2xl text-muted-foreground sm:text-lg">
          Bookings, front desk, housekeeping, minibar and room-service food
          orders — one platform, 5% commission, escrow-protected payouts.
          Onboarding is verified by our team: no forms into the void, a real
          person calls you back.
        </p>
      </section>

      {/* ---------------- Value props ---------------- */}
      <section className="grid gap-4 sm:grid-cols-3">
        {VALUE_PROPS.map(({ icon: Icon, title, text }) => (
          <Card key={title}>
            <CardHeader className="pb-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Icon className="h-4 w-4" />
              </span>
              <CardTitle className="pt-2 text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{text}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ---------------- Lead form / success ---------------- */}
      <section className="mx-auto w-full max-w-lg pb-8">
        {receipt ? (
          <Card className="border-emerald-200 dark:border-emerald-900">
            <CardHeader className="items-center text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/50">
                <BadgeCheck className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              </span>
              <CardTitle className="pt-2">You&apos;re on the list</CardTitle>
              <CardDescription>
                Our sales team will contact you shortly to verify your
                business and set up your hotel.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-center">
              <p className="text-sm text-muted-foreground">
                Reference:{" "}
                <span className="font-mono text-foreground">
                  {receipt.request_id}
                </span>
              </p>
              <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <PhoneCall className="h-4 w-4" />
                Keep your phone reachable — verification happens by call.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Request a callback</CardTitle>
              <CardDescription>
                Three fields, no contracts — we verify your business over the
                phone before anything goes live.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmit)}
                  className="space-y-4"
                  noValidate
                >
                  <FormField
                    control={form.control}
                    name="hotel_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Hotel name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Blue Sky Hotel"
                            autoFocus
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="contact_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contact name</FormLabel>
                        <FormControl>
                          <Input placeholder="Bat-Erdene" {...field} />
                        </FormControl>
                        <FormDescription>
                          The person our team should ask for.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl>
                          <Input
                            type="tel"
                            placeholder="+976 8811 2233"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={form.formState.isSubmitting}
                  >
                    {form.formState.isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Sending…
                      </>
                    ) : (
                      "Request partnership"
                    )}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    No self-serve signup by design — every hotel on the
                    platform is manually verified.
                  </p>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
