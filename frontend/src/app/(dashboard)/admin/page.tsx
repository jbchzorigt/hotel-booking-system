"use client";

import { useCallback, useEffect, useState } from "react";
import { isAxiosError } from "axios";
import {
  BarChart3,
  Building2,
  Download,
  Handshake,
  Landmark,
  Loader2,
  Percent,
  ReceiptText,
  RefreshCw,
  TrendingUp,
  Wallet,
} from "lucide-react";

import ProvisionHotelDialog, {
  type ProvisionPrefill,
} from "@/components/admin/ProvisionHotelDialog";

import api from "@/lib/axios";
import { formatDateTime, formatMNT } from "@/lib/format";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type {
  ContactRequest,
  ContactRequestStatus,
  RevenueDashboard,
  TopRoom,
} from "@/types/api";

const LEAD_STATUSES: ContactRequestStatus[] = [
  "NEW",
  "CONTACTED",
  "CONVERTED",
  "REJECTED",
];

const LEAD_STATUS_META: Record<
  ContactRequestStatus,
  { label: string; dotClass: string }
> = {
  NEW: { label: "New", dotClass: "bg-sky-500" },
  CONTACTED: { label: "Contacted", dotClass: "bg-amber-500" },
  CONVERTED: { label: "Converted", dotClass: "bg-emerald-500" },
  REJECTED: { label: "Rejected", dotClass: "bg-zinc-400" },
};

const SOURCE_LABEL: Record<string, string> = {
  BOOKING_COMMISSION: "Booking commissions",
  MINIBAR_COMMISSION: "Minibar commissions",
  FOOD_ORDER_COMMISSION: "Food order commissions",
};

function sourceLabel(source: string): string {
  return (
    SOURCE_LABEL[source] ??
    source.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())
  );
}

/** Extract the server-chosen filename from Content-Disposition. */
function filenameFromDisposition(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /filename="?([^";]+)"?/.exec(header);
  return match ? match[1] : null;
}

export default function AdminPage() {
  const [revenue, setRevenue] = useState<RevenueDashboard | null>(null);
  const [topRooms, setTopRooms] = useState<TopRoom[] | null>(null);
  const [leads, setLeads] = useState<ContactRequest[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [provisioning, setProvisioning] = useState<ProvisionPrefill | null>(
    null
  );

  const refresh = useCallback(async () => {
    try {
      const [revenueRes, topRoomsRes, leadsRes] = await Promise.all([
        api.get<RevenueDashboard>("/admin/dashboard/revenue"),
        api.get<TopRoom[]>("/admin/dashboard/top-rooms"),
        api.get<ContactRequest[]>("/admin/onboarding/requests"),
      ]);
      setRevenue(revenueRes.data);
      setTopRooms(topRoomsRes.data);
      setLeads(leadsRes.data);
    } catch {
      toast({
        variant: "destructive",
        title: "Failed to load the dashboard",
        description: "Check your connection and try refreshing.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // -- Excel export: binary blob -> temporary object URL -> auto-download -- //
  const downloadReport = async () => {
    setExporting(true);
    try {
      const response = await api.get<Blob>("/admin/export/revenue", {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(response.data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        filenameFromDisposition(response.headers["content-disposition"]) ??
        `platform_revenue_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      toast({ title: "Revenue report downloaded" });
    } catch {
      toast({
        variant: "destructive",
        title: "Export failed",
        description: "Could not generate the Excel report.",
      });
    } finally {
      setExporting(false);
    }
  };

  const handleLeadUpdated = useCallback((updated: ContactRequest) => {
    setLeads((current) =>
      (current ?? []).map((l) => (l.id === updated.id ? updated : l))
    );
  }, []);

  const loading = revenue === null || topRooms === null || leads === null;
  const newLeadCount = (leads ?? []).filter((l) => l.status === "NEW").length;
  const maxDemand = Math.max(1, ...(topRooms ?? []).map((r) => r.demand));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            Platform Overview
          </h2>
          <p className="text-sm text-muted-foreground">
            Commission position and marketplace demand, platform-wide.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setProvisioning({})}
          >
            <Building2 className="h-4 w-4" />
            Provision New Hotel
          </Button>
          <Button size="sm" onClick={() => void downloadReport()} disabled={exporting}>
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download Revenue Report (Excel)
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* ---------------- Metric cards ---------------- */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="Total commission collected"
              icon={TrendingUp}
              value={formatMNT(revenue.total_commission_collected)}
              hint={`Lifetime ledger credits at ${(
                Number(revenue.commission_rate) * 100
              ).toFixed(1)}% commission`}
            />
            <MetricCard
              title="Wallet balance"
              icon={Wallet}
              value={formatMNT(revenue.wallet_balance)}
              hint="Live platform account balance"
            />
            <MetricCard
              title="Total debited"
              icon={Landmark}
              value={formatMNT(revenue.total_debited)}
              hint="Payouts and refunds, lifetime"
            />
            <MetricCard
              title="Ledger entries"
              icon={ReceiptText}
              value={revenue.ledger_entries.toLocaleString()}
              hint="Every entry reconciles to the wallet"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* ---------------- Commission by source ---------------- */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Percent className="h-4 w-4 text-muted-foreground" />
                  Commission by source
                </CardTitle>
                <CardDescription>
                  Where the 5% platform fee comes from.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {Object.entries(revenue.by_source).length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No commission collected yet.
                  </p>
                ) : (
                  Object.entries(revenue.by_source)
                    .sort(([, a], [, b]) => Number(b) - Number(a))
                    .map(([source, amount]) => {
                      const share =
                        Number(revenue.total_commission_collected) > 0
                          ? (Number(amount) /
                              Number(revenue.total_commission_collected)) *
                            100
                          : 0;
                      return (
                        <div key={source} className="space-y-1">
                          <div className="flex items-center justify-between text-sm">
                            <span>{sourceLabel(source)}</span>
                            <span className="font-medium tabular-nums">
                              {formatMNT(amount)}
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-all"
                              style={{ width: `${share}%` }}
                            />
                          </div>
                        </div>
                      );
                    })
                )}
              </CardContent>
            </Card>

            {/* ---------------- Top rooms ---------------- */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <BarChart3 className="h-4 w-4 text-muted-foreground" />
                  Top 5 most demanded rooms
                </CardTitle>
                <CardDescription>
                  Live bookings only — cancellations and no-shows excluded.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {topRooms.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No bookings yet.
                  </p>
                ) : (
                  topRooms.map((room, index) => (
                    <div key={room.room_id} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="shrink-0 tabular-nums"
                          >
                            #{index + 1}
                          </Badge>
                          <span className="truncate font-medium">
                            Room {room.room_number}
                          </span>
                          <span className="truncate text-muted-foreground">
                            {room.hotel_name}
                          </span>
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {room.demand} booking{room.demand === 1 ? "" : "s"} ·{" "}
                          <span className="font-medium text-foreground">
                            {formatMNT(room.gross_revenue)}
                          </span>
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-sky-500 transition-all"
                          style={{
                            width: `${(room.demand / maxDemand) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          {/* ---------------- Partnership requests ---------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Handshake className="h-4 w-4 text-muted-foreground" />
                Partnership Requests
                {newLeadCount > 0 && (
                  <Badge variant="info">{newLeadCount} new</Badge>
                )}
              </CardTitle>
              <CardDescription>
                Hotels asking to join — verify by phone, then provision the
                tenant manually. There is deliberately no self-serve signup.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {leads.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No partnership requests yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Hotel</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Submitted</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leads.map((lead) => (
                      <TableRow key={lead.id}>
                        <TableCell className="font-medium">
                          {lead.hotel_name}
                        </TableCell>
                        <TableCell>{lead.contact_name}</TableCell>
                        <TableCell>
                          <a
                            href={`tel:${lead.phone.replace(/[\s-]/g, "")}`}
                            className="font-mono text-sm underline-offset-2 hover:underline"
                          >
                            {lead.phone}
                          </a>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(lead.created_at)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="flex items-center justify-end gap-2">
                            {lead.status !== "CONVERTED" &&
                              lead.status !== "REJECTED" && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    setProvisioning({
                                      hotel_name: lead.hotel_name,
                                      contact_request_id: lead.id,
                                    })
                                  }
                                  title="Create the tenant and mark this lead CONVERTED"
                                >
                                  <Building2 className="h-4 w-4" />
                                  Provision
                                </Button>
                              )}
                            <LeadStatusSelect
                              lead={lead}
                              onUpdated={handleLeadUpdated}
                            />
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <ProvisionHotelDialog
        open={provisioning !== null}
        prefill={provisioning}
        onClose={() => setProvisioning(null)}
        onProvisioned={() => void refresh()}
      />
    </div>
  );
}

// ===========================================================================
// Lead status dropdown — optimistic update, rollback on failure.
// CONVERTED is terminal server-side (a Tenant exists for it); the control
// is disabled there so admins aren't offered a transition that must 409.
// ===========================================================================
function LeadStatusSelect({
  lead,
  onUpdated,
}: {
  lead: ContactRequest;
  onUpdated: (lead: ContactRequest) => void;
}) {
  const [saving, setSaving] = useState(false);
  const terminal = lead.status === "CONVERTED";

  const handleChange = async (value: string) => {
    const next = value as ContactRequestStatus;
    if (next === lead.status) return;

    const previous = lead;
    onUpdated({ ...lead, status: next }); // optimistic
    setSaving(true);
    try {
      const { data } = await api.patch<ContactRequest>(
        `/admin/onboarding/requests/${lead.id}/status`,
        { status: next }
      );
      onUpdated(data); // authoritative row (server timestamps etc.)
      toast({ title: "Status updated" });
    } catch (err) {
      onUpdated(previous); // rollback
      if (isAxiosError(err) && err.response?.status === 409) {
        toast({
          variant: "destructive",
          title: "Transition not allowed",
          description:
            (err.response.data as { detail?: string }).detail ??
            "This lead is in a terminal state.",
        });
      } else if (isAxiosError(err) && err.response?.status === 404) {
        toast({
          variant: "destructive",
          title: "Lead no longer exists",
          description: "Refresh the dashboard to sync the list.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Could not update the status",
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const meta = LEAD_STATUS_META[lead.status];

  return (
    <Select
      value={lead.status}
      onValueChange={(value) => void handleChange(value)}
      disabled={saving || terminal}
    >
      <SelectTrigger
        className="ml-auto h-8 w-[150px]"
        aria-label={`Status of ${lead.hotel_name}`}
        title={
          terminal
            ? "Converted is terminal — a tenant exists for this lead"
            : undefined
        }
      >
        <SelectValue>
          <span className="flex items-center gap-2">
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : (
              <span
                className={cn("h-2 w-2 rounded-full", meta.dotClass)}
                aria-hidden
              />
            )}
            {meta.label}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        {LEAD_STATUSES.map((status) => {
          const option = LEAD_STATUS_META[status];
          return (
            <SelectItem key={status} value={status}>
              <span className="flex items-center gap-2">
                <span
                  className={cn("h-2 w-2 rounded-full", option.dotClass)}
                  aria-hidden
                />
                {option.label}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function MetricCard({
  title,
  value,
  hint,
  icon: Icon,
}: {
  title: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums tracking-tight">
          {value}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
