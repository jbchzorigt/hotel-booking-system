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
import { ROOM_TYPES, type ManagedRoom, type RoomState } from "@/types/api";

const ROOM_STATE_BADGE: Record<
  RoomState,
  { label: string; variant: "success" | "info" | "warning" }
> = {
  VACANT_CLEAN: { label: "Vacant · Clean", variant: "success" },
  OCCUPIED: { label: "Occupied", variant: "info" },
  VACANT_DIRTY: { label: "Vacant · Dirty", variant: "warning" },
};

// Mirrors RoomCreate in app/api/manager_router.py.
const roomSchema = z.object({
  room_number: z
    .string()
    .min(1, "Room number is required")
    .max(16, "At most 16 characters"),
  room_type: z.enum(ROOM_TYPES, { message: "Pick a room type" }),
  beds: z.coerce
    .number({ message: "Beds must be a number" })
    .int("Whole numbers only")
    .min(1, "At least 1 bed")
    .max(12, "At most 12 beds"),
  floor: z.coerce
    .number({ message: "Floor must be a number" })
    .int("Whole numbers only")
    .min(-2, "Floor -2 at the lowest")
    .max(200, "Floor 200 at the highest"),
  base_price: z.coerce
    .number({ message: "Price must be a number" })
    .min(0, "Price cannot be negative")
    .multipleOf(0.01, "At most 2 decimal places"),
});

type RoomFormValues = z.infer<typeof roomSchema>;

export default function RoomsTab() {
  const [rooms, setRooms] = useState<ManagedRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<ManagedRoom[]>("/manager/rooms", {
        params: { include_inactive: true },
      });
      setRooms(data);
    } catch {
      toast({ variant: "destructive", title: "Failed to load rooms" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleActive = async (room: ManagedRoom, is_active: boolean) => {
    setTogglingId(room.id);
    try {
      const { data } = await api.patch<ManagedRoom>(
        `/manager/rooms/${room.id}`,
        { is_active }
      );
      setRooms((current) =>
        current.map((r) => (r.id === room.id ? data : r))
      );
    } catch {
      toast({
        variant: "destructive",
        title: `Could not update room ${room.room_number}`,
      });
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {rooms.length} room{rooms.length === 1 ? "" : "s"}
        </p>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Room
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
              <TableHead>Room</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Beds</TableHead>
              <TableHead>Floor</TableHead>
              <TableHead>Nightly rate</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rooms.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-muted-foreground"
                >
                  No rooms yet — create the first one.
                </TableCell>
              </TableRow>
            ) : (
              rooms.map((room) => {
                const badge = ROOM_STATE_BADGE[room.state];
                return (
                  <TableRow
                    key={room.id}
                    className={room.is_active ? undefined : "opacity-50"}
                  >
                    <TableCell className="font-medium">
                      {room.room_number}
                    </TableCell>
                    <TableCell className="capitalize">
                      {room.room_type.toLowerCase()}
                    </TableCell>
                    <TableCell>{room.beds}</TableCell>
                    <TableCell>{room.floor}</TableCell>
                    <TableCell>{formatMNT(room.base_price)}</TableCell>
                    <TableCell>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Switch
                        checked={room.is_active}
                        disabled={togglingId === room.id}
                        onCheckedChange={(checked) =>
                          void toggleActive(room, checked)
                        }
                        aria-label={`Toggle room ${room.room_number}`}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      )}

      <CreateRoomDialog
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

function CreateRoomDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const form = useForm<RoomFormValues>({
    resolver: zodResolver(roomSchema),
    defaultValues: {
      room_number: "",
      room_type: "DOUBLE",
      beds: 2,
      floor: 1,
      base_price: 0,
    },
  });

  useEffect(() => {
    if (open) form.reset();
  }, [open, form]);

  const onSubmit = async (values: RoomFormValues) => {
    try {
      await api.post("/manager/rooms", {
        ...values,
        base_price: values.base_price.toFixed(2),
      });
      toast({ title: `Room ${values.room_number} created` });
      onCreated();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        form.setError("room_number", {
          message: "This room number already exists.",
        });
      } else {
        toast({ variant: "destructive", title: "Could not create the room" });
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create room</DialogTitle>
          <DialogDescription>
            New rooms start as Vacant · Clean and immediately sellable.
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
                name="room_number"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Room number</FormLabel>
                    <FormControl>
                      <Input placeholder="101" autoFocus {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="room_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ROOM_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            <span className="capitalize">
                              {type.toLowerCase()}
                            </span>
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
                name="beds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Beds</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} max={12} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="floor"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Floor</FormLabel>
                    <FormControl>
                      <Input type="number" min={-2} max={200} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="base_price"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Base nightly price (MNT)</FormLabel>
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
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  "Create room"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
