"use client";

import { useCallback, useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { Loader2, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import api from "@/lib/axios";
import { toast } from "@/hooks/use-toast";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { VicinityRestaurant } from "@/types/api";

// Mirrors RestaurantRegister in app/api/manager_router.py.
const restaurantSchema = z.object({
  name: z.string().min(1, "Name is required").max(120, "At most 120 characters"),
  description: z.string().max(2000, "At most 2000 characters").optional(),
  phone: z.string().max(32, "At most 32 characters").optional(),
});

type RestaurantFormValues = z.infer<typeof restaurantSchema>;

export default function RestaurantsTab() {
  const [restaurants, setRestaurants] = useState<VicinityRestaurant[]>([]);
  const [loading, setLoading] = useState(true);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<VicinityRestaurant[]>(
        "/manager/restaurants"
      );
      setRestaurants(data);
    } catch {
      toast({ variant: "destructive", title: "Failed to load restaurants" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleActive = async (
    restaurant: VicinityRestaurant,
    is_active: boolean
  ) => {
    setTogglingId(restaurant.id);
    try {
      const { data } = await api.patch<VicinityRestaurant>(
        `/manager/restaurants/${restaurant.id}`,
        { is_active }
      );
      setRestaurants((current) =>
        current.map((r) => (r.id === restaurant.id ? data : r))
      );
    } catch {
      toast({
        variant: "destructive",
        title: `Could not update ${restaurant.name}`,
      });
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Nearby restaurants your guests can order food from. Inactive
          listings are hidden from guests.
        </p>
        <Button onClick={() => setRegisterOpen(true)}>
          <Plus className="h-4 w-4" />
          Register Restaurant
        </Button>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead className="hidden md:table-cell">
                Description
              </TableHead>
              <TableHead className="text-right">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {restaurants.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-muted-foreground"
                >
                  No restaurants registered yet.
                </TableCell>
              </TableRow>
            ) : (
              restaurants.map((restaurant) => (
                <TableRow
                  key={restaurant.id}
                  className={restaurant.is_active ? undefined : "opacity-50"}
                >
                  <TableCell className="font-medium">
                    {restaurant.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {restaurant.phone ?? "—"}
                  </TableCell>
                  <TableCell className="hidden max-w-md truncate text-muted-foreground md:table-cell">
                    {restaurant.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={restaurant.is_active}
                      disabled={togglingId === restaurant.id}
                      onCheckedChange={(checked) =>
                        void toggleActive(restaurant, checked)
                      }
                      aria-label={`Toggle ${restaurant.name}`}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      <RegisterRestaurantDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onCreated={() => {
          setRegisterOpen(false);
          void refresh();
        }}
      />
    </div>
  );
}

function RegisterRestaurantDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const form = useForm<RestaurantFormValues>({
    resolver: zodResolver(restaurantSchema),
    defaultValues: { name: "", description: "", phone: "" },
  });

  useEffect(() => {
    if (open) form.reset();
  }, [open, form]);

  const onSubmit = async (values: RestaurantFormValues) => {
    try {
      await api.post("/manager/restaurants", {
        name: values.name,
        description: values.description || null,
        phone: values.phone || null,
      });
      toast({ title: `“${values.name}” registered` });
      onCreated();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        form.setError("name", {
          message: "This restaurant is already registered here.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Could not register the restaurant",
        });
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Register a vicinity restaurant</DialogTitle>
          <DialogDescription>
            The listing appears to your guests; menu and orders are managed
            by the restaurant&apos;s own account, provisioned by the platform.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Modern Nomads" autoFocus {...field} />
                  </FormControl>
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
                    <Input placeholder="+976 7011 2233" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Mongolian cuisine, 5 min walk"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Optional — shown to guests when they browse restaurants.
                  </FormDescription>
                  <FormMessage />
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
                    Registering…
                  </>
                ) : (
                  "Register"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
