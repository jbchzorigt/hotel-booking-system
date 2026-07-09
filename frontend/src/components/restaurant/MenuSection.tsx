"use client";

import { useCallback, useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { Loader2, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MenuItem } from "@/types/api";

// Mirrors MenuItemCreate in app/api/restaurant_router.py.
const menuItemSchema = z.object({
  name: z.string().min(1, "Name is required").max(120, "At most 120 characters"),
  description: z.string().max(2000, "At most 2000 characters").optional(),
  category: z.string().max(80, "At most 80 characters").optional(),
  price: z.coerce
    .number({ message: "Price must be a number" })
    .min(0, "Price cannot be negative")
    .multipleOf(0.01, "At most 2 decimal places"),
});

type MenuItemFormValues = z.infer<typeof menuItemSchema>;

export default function MenuSection() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<MenuItem[]>("/restaurant/menu-items");
      setItems(data);
    } catch {
      toast({ variant: "destructive", title: "Failed to load the menu" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleAvailable = async (item: MenuItem, is_available: boolean) => {
    setTogglingId(item.id);
    try {
      const { data } = await api.patch<MenuItem>(
        `/restaurant/menu-items/${item.id}`,
        { is_available }
      );
      setItems((current) => current.map((i) => (i.id === item.id ? data : i)));
    } catch {
      toast({ variant: "destructive", title: `Could not update ${item.name}` });
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {items.length} menu item{items.length === 1 ? "" : "s"}. Unavailable
          items are hidden from guests instantly.
        </p>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Item
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
              <TableHead>Item</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="hidden md:table-cell">
                Description
              </TableHead>
              <TableHead>Price</TableHead>
              <TableHead className="text-right">Available</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-muted-foreground"
                >
                  No menu items yet — create the first one.
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow
                  key={item.id}
                  className={item.is_available ? undefined : "opacity-50"}
                >
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell>
                    {item.category ? (
                      <Badge variant="secondary">{item.category}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                    {item.description ?? "—"}
                  </TableCell>
                  <TableCell>{formatMNT(item.price)}</TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={item.is_available}
                      disabled={togglingId === item.id}
                      onCheckedChange={(checked) =>
                        void toggleAvailable(item, checked)
                      }
                      aria-label={`Toggle ${item.name}`}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      <CreateMenuItemDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void refresh();
        }}
      />
    </div>
  );
}

function CreateMenuItemDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const form = useForm<MenuItemFormValues>({
    resolver: zodResolver(menuItemSchema),
    defaultValues: { name: "", description: "", category: "", price: 0 },
  });

  useEffect(() => {
    if (open) form.reset();
  }, [open, form]);

  const onSubmit = async (values: MenuItemFormValues) => {
    try {
      await api.post("/restaurant/menu-items", {
        name: values.name,
        description: values.description || null,
        category: values.category || null,
        price: values.price.toFixed(2),
      });
      toast({ title: `“${values.name}” added to the menu` });
      onCreated();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        form.setError("name", { message: "This item already exists." });
      } else {
        toast({ variant: "destructive", title: "Could not create the item" });
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create menu item</DialogTitle>
          <DialogDescription>
            Order lines snapshot the price, so later edits never rewrite
            past orders.
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
                    <Input placeholder="Khuushuur (4 pcs)" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <Input placeholder="Mains" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="price"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Price (MNT)</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Fried dumplings with beef"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Optional — shown to guests browsing the menu.
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
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Create item"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
