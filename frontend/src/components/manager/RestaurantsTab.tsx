"use client";

import { useCallback, useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { Dices, Eye, EyeOff, KeyRound, Loader2, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import api from "@/lib/axios";
import { toast } from "@/hooks/use-toast";
import { useAuthStore } from "@/store/authStore";
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
import type {
  RestaurantManagerCreated,
  VicinityRestaurant,
} from "@/types/api";

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
  const [managerFor, setManagerFor] = useState<VicinityRestaurant | null>(null);

  // Creating restaurant login credentials is a HOTEL_ADMIN-only act
  // (the endpoint 403s a plain MANAGER), so the action is gated to match.
  const isHotelAdmin = useAuthStore((s) => s.role === "HOTEL_ADMIN");

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
              <TableHead className="text-right">Manage</TableHead>
              <TableHead className="text-right">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {restaurants.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
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
                    {isHotelAdmin ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setManagerFor(restaurant)}
                      >
                        <KeyRound className="h-4 w-4" />
                        Create Manager Login
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Admin only
                      </span>
                    )}
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

      <CreateManagerDialog
        restaurant={managerFor}
        onClose={() => setManagerFor(null)}
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

// ===========================================================================
// Create restaurant-manager login (HOTEL_ADMIN only)
// ===========================================================================
// Mirrors RestaurantManagerCreate in app/api/manager_router.py — note the
// 10-char password floor (staff accounts, stricter than the login form's 8).
const managerSchema = z.object({
  email: z.string().email("Not a valid email"),
  password: z
    .string()
    .min(10, "At least 10 characters")
    .max(64, "At most 64 characters"),
  full_name: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(255, "At most 255 characters"),
});

type ManagerFormValues = z.infer<typeof managerSchema>;

function CreateManagerDialog({
  restaurant,
  onClose,
}: {
  restaurant: VicinityRestaurant | null;
  onClose: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);

  const form = useForm<ManagerFormValues>({
    resolver: zodResolver(managerSchema),
    defaultValues: { email: "", password: "", full_name: "Restaurant Manager" },
  });

  useEffect(() => {
    if (restaurant) {
      form.reset({
        email: "",
        password: "",
        full_name: "Restaurant Manager",
      });
      setShowPassword(false);
    }
  }, [restaurant, form]);

  const generatePassword = () => {
    const alphabet =
      "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%";
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    form.setValue(
      "password",
      Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(""),
      { shouldValidate: true }
    );
    setShowPassword(true);
  };

  const onSubmit = async (values: ManagerFormValues) => {
    if (!restaurant) return;
    try {
      const { data } = await api.post<RestaurantManagerCreated>(
        `/restaurants/${restaurant.id}/manager`,
        {
          email: values.email,
          password: values.password,
          full_name: values.full_name,
        }
      );
      toast({
        title: "Manager login created",
        description: `${data.email} can now sign in to manage ${restaurant.name}.`,
      });
      onClose();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        form.setError("email", {
          message: "A user with this email already exists.",
        });
      } else if (isAxiosError(err) && err.response?.status === 404) {
        toast({
          variant: "destructive",
          title: "Restaurant not found",
          description: "It may have been removed — refresh and try again.",
        });
        onClose();
      } else if (isAxiosError(err) && err.response?.status === 403) {
        toast({
          variant: "destructive",
          title: "Not allowed",
          description: "Only the hotel admin can create restaurant logins.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Could not create the login",
        });
      }
    }
  };

  return (
    <Dialog open={restaurant !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create manager login</DialogTitle>
          <DialogDescription>
            {restaurant && (
              <>
                Credentials for{" "}
                <span className="font-medium text-foreground">
                  {restaurant.name}
                </span>
                . The account can manage only this restaurant&apos;s menu and
                orders.
              </>
            )}
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
              name="full_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Manager name</FormLabel>
                  <FormControl>
                    <Input placeholder="Restaurant Manager" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Manager email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="off"
                      placeholder="manager@restaurant.mn"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
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
                        aria-label={showPassword ? "Hide password" : "Show password"}
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
                    10–64 characters. Share it with the manager over a secure
                    channel.
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
                    Creating…
                  </>
                ) : (
                  "Create login"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
