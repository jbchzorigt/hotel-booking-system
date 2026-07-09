"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { isAxiosError } from "axios";
import { Loader2, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";

import api from "@/lib/axios";
import { toast } from "@/hooks/use-toast";
import { REGISTRY_RE } from "@/hooks/useRegistryLookup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WantedPerson, WantedPersonStatus } from "@/types/api";

const STATUS_BADGE: Record<
  WantedPersonStatus,
  { label: string; variant: "destructive" | "success" | "secondary" }
> = {
  WANTED: { label: "WANTED", variant: "destructive" },
  ARRESTED: { label: "Arrested", variant: "success" },
  CLEARED: { label: "Cleared", variant: "secondary" },
};

export default function WatchlistPage() {
  const [people, setPeople] = useState<WantedPerson[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<WantedPerson[]>("/police/watchlist");
      setPeople(data);
    } catch {
      toast({ variant: "destructive", title: "Could not load the watchlist" });
      setPeople((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Watchlist</h1>
          <p className="text-sm text-muted-foreground">
            Add a suspect by registry number — the state registry (KHUR)
            supplies the verified identity.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <AddSuspectForm onAdded={() => void refresh()} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Registered suspects
            {people !== null && (
              <Badge variant="secondary" className="ml-2">
                {people.length}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Identity is state-verified. The registry number itself is never
            stored or shown — matching runs on a salted hash.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {people === null ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : people.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No suspects on the watchlist yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>District</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Case ref.</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.map((person) => {
                  const badge = STATUS_BADGE[person.status];
                  return (
                    <TableRow
                      key={person.id}
                      className={person.is_active ? undefined : "opacity-60"}
                    >
                      <TableCell className="font-medium">
                        {person.full_name}
                      </TableCell>
                      <TableCell>{person.district ?? "—"}</TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {person.address ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {person.case_reference ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
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

function AddSuspectForm({ onAdded }: { onAdded: () => void }) {
  const [registry, setRegistry] = useState("");
  const [caseRef, setCaseRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validShape = REGISTRY_RE.test(registry);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await api.post<WantedPerson>("/police/watchlist", {
        registry_number: registry,
        case_reference: caseRef.trim() || null,
      });
      toast({
        title: `Added to watchlist — ${data.full_name}`,
        description: data.district ?? undefined,
      });
      setRegistry("");
      setCaseRef("");
      onAdded();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        setError("This person is already on the watchlist.");
      } else if (isAxiosError(err) && err.response?.status === 404) {
        setError("No citizen record found for this registry number.");
      } else if (isAxiosError(err) && err.response?.status === 422) {
        setError("That registry number is not valid.");
      } else if (isAxiosError(err) && err.response?.status === 502) {
        setError("State registry is unavailable — try again shortly.");
      } else {
        setError("Could not add the suspect. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlus className="h-4 w-4 text-muted-foreground" />
          Add suspect
        </CardTitle>
        <CardDescription>
          Enter only the registry number (РД). The identity is fetched and
          verified server-side; the raw number is hashed, never stored.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          noValidate
        >
          <div className="flex-1 space-y-2">
            <Label htmlFor="registry">Registry number (РД)</Label>
            <Input
              id="registry"
              placeholder="УБ12345678"
              value={registry}
              onChange={(e) =>
                setRegistry(e.target.value.toUpperCase().replace(/[\s-]/g, ""))
              }
              maxLength={10}
              autoComplete="off"
              disabled={submitting}
              className="font-mono uppercase"
            />
          </div>
          <div className="flex-1 space-y-2">
            <Label htmlFor="case-ref">Case reference (optional)</Label>
            <Input
              id="case-ref"
              placeholder="CASE-2026-0142"
              value={caseRef}
              onChange={(e) => setCaseRef(e.target.value)}
              maxLength={64}
              autoComplete="off"
              disabled={submitting}
            />
          </div>
          <Button type="submit" disabled={submitting || !validShape}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Verifying…
              </>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4" />
                Add to watchlist
              </>
            )}
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">
          Format: 2 Cyrillic letters followed by 8 digits.
        </p>
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
