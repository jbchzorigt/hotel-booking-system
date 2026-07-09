"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { FolderPlus, Loader2, Plus, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ManagedMinibarItem, MinibarCategory } from "@/types/api";

// Mirrors CategoryCreate / ItemCreate in app/api/manager_router.py.
const categorySchema = z.object({
  name: z.string().min(1, "Name is required").max(80, "At most 80 characters"),
  sort_order: z.coerce
    .number({ message: "Must be a number" })
    .int("Whole numbers only")
    .min(0)
    .max(1000),
});

const itemSchema = z.object({
  category_id: z.string().uuid("Pick a category"),
  name: z.string().min(1, "Name is required").max(120, "At most 120 characters"),
  price: z.coerce
    .number({ message: "Price must be a number" })
    .min(0, "Price cannot be negative")
    .multipleOf(0.01, "At most 2 decimal places"),
});

type CategoryFormValues = z.infer<typeof categorySchema>;
type ItemFormValues = z.infer<typeof itemSchema>;

export default function MinibarTab() {
  const [categories, setCategories] = useState<MinibarCategory[]>([]);
  const [items, setItems] = useState<ManagedMinibarItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [itemOpen, setItemOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [categoriesRes, itemsRes] = await Promise.all([
        api.get<MinibarCategory[]>("/manager/minibar/categories"),
        api.get<ManagedMinibarItem[]>("/manager/minibar/items", {
          params: { include_inactive: true },
        }),
      ]);
      setCategories(categoriesRes.data);
      setItems(itemsRes.data);
    } catch {
      toast({ variant: "destructive", title: "Failed to load the minibar" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const categoryName = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories]
  );

  const toggleItem = async (item: ManagedMinibarItem, is_active: boolean) => {
    setBusyId(item.id);
    try {
      const { data } = await api.patch<ManagedMinibarItem>(
        `/manager/minibar/items/${item.id}`,
        { is_active }
      );
      setItems((current) => current.map((i) => (i.id === item.id ? data : i)));
    } catch {
      toast({
        variant: "destructive",
        title: `Could not update ${item.name}`,
      });
    } finally {
      setBusyId(null);
    }
  };

  const deleteCategory = async (category: MinibarCategory) => {
    setBusyId(category.id);
    try {
      await api.delete(`/manager/minibar/categories/${category.id}`);
      setCategories((current) => current.filter((c) => c.id !== category.id));
      toast({ title: `Category “${category.name}” deleted` });
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        toast({
          variant: "destructive",
          title: `“${category.name}” still has items`,
          description: "Move or retire its items first.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Could not delete the category",
        });
      }
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ---------------- Items ---------------- */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {items.length} item{items.length === 1 ? "" : "s"} across{" "}
            {categories.length} categor
            {categories.length === 1 ? "y" : "ies"}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setCategoryOpen(true)}>
              <FolderPlus className="h-4 w-4" />
              New Category
            </Button>
            <Button
              onClick={() => setItemOpen(true)}
              disabled={categories.length === 0}
            >
              <Plus className="h-4 w-4" />
              Create Item
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Price</TableHead>
              <TableHead className="text-right">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-8 text-center text-muted-foreground"
                >
                  {categories.length === 0
                    ? "Create a category first, then add items to it."
                    : "No items yet — create the first one."}
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow
                  key={item.id}
                  className={item.is_active ? undefined : "opacity-50"}
                >
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {categoryName.get(item.category_id) ?? "—"}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatMNT(item.price)}</TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={item.is_active}
                      disabled={busyId === item.id}
                      onCheckedChange={(checked) =>
                        void toggleItem(item, checked)
                      }
                      aria-label={`Toggle ${item.name}`}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      {/* ---------------- Categories ---------------- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Categories</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Sort order</TableHead>
              <TableHead>Items</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-6 text-center text-muted-foreground"
                >
                  No categories yet.
                </TableCell>
              </TableRow>
            ) : (
              categories.map((category) => {
                const itemCount = items.filter(
                  (i) => i.category_id === category.id
                ).length;
                return (
                  <TableRow key={category.id}>
                    <TableCell className="font-medium">
                      {category.name}
                    </TableCell>
                    <TableCell>{category.sort_order}</TableCell>
                    <TableCell>{itemCount}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busyId === category.id || itemCount > 0}
                        onClick={() => void deleteCategory(category)}
                        aria-label={`Delete ${category.name}`}
                        title={
                          itemCount > 0
                            ? "Only empty categories can be deleted"
                            : undefined
                        }
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      <CreateCategoryDialog
        open={categoryOpen}
        onClose={() => setCategoryOpen(false)}
        onCreated={() => {
          setCategoryOpen(false);
          void refresh();
        }}
      />
      <CreateItemDialog
        open={itemOpen}
        categories={categories}
        onClose={() => setItemOpen(false)}
        onCreated={() => {
          setItemOpen(false);
          void refresh();
        }}
      />
    </div>
  );
}

function CreateCategoryDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(categorySchema),
    defaultValues: { name: "", sort_order: 0 },
  });

  useEffect(() => {
    if (open) form.reset();
  }, [open, form]);

  const onSubmit = async (values: CategoryFormValues) => {
    try {
      await api.post("/manager/minibar/categories", values);
      toast({ title: `Category “${values.name}” created` });
      onCreated();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        form.setError("name", { message: "This category already exists." });
      } else {
        toast({
          variant: "destructive",
          title: "Could not create the category",
        });
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New category</DialogTitle>
          <DialogDescription>
            Categories group items in the housekeeping report form.
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
                    <Input placeholder="Beverages" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="sort_order"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Sort order</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} max={1000} {...field} />
                  </FormControl>
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
                  "Create"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function CreateItemDialog({
  open,
  categories,
  onClose,
  onCreated,
}: {
  open: boolean;
  categories: MinibarCategory[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const form = useForm<ItemFormValues>({
    resolver: zodResolver(itemSchema),
    defaultValues: { category_id: "", name: "", price: 0 },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        category_id: categories[0]?.id ?? "",
        name: "",
        price: 0,
      });
    }
  }, [open, categories, form]);

  const onSubmit = async (values: ItemFormValues) => {
    try {
      await api.post("/manager/minibar/items", {
        ...values,
        price: values.price.toFixed(2),
      });
      toast({ title: `Item “${values.name}” created` });
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
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create minibar item</DialogTitle>
          <DialogDescription>
            Housekeeping charges these to the guest&apos;s stay; the price is
            snapshotted per report.
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
              name="category_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {categories.map((category) => (
                        <SelectItem key={category.id} value={category.id}>
                          {category.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Coca-Cola 330ml" {...field} />
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
