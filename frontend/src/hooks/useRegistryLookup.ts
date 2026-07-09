"use client";

import { useCallback, useRef, useState } from "react";
import { isAxiosError } from "axios";

import api from "@/lib/axios";
import type { CitizenPreview } from "@/types/api";

/** Mongolian РД: 2 Cyrillic letters + 8 digits (see gov_service.py). */
export const REGISTRY_RE = /^[А-ЯЁӨҮ]{2}\d{8}$/;

const LOOKUP_DEBOUNCE_MS = 400;

export type RegistryLookupState =
  | "idle"
  | "looking"
  | "found"
  | "not_found"
  | "error";

/**
 * Debounced KHUR identity preview shared by the check-in and walk-in
 * forms. Normalizes input (uppercase, no spaces/hyphens), only queries
 * once the value matches the РД shape, and discards stale responses.
 */
export function useRegistryLookup() {
  const [registry, setRegistryValue] = useState("");
  const [citizen, setCitizen] = useState<CitizenPreview | null>(null);
  const [lookupState, setLookupState] = useState<RegistryLookupState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const setRegistry = useCallback((raw: string) => {
    const value = raw.toUpperCase().replace(/[\s-]/g, "");
    setRegistryValue(value);
    setCitizen(null);

    if (timerRef.current) clearTimeout(timerRef.current);
    if (!REGISTRY_RE.test(value)) {
      setLookupState("idle");
      return;
    }

    setLookupState("looking");
    const seq = ++seqRef.current;
    timerRef.current = setTimeout(async () => {
      try {
        const { data } = await api.get<CitizenPreview>(
          `/reception/identity/${encodeURIComponent(value)}`
        );
        if (seq !== seqRef.current) return; // superseded by newer input
        setCitizen(data);
        setLookupState("found");
      } catch (err) {
        if (seq !== seqRef.current) return;
        setLookupState(
          isAxiosError(err) && err.response?.status === 404
            ? "not_found"
            : "error"
        );
      }
    }, LOOKUP_DEBOUNCE_MS);
  }, []);

  const reset = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    seqRef.current += 1;
    setRegistryValue("");
    setCitizen(null);
    setLookupState("idle");
  }, []);

  return {
    registry,
    setRegistry,
    citizen,
    lookupState,
    reset,
    isValidShape: REGISTRY_RE.test(registry),
  };
}
