import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { decodeAccessToken, isExpired } from "@/lib/jwt";

export type UserRole =
  | "PLATFORM_ADMIN"
  | "HOTEL_ADMIN"
  | "MANAGER"
  | "RECEPTION"
  | "CLEANER"
  | "RESTAURANT_OWNER";

/** Auth realm carried by the token. Police tokens are minted by the police
 *  department's own identity system, never by `/auth/login`. */
export type AuthRealm = "app" | "police";

/** Landing route for each role after a successful login. */
export const ROLE_HOME: Record<UserRole, string> = {
  PLATFORM_ADMIN: "/admin",
  HOTEL_ADMIN: "/hotel",
  MANAGER: "/manager",
  RECEPTION: "/reception",
  CLEANER: "/cleaner",
  RESTAURANT_OWNER: "/restaurant",
};

interface AuthState {
  token: string | null;
  userId: string | null;
  /** UserRole for app-realm principals, or "POLICE" for the police realm. */
  role: UserRole | null;
  /** Which realm the token belongs to — gates the police dashboard. */
  realm: AuthRealm | null;
  tenantId: string | null;
  restaurantId: string | null;
  /** Unix ms after which the token is dead client-side. */
  expiresAt: number | null;
  /** zustand/persist rehydration flag — gate guards on this to avoid
   *  redirecting before localStorage has been read. */
  hasHydrated: boolean;

  /**
   * Ingest a freshly minted access token. All identity fields (role,
   * tenant_id, restaurant_id) are derived from the token's own claims so
   * the store can never disagree with what the API will enforce.
   *
   * Returns the role so callers can route immediately.
   */
  login: (accessToken: string) => UserRole;
  logout: () => void;
  isAuthenticated: () => boolean;
  setHasHydrated: (value: boolean) => void;
}

const EMPTY_SESSION = {
  token: null,
  userId: null,
  role: null,
  realm: null,
  tenantId: null,
  restaurantId: null,
  expiresAt: null,
} as const;

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      ...EMPTY_SESSION,
      hasHydrated: false,

      login: (accessToken) => {
        const claims = decodeAccessToken(accessToken);
        if (!claims || isExpired(claims)) {
          throw new Error("received a malformed or expired access token");
        }
        set({
          token: accessToken,
          userId: claims.sub,
          role: claims.role as UserRole,
          realm: claims.realm,
          tenantId: claims.tenant_id,
          restaurantId: claims.restaurant_id,
          expiresAt: claims.exp * 1000,
        });
        return claims.role as UserRole;
      },

      logout: () => set({ ...EMPTY_SESSION }),

      isAuthenticated: () => {
        const { token, expiresAt } = get();
        return token !== null && expiresAt !== null && expiresAt > Date.now();
      },

      setHasHydrated: (value) => set({ hasHydrated: value }),
    }),
    {
      name: "hm.auth",
      storage: createJSONStorage(() => localStorage),
      partialize: ({
        token,
        userId,
        role,
        realm,
        tenantId,
        restaurantId,
        expiresAt,
      }) => ({
        token,
        userId,
        role,
        realm,
        tenantId,
        restaurantId,
        expiresAt,
      }),
      onRehydrateStorage: () => (state) => {
        // Drop sessions that expired while the tab was closed.
        if (state && state.expiresAt !== null && state.expiresAt <= Date.now()) {
          state.logout();
        }
        state?.setHasHydrated(true);
      },
    }
  )
);
