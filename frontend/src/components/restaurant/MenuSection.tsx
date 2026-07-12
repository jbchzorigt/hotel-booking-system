"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { ImagePlus, Loader2, Plus, UtensilsCrossed, X } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import api, { assetUrl, uploadImage, UploadError } from "@/lib/axios";
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
              <TableHead className="w-14" />
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
                  colSpan={6}
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
                  <TableCell>
                    <MenuThumb src={item.image_url} alt={item.name} />
                  </TableCell>
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

/** Small square thumbnail for the menu table; falls back to an icon. */
function MenuThumb({ src, alt }: { src: string | null; alt: string }) {
  const resolved = assetUrl(src);
  if (!resolved) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <UtensilsCrossed className="h-4 w-4" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- backend-served upload, not a static asset
    <img
      src={resolved}
      alt={alt}
      className="h-10 w-10 rounded-md border object-cover"
      loading="lazy"
    />
  );
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // matches the backend's 5 MiB cap

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

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const clearImage = useCallback(() => {
    setImageFile(null);
    setImageError(null);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // Reset everything when the dialog opens; revoke any object URL on unmount.
  useEffect(() => {
    if (open) {
      form.reset();
      clearImage();
    }
  }, [open, form, clearImage]);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const onPickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setImageError("Please choose an image file.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError("Image must be 5 MB or smaller.");
      return;
    }
    setImageError(null);
    setImageFile(file);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
  };

  const onSubmit = async (values: MenuItemFormValues) => {
    try {
      // 1) If a photo was chosen, upload it FIRST and use the returned path.
      let imageUrl: string | null = null;
      if (imageFile) {
        try {
          const { url } = await uploadImage(imageFile);
          imageUrl = url;
        } catch (err) {
          const message =
            err instanceof UploadError
              ? err.status === 415
                ? "That image format isn't supported (use JPG, PNG, WebP or GIF)."
                : err.status === 413
                  ? "Image is too large (max 5 MB)."
                  : "Image upload failed — please try again."
              : "Image upload failed — please try again.";
          setImageError(message);
          return; // abort: don't create an item pointing at a failed upload
        }
      }

      // 2) Create the menu item with the uploaded image path attached.
      await api.post("/restaurant/menu-items", {
        name: values.name,
        description: values.description || null,
        category: values.category || null,
        price: values.price.toFixed(2),
        image_url: imageUrl,
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

            {/* -------- Photo upload (uploaded on submit) -------- */}
            <FormItem>
              <FormLabel>Photo</FormLabel>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onPickFile}
                disabled={form.formState.isSubmitting}
                className="hidden"
              />
              {previewUrl ? (
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                  <img
                    src={previewUrl}
                    alt="Selected photo preview"
                    className="h-16 w-16 rounded-md border object-cover"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={form.formState.isSubmitting}
                    >
                      Replace
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearImage}
                      disabled={form.formState.isSubmitting}
                    >
                      <X className="h-4 w-4" />
                      Remove
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={form.formState.isSubmitting}
                  className="w-full justify-start text-muted-foreground"
                >
                  <ImagePlus className="h-4 w-4" />
                  Choose an image…
                </Button>
              )}
              <FormDescription>
                Optional. JPG, PNG, WebP or GIF, up to 5 MB.
              </FormDescription>
              {imageError && (
                <p className="text-[0.8rem] font-medium text-destructive">
                  {imageError}
                </p>
              )}
            </FormItem>

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
                    {imageFile ? "Uploading…" : "Creating…"}
                  </>
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
