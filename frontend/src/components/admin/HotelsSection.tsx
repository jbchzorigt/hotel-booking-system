"use client";

import { useCallback, useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { Building2, Loader2, Pencil, RefreshCw } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SubscriptionPlan, Tenant } from "@/types/api";

const PLAN_LABEL: Record<SubscriptionPlan, string> = {
  "3_MONTHS": "3 mo",
  "6_MONTHS": "6 mo",
  "9_MONTHS": "9 mo",
  "12_MONTHS": "12 mo",
};

function formatFee(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "—";
}

export default function HotelsSection() {
  const [hotels, setHotels] = useState<Tenant[] | null>(null);
  const [editing, setEditing] = useState<Tenant | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<Tenant[]>("/admin/tenants");
      setHotels(data);
    } catch {
      toast({ variant: "destructive", title: "Failed to load hotels" });
      setHotels((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUpdated = useCallback((updated: Tenant) => {
    setHotels((current) =>
      (current ?? []).map((h) => (h.id === updated.id ? updated : h))
    );
    setEditing(null);
  }, []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            Hotels
            {hotels !== null && (
              <Badge variant="secondary">{hotels.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Every hotel on the platform. The fee is the commission taken on
            that hotel&apos;s bookings and food orders.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {hotels === null ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : hotels.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No hotels yet — provision the first one.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hotel</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Fee (%)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {hotels.map((hotel) => (
                <TableRow
                  key={hotel.id}
                  className={hotel.is_active ? undefined : "opacity-60"}
                >
                  <TableCell>
                    <span className="block font-medium">{hotel.name}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {hotel.slug}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {hotel.contact_email}
                  </TableCell>
                  <TableCell>{PLAN_LABEL[hotel.subscription_plan]}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatFee(hotel.platform_fee_percent)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={hotel.is_active ? "success" : "secondary"}>
                      {hotel.is_active ? "Active" : "Suspended"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(hotel)}
                    >
                      <Pencil className="h-4 w-4" />
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <EditHotelDialog
        hotel={editing}
        onClose={() => setEditing(null)}
        onUpdated={handleUpdated}
      />
    </Card>
  );
}

// ===========================================================================
// Edit dialog — PATCH /admin/tenants/{id}. Fee re-rates FUTURE bookings only.
// ===========================================================================
const editSchema = z.object({
  contact_email: z.string().email("Not a valid email"),
  contact_phone: z.string().max(32, "At most 32 characters").optional(),
  address: z.string().max(500, "At most 500 characters").optional(),
  platform_fee_percent: z.coerce
    .number({ message: "Fee must be a number" })
    .min(0, "≥ 0%")
    .max(100, "≤ 100%")
    .multipleOf(0.01, "At most 2 decimal places"),
  is_active: z.boolean(),
});

type EditFormValues = z.infer<typeof editSchema>;

function EditHotelDialog({
  hotel,
  onClose,
  onUpdated,
}: {
  hotel: Tenant | null;
  onClose: () => void;
  onUpdated: (t: Tenant) => void;
}) {
  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      contact_email: "",
      contact_phone: "",
      address: "",
      platform_fee_percent: 5,
      is_active: true,
    },
  });

  useEffect(() => {
    if (hotel) {
      form.reset({
        contact_email: hotel.contact_email,
        contact_phone: hotel.contact_phone ?? "",
        address: hotel.address ?? "",
        platform_fee_percent: Number(hotel.platform_fee_percent),
        is_active: hotel.is_active,
      });
    }
  }, [hotel, form]);

  const onSubmit = async (values: EditFormValues) => {
    if (!hotel) return;
    try {
      const { data } = await api.patch<Tenant>(`/admin/tenants/${hotel.id}`, {
        contact_email: values.contact_email,
        contact_phone: values.contact_phone || null,
        address: values.address || null,
        platform_fee_percent: values.platform_fee_percent.toFixed(2),
        is_active: values.is_active,
      });
      toast({
        title: "Hotel updated",
        description: `${data.name} · fee now ${formatFee(data.platform_fee_percent)}`,
      });
      onUpdated(data);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 422) {
        toast({
          variant: "destructive",
          title: "Check the fields",
          description: "Fee must be between 0 and 100%.",
        });
      } else {
        toast({ variant: "destructive", title: "Could not update the hotel" });
      }
    }
  };

  return (
    <Dialog open={hotel !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {hotel?.name}</DialogTitle>
          <DialogDescription>
            Fee changes apply to future bookings and orders — already-billed
            payables keep their original rate.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
            noValidate
          >
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="contact_email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contact email</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="contact_phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contact phone</FormLabel>
                    <FormControl>
                      <Input placeholder="+976 …" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="platform_fee_percent"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Platform Fee (%)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Commission on this hotel&apos;s bookings and food orders.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="is_active"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div className="space-y-0.5">
                    <FormLabel>Active on marketplace</FormLabel>
                    <FormDescription>
                      Suspended hotels disappear from public search.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={form.formState.isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
