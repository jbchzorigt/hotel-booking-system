import axios, { AxiosError } from "axios";

import { useAuthStore } from "@/store/authStore";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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
