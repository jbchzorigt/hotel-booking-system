"use client";

import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import {
  BadgeCheck,
  Building2,
  Dices,
  Eye,
  EyeOff,
  Loader2,
  UserRound,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import api from "@/lib/axios";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  HotelAdminCreated,
  SubscriptionPlan,
  TenantCreated,
} from "@/types/api";

// Ulaanbaatar city centre — matches the marketplace search default.
const DEFAULT_LAT = 47.9185;
const DEFAULT_LNG = 106.9177;

const PLAN_OPTIONS: { value: SubscriptionPlan; label: string }[] = [
  { value: "3_MONTHS", label: "3 months" },
  { value: "6_MONTHS", label: "6 months" },
  { value: "9_MONTHS", label: "9 months" },
  { value: "12_MONTHS", label: "12 months" },
];

// Mirrors TenantCreate in app/api/tenant_admin_router.py (slug is derived
// server-side from the name; we deliberately don't expose it).
const hotelSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(160, "At most 160 characters"),
  contact_email: z.string().email("Not a valid email"),
  contact_phone: z.string().max(32, "At most 32 characters").optional(),
  address: z.string().max(500, "At most 500 characters").optional(),
  maps_lat: z.coerce
    .number({ message: "Latitude must be a number" })
    .min(-90, "≥ -90")
    .max(90, "≤ 90"),
  maps_lng: z.coerce
    .number({ message: "Longitude must be a number" })
    .min(-180, "≥ -180")
    .max(180, "≤ 180"),
  subscription_plan: z.enum(["3_MONTHS", "6_MONTHS", "9_MONTHS", "12_MONTHS"]),
});

// Mirrors HotelAdminCreate (password 10–64 per the backend policy).
const adminSchema = z.object({
  full_name: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(255, "At most 255 characters"),
  email: z.string().email("Not a valid email"),
  password: z
    .string()
    .min(10, "At least 10 characters")
    .max(64, "At most 64 characters"),
  phone: z.string().max(32, "At most 32 characters").optional(),
});

type HotelFormValues = z.infer<typeof hotelSchema>;
type AdminFormValues = z.infer<typeof adminSchema>;

export interface ProvisionPrefill {
  hotel_name?: string;
  /** Links the sales lead: the backend flips it to CONVERTED atomically
   *  with the tenant INSERT. */
  contact_request_id?: string;
}

/**
 * Two-step wizard on purpose: tenant creation and admin creation are two
 * backend transactions. If step 2 fails (e.g. duplicate email), the tenant
 * already exists — the wizard stays on step 2 and retries ONLY the user
 * call, never re-creating the tenant.
 */
export default function ProvisionHotelDialog({
  open,
  prefill,
  onClose,
  onProvisioned,
}: {
  open: boolean;
  prefill: ProvisionPrefill | null;
  onClose: () => void;
  onProvisioned: () => void;
}) {
  const [tenant, setTenant] = useState<TenantCreated | null>(null);
  const [admin, setAdmin] = useState<HotelAdminCreated | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const hotelForm = useForm<HotelFormValues>({
    resolver: zodResolver(hotelSchema),
    defaultValues: {
      name: "",
      contact_email: "",
      contact_phone: "",
      address: "",
      maps_lat: DEFAULT_LAT,
      maps_lng: DEFAULT_LNG,
      subscription_plan: "12_MONTHS",
    },
  });

  const adminForm = useForm<AdminFormValues>({
    resolver: zodResolver(adminSchema),
    defaultValues: { full_name: "", email: "", password: "", phone: "" },
  });

  // Fresh wizard per open; prefill arrives when launched from a lead row.
  useEffect(() => {
    if (open) {
      setTenant(null);
      setAdmin(null);
      setStepError(null);
      setShowPassword(false);
      hotelForm.reset({
        name: prefill?.hotel_name ?? "",
        contact_email: "",
        contact_phone: "",
        address: "",
        maps_lat: DEFAULT_LAT,
        maps_lng: DEFAULT_LNG,
        subscription_plan: "12_MONTHS",
      });
      adminForm.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ---- Step 1: create the Tenant (optionally converting the lead) ------ //
  const submitHotel = async (values: HotelFormValues) => {
    setStepError(null);
    try {
      const { data } = await api.post<TenantCreated>("/admin/tenants", {
        name: values.name,
        contact_email: values.contact_email,
        contact_phone: values.contact_phone || null,
        address: values.address || null,
        maps_lat: values.maps_lat.toFixed(6),
        maps_lng: values.maps_lng.toFixed(6),
        subscription_plan: values.subscription_plan,
        contact_request_id: prefill?.contact_request_id ?? null,
      });
      setTenant(data);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        setStepError(
          (err.response.data as { detail?: string }).detail ??
            "Conflict — the slug may be taken or the lead already converted."
        );
      } else if (isAxiosError(err) && err.response?.status === 404) {
        setStepError("The linked lead no longer exists.");
      } else {
        setStepError("Could not create the hotel. Please try again.");
      }
    }
  };

  // ---- Step 2: create the first HOTEL_ADMIN (retry-safe) --------------- //
  const submitAdmin = async (values: AdminFormValues) => {
    if (!tenant) return;
    setStepError(null);
    try {
      const { data } = await api.post<HotelAdminCreated>(
        `/admin/tenants/${tenant.tenant_id}/users`,
        {
          email: values.email,
          password: values.password,
          full_name: values.full_name,
          phone: values.phone || null,
        }
      );
      setAdmin(data);
      toast({ title: "Hotel and Admin successfully provisioned!" });
      onProvisioned();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        adminForm.setError("email", {
          message: "A user with this email already exists.",
        });
      } else {
        setStepError(
          "The hotel was created, but the admin account failed — fix the " +
            "fields and retry (the hotel will not be duplicated)."
        );
      }
    }
  };

  const generatePassword = () => {
    // 16 chars from a shuffle-friendly alphabet (no lookalikes).
    const alphabet =
      "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%";
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const password = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    adminForm.setValue("password", password, { shouldValidate: true });
    setShowPassword(true);
  };

  const step = admin ? 3 : tenant ? 2 : 1;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {step === 1 && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-muted-foreground" />
                Provision new hotel — step 1 of 2
              </DialogTitle>
              <DialogDescription>
                {prefill?.contact_request_id
                  ? "Creating the tenant will mark the linked lead as CONVERTED in the same transaction."
                  : "Creates the tenant and starts its subscription clock."}
              </DialogDescription>
            </DialogHeader>

            <Form {...hotelForm}>
              <form
                onSubmit={hotelForm.handleSubmit(submitHotel)}
                className="space-y-4"
                noValidate
              >
                <FormField
                  control={hotelForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Hotel name</FormLabel>
                      <FormControl>
                        <Input placeholder="Blue Sky Hotel" autoFocus {...field} />
                      </FormControl>
                      <FormDescription>
                        The marketplace slug is derived from this automatically.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={hotelForm.control}
                    name="contact_email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contact email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="front@hotel.mn"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={hotelForm.control}
                    name="contact_phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contact phone</FormLabel>
                        <FormControl>
                          <Input placeholder="+976 7011 2233" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={hotelForm.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Address</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Peace Avenue 17, Ulaanbaatar"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={hotelForm.control}
                    name="maps_lat"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Latitude</FormLabel>
                        <FormControl>
                          <Input type="number" step="any" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={hotelForm.control}
                    name="maps_lng"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Longitude</FormLabel>
                        <FormControl>
                          <Input type="number" step="any" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={hotelForm.control}
                    name="subscription_plan"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Plan</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {PLAN_OPTIONS.map((plan) => (
                              <SelectItem key={plan.value} value={plan.value}>
                                {plan.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {stepError && (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {stepError}
                  </p>
                )}

                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onClose}
                    disabled={hotelForm.formState.isSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={hotelForm.formState.isSubmitting}
                  >
                    {hotelForm.formState.isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Creating hotel…
                      </>
                    ) : (
                      "Create hotel & continue"
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}

        {step === 2 && tenant && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UserRound className="h-5 w-5 text-muted-foreground" />
                First hotel admin — step 2 of 2
              </DialogTitle>
              <DialogDescription>
                <span className="font-medium text-foreground">
                  {tenant.name}
                </span>{" "}
                is live (slug <span className="font-mono">{tenant.slug}</span>
                ). Now create its HOTEL_ADMIN — they provision their own staff
                afterwards.
              </DialogDescription>
            </DialogHeader>

            <Form {...adminForm}>
              <form
                onSubmit={adminForm.handleSubmit(submitAdmin)}
                className="space-y-4"
                noValidate
              >
                <FormField
                  control={adminForm.control}
                  name="full_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full name</FormLabel>
                      <FormControl>
                        <Input placeholder="Bat-Erdene Ganbold" autoFocus {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={adminForm.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="admin@hotel.mn"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={adminForm.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl>
                          <Input placeholder="+976 9911 2233" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={adminForm.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Temporary password</FormLabel>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <FormControl>
                            <Input
                              type={showPassword ? "text" : "password"}
                              autoComplete="new-password"
                              className="pr-10 font-mono"
                              {...field}
                            />
                          </FormControl>
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                            aria-label={
                              showPassword ? "Hide password" : "Show password"
                            }
                            tabIndex={-1}
                          >
                            {showPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={generatePassword}
                          title="Generate a strong password"
                        >
                          <Dices className="h-4 w-4" />
                          Generate
                        </Button>
                      </div>
                      <FormDescription>
                        10–64 characters. Share it over a secure channel; the
                        admin should change it on first login.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {stepError && (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {stepError}
                  </p>
                )}

                <DialogFooter>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={adminForm.formState.isSubmitting}
                  >
                    {adminForm.formState.isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Creating admin…
                      </>
                    ) : (
                      "Create admin & finish"
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}

        {step === 3 && tenant && admin && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <BadgeCheck className="h-5 w-5 text-emerald-600" />
                Hotel provisioned
              </DialogTitle>
              <DialogDescription>
                {tenant.name} is on the marketplace and its admin can sign in.
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border bg-muted/50 p-4 text-sm">
              <dt className="text-muted-foreground">Hotel</dt>
              <dd className="text-right font-medium">{tenant.name}</dd>
              <dt className="text-muted-foreground">Slug</dt>
              <dd className="text-right font-mono">{tenant.slug}</dd>
              <dt className="text-muted-foreground">Subscription until</dt>
              <dd className="text-right font-medium">
                {new Date(tenant.subscription_expires_at).toLocaleDateString()}
              </dd>
              <dt className="text-muted-foreground">Admin</dt>
              <dd className="text-right font-medium">{admin.email}</dd>
              {tenant.converted_lead_id && (
                <>
                  <dt className="text-muted-foreground">Lead</dt>
                  <dd className="text-right">
                    <Badge variant="success">Converted</Badge>
                  </dd>
                </>
              )}
            </dl>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
