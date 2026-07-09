"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ScrollText } from "lucide-react";

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PoliceAuditLog } from "@/types/api";

const ACTION_BADGE: Record<
  string,
  { label: string; variant: "destructive" | "success" | "secondary" | "info" | "warning" }
> = {
  WATCHLIST_ADDED: { label: "Watchlist added", variant: "info" },
  ARRESTED: { label: "Arrested", variant: "success" },
  CONFIRMED: { label: "Confirmed", variant: "warning" },
  DISMISSED: { label: "Dismissed", variant: "secondary" },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<PoliceAuditLog[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<PoliceAuditLog[]>("/police/audit-logs");
      setLogs(data);
    } catch {
      toast({ variant: "destructive", title: "Could not load the audit log" });
      setLogs((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Audit Logs</h1>
          <p className="text-sm text-muted-foreground">
            Append-only record of officer actions — who did what, and when.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="h-4 w-4 text-muted-foreground" />
            Action trail
            {logs !== null && (
              <Badge variant="secondary" className="ml-1">
                {logs.length}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Immutable and never contains a registry number.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {logs === null ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : logs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No recorded actions yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Officer</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => {
                  const badge = ACTION_BADGE[log.action] ?? {
                    label: log.action,
                    variant: "secondary" as const,
                  };
                  return (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(log.created_at)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {log.officer_name ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                      <TableCell>{log.target_person_name ?? "—"}</TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {log.note ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
