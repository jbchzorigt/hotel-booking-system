"use client";

import { BadgeCheck, Loader2, UserCheck } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CitizenPreview } from "@/types/api";
import type { RegistryLookupState } from "@/hooks/useRegistryLookup";

/** Registry-number input with live KHUR verification feedback — the
 *  shared UX of the check-in and walk-in dialogs. */
export default function RegistryField({
  id,
  registry,
  onChange,
  lookupState,
  citizen,
  disabled,
  optionalNote,
}: {
  id: string;
  registry: string;
  onChange: (value: string) => void;
  lookupState: RegistryLookupState;
  citizen: CitizenPreview | null;
  disabled?: boolean;
  optionalNote?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>State registry number (РД)</Label>
      <div className="relative">
        <Input
          id={id}
          placeholder="УБ12345678"
          value={registry}
          onChange={(e) => onChange(e.target.value)}
          maxLength={10}
          autoComplete="off"
          disabled={disabled}
          className="font-mono uppercase"
        />
        {lookupState === "looking" && (
          <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {lookupState === "found" && (
          <BadgeCheck className="absolute right-3 top-2.5 h-4 w-4 text-emerald-600" />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {optionalNote ??
          "2 Cyrillic letters + 8 digits. Identity is verified against the state KHUR registry."}
      </p>

      {lookupState === "found" && citizen && (
        <div className="space-y-1 rounded-md border bg-muted/50 p-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <UserCheck className="h-4 w-4 text-emerald-600" />
            {citizen.full_name}
          </p>
          <p className="pl-6 text-xs text-muted-foreground">
            {citizen.address}
          </p>
        </div>
      )}
      {lookupState === "not_found" && (
        <p className="text-sm text-destructive">
          No citizen record found for this registry number.
        </p>
      )}
      {lookupState === "error" && (
        <p className="text-sm text-destructive">
          State registry lookup failed — you can still submit; the server
          re-verifies authoritatively.
        </p>
      )}
    </div>
  );
}
