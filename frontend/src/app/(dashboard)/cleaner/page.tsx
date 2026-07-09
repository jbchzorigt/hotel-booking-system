"use client";

import { useCallback, useEffect, useState } from "react";
import { isAxiosError } from "axios";
import {
  BedDouble,
  GlassWater,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  UserRound,
} from "lucide-react";

import api from "@/lib/axios";
import { formatMNT } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  DirtyRoom,
  MinibarCatalogueItem,
  MinibarReportResponse,
  OccupiedRoom,
} from "@/types/api";

/** Minimal room shape the report dialog needs — DirtyRoom and OccupiedRoom
 *  are structurally identical, so one dialog serves both. */
type ReportableRoom = Pick<OccupiedRoom, "id" | "room_number">;

export default function CleanerPage() {
  const [occupied, setOccupied] = useState<OccupiedRoom[]>([]);
  const [dirty, setDirty] = useState<DirtyRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [reportRoom, setReportRoom] = useState<ReportableRoom | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [occupiedRes, dirtyRes] = await Promise.all([
        api.get<OccupiedRoom[]>("/cleaner/rooms/occupied"),
        api.get<DirtyRoom[]>("/cleaner/rooms/dirty"),
      ]);
      setOccupied(occupiedRes.data);
      setDirty(dirtyRes.data);
    } catch {
      toast({
        variant: "destructive",
        title: "Could not load your room list",
        description: "Pull to refresh or try again.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markClean = async (room: DirtyRoom) => {
    setMarkingId(room.id);
    try {
      await api.post(`/cleaner/rooms/${room.id}/mark-clean`);
      setDirty((current) => current.filter((r) => r.id !== room.id));
      toast({
        title: `Room ${room.room_number} is clean`,
        description: "It is now sellable again.",
      });
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        toast({
          variant: "destructive",
          title: `Room ${room.room_number} changed state`,
          description: "Someone else updated it — refreshing your list.",
        });
        void refresh();
      } else {
        toast({
          variant: "destructive",
          title: "Could not mark the room clean",
          description: "Please try again.",
        });
      }
    } finally {
      setMarkingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Housekeeping
          </h2>
          <p className="text-sm text-muted-foreground">
            {occupied.length} in-house · {dirty.length} to clean
          </p>
        </div>
        <Button variant="outline" size="icon" onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" />
          <span className="sr-only">Refresh</span>
        </Button>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* ---------------- Occupied: report minibar ---------------- */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <UserRound className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">In-house rooms</h3>
              <span className="text-xs text-muted-foreground">
                report minibar before the guest checks out
              </span>
            </div>

            {occupied.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No occupied rooms right now.
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {occupied.map((room) => (
                  <Card key={room.id}>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center justify-between text-base">
                        <span className="flex items-center gap-2">
                          <BedDouble className="h-5 w-5 text-muted-foreground" />
                          Room {room.room_number}
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge variant="info">Occupied</Badge>
                          <span className="text-sm font-normal capitalize text-muted-foreground">
                            Floor {room.floor} · {room.room_type.toLowerCase()}
                          </span>
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Button
                        variant="outline"
                        className="h-11 w-full"
                        onClick={() => setReportRoom(room)}
                      >
                        <GlassWater className="h-4 w-4" />
                        Report Minibar
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>

          {/* ---------------- Vacant dirty: mark clean ---------------- */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">To clean</h3>
              <span className="text-xs text-muted-foreground">
                guest has left — clean and release
              </span>
            </div>

            {dirty.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
                  <Sparkles className="h-7 w-7 text-emerald-500" />
                  <p className="text-sm font-medium">All caught up!</p>
                  <p className="text-xs text-muted-foreground">
                    No dirty rooms right now.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {dirty.map((room) => (
                  <Card key={room.id}>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center justify-between text-base">
                        <span className="flex items-center gap-2">
                          <BedDouble className="h-5 w-5 text-muted-foreground" />
                          Room {room.room_number}
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge variant="warning">Vacant · Dirty</Badge>
                          <span className="text-sm font-normal capitalize text-muted-foreground">
                            Floor {room.floor} · {room.room_type.toLowerCase()}
                          </span>
                        </span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Button
                        className="h-11 w-full"
                        onClick={() => void markClean(room)}
                        disabled={markingId === room.id}
                      >
                        {markingId === room.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )}
                        Mark as Clean
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <MinibarReportDialog
        room={reportRoom}
        onClose={() => setReportRoom(null)}
        onReported={() => void refresh()}
      />
    </div>
  );
}

// ===========================================================================
// Minibar report dialog — quantities per catalogue item; submitting posts
// to the room's ACTIVE stay and broadcasts MINIBAR_REPORT to reception.
// Only valid while the room is OCCUPIED (a CHECKED_IN booking must exist).
// ===========================================================================
function MinibarReportDialog({
  room,
  onClose,
  onReported,
}: {
  room: ReportableRoom | null;
  onClose: () => void;
  onReported: () => void;
}) {
  const [catalogue, setCatalogue] = useState<MinibarCatalogueItem[] | null>(
    null
  );
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);

  // Load the catalogue once, lazily, when the dialog first opens.
  useEffect(() => {
    if (!room || catalogue !== null) return;
    api
      .get<MinibarCatalogueItem[]>("/cleaner/minibar/items")
      .then(({ data }) => setCatalogue(data))
      .catch(() =>
        toast({
          variant: "destructive",
          title: "Could not load the minibar catalogue",
        })
      );
  }, [room, catalogue]);

  // Reset quantities whenever a new room's dialog opens.
  useEffect(() => {
    setQuantities({});
    setSubmitting(false);
  }, [room?.id]);

  const adjust = (itemId: string, delta: number) =>
    setQuantities((current) => {
      const next = Math.min(99, Math.max(0, (current[itemId] ?? 0) + delta));
      const updated = { ...current, [itemId]: next };
      if (next === 0) delete updated[itemId];
      return updated;
    });

  const lines = Object.entries(quantities).filter(([, qty]) => qty > 0);
  const total = lines.reduce((sum, [itemId, qty]) => {
    const item = catalogue?.find((i) => i.id === itemId);
    return sum + (item ? Number(item.price) * qty : 0);
  }, 0);

  const handleSubmit = async () => {
    if (!room || lines.length === 0) return;
    setSubmitting(true);
    try {
      // Path-param variant: the room is in the URL, the server resolves the
      // active stay itself (cleaners never handle booking ids).
      const { data } = await api.post<MinibarReportResponse>(
        `/cleaner/rooms/${room.id}/minibar`,
        {
          items: lines.map(([minibar_item_id, quantity]) => ({
            minibar_item_id,
            quantity,
          })),
        }
      );
      toast({
        title: `Minibar reported — Room ${data.room_number}`,
        description: `${data.lines_recorded} item line${
          data.lines_recorded === 1 ? "" : "s"
        } · ${formatMNT(data.total_amount)} — reception has been notified.`,
      });
      onReported();
      onClose();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        toast({
          variant: "destructive",
          title: "No active stay for this room",
          description:
            "The guest may have already checked out — refreshing your list.",
        });
        onReported();
        onClose();
      } else if (isAxiosError(err) && err.response?.status === 422) {
        toast({
          variant: "destructive",
          title: "An item is no longer available",
          description: "Remove it and try again.",
        });
        setSubmitting(false);
      } else {
        toast({
          variant: "destructive",
          title: "Could not submit the report",
          description: "Please try again.",
        });
        setSubmitting(false);
      }
    }
  };

  return (
    <Dialog open={room !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report minibar — Room {room?.room_number}</DialogTitle>
          <DialogDescription>
            Select the missing items. Charges are added to the current
            guest&apos;s bill and settled at checkout.
          </DialogDescription>
        </DialogHeader>

        {catalogue === null ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : catalogue.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This hotel has no minibar catalogue configured.
          </p>
        ) : (
          <div className="divide-y">
            {catalogue.map((item) => {
              const qty = quantities[item.id] ?? 0;
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatMNT(item.price)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9"
                      onClick={() => adjust(item.id, -1)}
                      disabled={qty === 0 || submitting}
                      aria-label={`Remove one ${item.name}`}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <span className="w-6 text-center text-sm font-semibold tabular-nums">
                      {qty}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-9 w-9"
                      onClick={() => adjust(item.id, 1)}
                      disabled={qty >= 99 || submitting}
                      aria-label={`Add one ${item.name}`}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter className="gap-2 sm:items-center">
          {lines.length > 0 && (
            <span className="text-sm font-medium sm:mr-auto">
              Total: {formatMNT(total)}
            </span>
          )}
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={lines.length === 0 || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Submitting…
              </>
            ) : (
              "Submit report"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
