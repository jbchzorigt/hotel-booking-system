import axios, { AxiosError } from "axios";

import { useAuthStore } from "@/store/authStore";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Origin of the API (no /api/v1 path) — where the backend serves static
 *  uploads from. */
const API_ORIGIN = (() => {
  try {
    return new URL(API_BASE_URL).origin;
  } catch {
    return "";
  }
})();

/**
 * Resolve a stored asset path for display. Upload returns a root-relative
 * `/static/uploads/…` served by the BACKEND, not Next.js — so prefix it
 * with the API origin. Absolute URLs and empty values pass through.
 */
export function assetUrl(
  path: string | null | undefined
): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return path;
  return `${API_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface UploadResult {
  url: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * Upload an image to `POST /upload` and return its stored path.
 *
 * Uses fetch (not the axios instance) so the browser sets the multipart
 * boundary itself — axios's JSON default Content-Type would corrupt the
 * body. The bearer token is attached from the same auth store the axios
 * interceptor uses.
 */
export async function uploadImage(file: File): Promise<UploadResult> {
  const token = useAuthStore.getState().token;
  const body = new FormData();
  body.append("file", file);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/upload`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body,
    });
  } catch {
    throw new UploadError("network error while uploading", 0);
  }

  if (!response.ok) {
    if (response.status === 401) {
      useAuthStore.getState().logout();
    }
    const detail = await response
      .json()
      .then((d) => (d as { detail?: string }).detail)
      .catch(() => undefined);
    throw new UploadError(detail ?? "upload failed", response.status);
  }
  return (await response.json()) as UploadResult;
}

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
});

// ---------------------------------------------------------------------------
// Request: attach the bearer token from the auth store (which persists to
// localStorage). Reading via getState() keeps this usable outside React.
// ---------------------------------------------------------------------------
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ---------------------------------------------------------------------------
// Response: a 401 on any authenticated call means the session is dead
// (expired/revoked token). Clear local state and hand the user back to the
// login page, preserving where they were. The login call itself is exempt —
// its 401 is "wrong credentials" and belongs to the form.
// ---------------------------------------------------------------------------
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const status = error.response?.status;
    const isLoginRequest = error.config?.url?.includes("/auth/login") ?? false;

    if (status === 401 && !isLoginRequest && typeof window !== "undefined") {
      useAuthStore.getState().logout();

      if (!window.location.pathname.startsWith("/login")) {
        const next = encodeURIComponent(
          window.location.pathname + window.location.search
        );
        window.location.replace(`/login?next=${next}`);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
