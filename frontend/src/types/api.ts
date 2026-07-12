/**
 * TypeScript mirrors of the backend Pydantic schemas (app/api/*).
 * Decimal fields arrive as JSON strings; date fields as ISO strings.
 */

export type RoomState = "VACANT_CLEAN" | "OCCUPIED" | "VACANT_DIRTY";

export const ROOM_TYPES = [
  "SINGLE",
  "DOUBLE",
  "TWIN",
  "FAMILY",
  "SUITE",
  "DELUXE",
] as const;

export type RoomType = (typeof ROOM_TYPES)[number];

export type BookingStatus =
  | "PENDING"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "CHECKED_OUT"
  | "CANCELLED"
  | "NO_SHOW";

// --- Reception (app/api/reception_router.py) ------------------------------
export interface DeskRoom {
  id: string;
  room_number: string;
  floor: number;
  room_type: RoomType;
  state: RoomState;
}

export interface DeskBooking {
  id: string;
  code: string;
  room_id: string;
  room_number: string;
  guest_full_name: string;
  guest_phone: string;
  check_in_date: string;
  check_out_date: string;
  status: BookingStatus;
  /** Room-charge snapshot — used for the checkout invoice preview. */
  total_amount: string;
}

/** Line sent in the checkout payload for desk-recorded consumptions. */
export interface DeskMinibarLine {
  catalog_id: string;
  quantity: number;
}

export interface DeskCatalogueItem {
  id: string;
  name: string;
  price: string;
}

export interface CitizenPreview {
  registry_number: string;
  full_name: string;
  address: string;
}

export interface CheckInResponse {
  booking_id: string;
  booking_code: string;
  room_number: string;
  verified_full_name: string;
  /** null for walk-ins — identity was verified at registration time. */
  verified_address: string | null;
  status: BookingStatus;
}

export type PaymentMethod = "QPAY" | "CARD";

export interface WalkInResponse {
  booking_id: string;
  booking_code: string;
  room_number: string;
  verified_full_name: string;
  verified_address: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  nightly_rate: string;
  total_amount: string;
  status: BookingStatus;
  payment_due_at_checkout: boolean;
}

export interface MinibarLine {
  item_name: string;
  quantity: number;
  unit_price: string;
  line_total: string;
}

export interface CheckoutResponse {
  booking_id: string;
  booking_code: string;
  guest_full_name: string;
  room_number: string;
  status: BookingStatus;
  room_state: RoomState;
  check_in_date: string;
  /** Actual departure — truncated to today on an early checkout. */
  check_out_date: string;
  /** Departure date originally booked (differs on early checkout). */
  booked_check_out_date: string;
  early_checkout: boolean;
  nights: number;
  nightly_rate: string;
  room_total: string;
  minibar_lines: MinibarLine[];
  minibar_total: string;
  grand_total: string;
  total_amount: string;
  commission_amount: string;
  hotel_amount: string;
  minibar_charged: string | null;
  settled_at: string;
}

/** GET /reception/bookings/{id} — checkout preview. */
export interface BookingDetail {
  id: string;
  code: string;
  room_id: string;
  room_number: string;
  room_state: RoomState;
  guest_full_name: string;
  guest_phone: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  status: BookingStatus;
  nightly_rate: string;
  room_total: string;
  payment_due_at_checkout: boolean;
  housekeeping_reported_minibar_items: MinibarLine[];
  housekeeping_reported_minibar_total: string;
  projected_grand_total: string;
}

// --- Housekeeping (app/api/cleaner_router.py) ------------------------------
export interface DirtyRoom {
  id: string;
  room_number: string;
  floor: number;
  room_type: RoomType;
}

/** GET /cleaner/rooms/occupied — same PII-free shape as DirtyRoom. */
export interface OccupiedRoom {
  id: string;
  room_number: string;
  floor: number;
  room_type: RoomType;
}

export interface MinibarCatalogueItem {
  id: string;
  name: string;
  price: string;
}

export interface MinibarReportResponse {
  room_number: string;
  lines_recorded: number;
  total_amount: string;
}

// --- Manager (app/api/manager_router.py) -----------------------------------
export interface ManagedRoom {
  id: string;
  room_number: string;
  room_type: RoomType;
  beds: number;
  floor: number;
  state: RoomState;
  base_price: string;
  is_active: boolean;
}

export interface MinibarCategory {
  id: string;
  name: string;
  sort_order: number;
}

export interface ManagedMinibarItem {
  id: string;
  category_id: string;
  name: string;
  price: string;
  is_active: boolean;
}

export interface VicinityRestaurant {
  id: string;
  name: string;
  description: string | null;
  phone: string | null;
  is_active: boolean;
  /** True once a login has been provisioned for this restaurant. */
  has_manager?: boolean | null;
}

// --- Platform admin (app/api/admin_router.py) -------------------------------
export interface RevenueDashboard {
  currency: string;
  wallet_balance: string;
  commission_rate: string;
  total_commission_collected: string;
  total_debited: string;
  by_source: Record<string, string>;
  ledger_entries: number;
}

export interface TopRoom {
  room_id: string;
  room_number: string;
  hotel_name: string;
  demand: number;
  gross_revenue: string;
}

// --- Restaurant owner (app/api/restaurant_router.py) ------------------------
export type FoodOrderStatus =
  | "PLACED"
  | "ACCEPTED"
  | "PREPARING"
  | "DELIVERED"
  | "CANCELLED";

export type EscrowStatus =
  | "NOT_FUNDED"
  | "HELD"
  | "RELEASED"
  | "REFUNDED"
  | (string & {});

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price: string;
  is_available: boolean;
  image_url: string | null;
}

export interface FoodOrderLine {
  item_name: string;
  unit_price: string;
  quantity: number;
}

export interface FoodOrder {
  id: string;
  status: FoodOrderStatus;
  escrow_status: EscrowStatus;
  total_amount: string;
  created_at: string;
  items: FoodOrderLine[];
}

// --- Guest marketplace (app/api/booking_router.py, food_order_router.py) ---
export interface HotelSearchResult {
  tenant_id: string;
  name: string;
  slug: string;
  address: string | null;
  maps_lat: number;
  maps_lng: number;
  distance_km: number;
  min_nightly_rate: string | null;
  available_rooms: number;
}

export interface PublicRoom {
  id: string;
  room_number: string;
  room_type: RoomType;
  beds: number;
  floor: number;
  base_price: string;
  state: RoomState;
}

export interface HotelDetail {
  tenant_id: string;
  name: string;
  slug: string;
  address: string | null;
  maps_lat: number;
  maps_lng: number;
  rooms: PublicRoom[];
}

export interface BookResponse {
  booking_id: string;
  booking_code: string;
  hotel_name: string;
  room_number: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  nightly_rate: string;
  total_amount: string;
  currency: string;
  status: BookingStatus;
  escrow_status: EscrowStatus;
  gateway_transaction_id: string;
}

export interface RestaurantPublic {
  id: string;
  name: string;
  description: string | null;
  phone: string | null;
}

export interface MenuItemPublic {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price: string;
}

export interface RestaurantMenu {
  restaurant_id: string;
  restaurant_name: string;
  items: MenuItemPublic[];
}

export interface FoodOrderResponse {
  order_id: string;
  restaurant_name: string;
  room_number: string;
  status: FoodOrderStatus;
  escrow_status: EscrowStatus;
  total_amount: string;
  currency: string;
  gateway_transaction_id: string;
}

// --- Hotel profile (app/api/manager_router.py GET /manager/hotel) ----------
export type SubscriptionPlan =
  | "3_MONTHS"
  | "6_MONTHS"
  | "9_MONTHS"
  | "12_MONTHS";

export interface HotelProfile {
  id: string;
  name: string;
  slug: string;
  contact_email: string;
  contact_phone: string | null;
  address: string | null;
  maps_lat: number;
  maps_lng: number;
  subscription_plan: SubscriptionPlan;
  subscription_started_at: string;
  subscription_expires_at: string;
  is_active: boolean;
  wallet_balance: string;
}

// --- Onboarding lead capture (app/api/onboarding_router.py) ----------------
export type ContactRequestStatus =
  | "NEW"
  | "CONTACTED"
  | "CONVERTED"
  | "REJECTED";

export interface ContactRequestReceipt {
  request_id: string;
  status: ContactRequestStatus;
}

export interface ContactRequest {
  id: string;
  hotel_name: string;
  contact_name: string;
  phone: string;
  status: ContactRequestStatus;
  created_at: string;
}

// --- Staff (app/api/auth_router.py /users) ----------------------------------
export interface StaffUser {
  id: string;
  email: string;
  full_name: string;
  role: UserRoleValue;
  tenant_id: string | null;
  restaurant_id: string | null;
  is_active: boolean;
}

export type UserRoleValue =
  | "PLATFORM_ADMIN"
  | "HOTEL_ADMIN"
  | "MANAGER"
  | "RECEPTION"
  | "CLEANER"
  | "RESTAURANT_OWNER";

/** Roles a hotel admin/manager may provision via POST /auth/users. */
export const HOTEL_STAFF_ROLES = ["MANAGER", "RECEPTION", "CLEANER"] as const;
export type HotelStaffRole = (typeof HOTEL_STAFF_ROLES)[number];

// --- Tenant provisioning (app/api/tenant_admin_router.py) -------------------
export interface TenantCreated {
  tenant_id: string;
  name: string;
  slug: string;
  subscription_plan: SubscriptionPlan;
  subscription_expires_at: string;
  converted_lead_id: string | null;
}

export interface HotelAdminCreated {
  user_id: string;
  email: string;
  full_name: string;
  role: string;
  tenant_id: string;
}

// --- WebSocket events (app/api/websocket_manager.py publishers) ------------
export interface MinibarReportEvent {
  type: "MINIBAR_REPORT";
  room_number: string;
  booking_code: string;
  total_amount: string;
  items: { name: string; quantity: number }[];
}

export type ReceptionWsEvent = MinibarReportEvent | { type: string };

export interface NewFoodOrderEvent {
  type: "NEW_FOOD_ORDER";
  order_id: string;
  room_number: string;
  booking_code: string;
  items: { name: string; quantity: number }[];
  total_amount: string;
  status: FoodOrderStatus;
}

export type RestaurantWsEvent = NewFoodOrderEvent | { type: string };

// --- Police realm (app/api/police_router.py + police_service.py) -----------
export type PoliceMatchStatus = "PENDING_REVIEW" | "CONFIRMED" | "DISMISSED";

/** Watchlist-entry lifecycle. `is_active` is the flag the matcher gates on. */
export type WantedPersonStatus = "WANTED" | "ARRESTED" | "CLEARED";

/** What an officer did when resolving a match. */
export type PoliceResolutionAction = "ARRESTED" | "CONFIRMED" | "DISMISSED";

/** POST /police/login — PoliceTokenResponse. */
export interface PoliceLoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  realm: "police";
  officer_id: string;
  full_name: string;
}

/** GET /police/watchlist / POST /police/watchlist — WantedPersonOut.
 *  Redacted: carries the state-verified identity, NEVER the registry
 *  number or its hash (the raw РД is never stored). */
export interface WantedPerson {
  id: string;
  full_name: string;
  district: string | null;
  address: string | null;
  case_reference: string | null;
  status: WantedPersonStatus;
  is_active: boolean;
  created_at: string;
}

/** GET /police/matches — MatchOut. Registry numbers are NEVER exposed:
 *  the system stores only a salted hash, so no plaintext РД exists. */
export interface PoliceMatch {
  match_id: string;
  status: PoliceMatchStatus;
  matched_at: string;
  wanted_full_name: string;
  case_reference: string | null;
  district: string | null;
  wanted_status: WantedPersonStatus;
  hotel_name: string;
  hotel_address: string | null;
  hotel_maps_lat: number;
  hotel_maps_lng: number;
  room_number: string;
  booking_code: string;
  guest_full_name: string;
  check_in_date: string;
  check_out_date: string;
  reviewed_at: string | null;
  review_note: string | null;
}

/** POST /police/matches/{id}/resolve — ResolveResponse. */
export interface ResolveResponse {
  match_id: string;
  status: PoliceMatchStatus;
  action: PoliceResolutionAction;
  wanted_status: WantedPersonStatus;
  reviewed_at: string;
}

/** GET /police/audit-logs — AuditLogOut. Never exposes a registry number. */
export interface PoliceAuditLog {
  id: string;
  created_at: string;
  action: string;
  officer_name: string | null;
  target_person_name: string | null;
  match_id: string | null;
  note: string | null;
}

/** /ws/police/alerts payload. A new match is always PENDING_REVIEW and the
 *  alert omits status/stay dates (fetch /police/matches for the full row). */
export interface PoliceMatchAlert {
  type: "POLICE_MATCH_ALERT";
  match_id: string;
  matched_at: string;
  wanted_full_name: string;
  case_reference: string | null;
  booking_code: string;
  guest_full_name: string;
  hotel_name: string;
  hotel_address: string | null;
  hotel_maps_lat: number;
  hotel_maps_lng: number;
  room_number: string;
}

export type PoliceWsEvent = PoliceMatchAlert | { type: string };

// --- Admin police-alerts projection (app/api/admin_router.py) --------------
// REDACTED metadata for the platform operator: no registry number, no hash.
// The authoritative dispatch surface is the police realm's /police/matches.
export interface AdminPoliceAlert {
  match_id: string;
  matched_at: string;
  status: PoliceMatchStatus;
  wanted_full_name: string;
  case_reference: string | null;
  tenant_id: string;
  hotel_name: string;
  room_number: string;
  booking_code: string;
  guest_full_name: string;
}

// --- B2C public marketplace (app/api/public_router.py) ---------------------
export interface PublicHotel {
  tenant_id: string;
  name: string;
  slug: string;
  address: string | null;
  maps_lat: number;
  maps_lng: number;
  distance_km: number | null;
  available_rooms: number;
  min_nightly_rate: string | null;
}

/** QPay invoice (qpay_service.QPayInvoice.as_dict). qr_text is the string
 *  to encode into the QR the guest scans. */
export interface QPayInvoice {
  invoice_id: string;
  amount: string;
  currency: string;
  qr_text: string;
  payment_url: string;
  expires_at: string;
}

export interface PublicBookingResponse {
  booking_id: string;
  booking_code: string;
  status: BookingStatus;
  hotel_name: string;
  room_number: string;
  nights: number;
  total_amount: string;
  currency: string;
  qpay_invoice: QPayInvoice;
}

export interface PublicBookingStatus {
  booking_id: string;
  booking_code: string;
  status: BookingStatus;
  escrow_status: EscrowStatus;
  is_funded: boolean;
  paid_at: string | null;
}

/** POST /auth/emongolia — GuestTokenResponse (mock e-Mongolia SSO). */
export interface GuestTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  role: "GUEST";
  guest_id: string;
  full_name: string;
}

// --- B2C in-room dining (app/api/public_food_router.py) --------------------
export interface DiningMenuItem {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price: string;
}

/** GET /public/bookings/{id}/restaurants — vicinity restaurants w/ menus. */
export interface DiningRestaurant {
  restaurant_id: string;
  name: string;
  description: string | null;
  phone: string | null;
  items: DiningMenuItem[];
}

export interface DiningOrderResponse {
  order_id: string;
  restaurant_name: string;
  status: FoodOrderStatus;
  escrow_status: EscrowStatus;
  total_amount: string;
  currency: string;
  qpay_invoice: QPayInvoice;
}

/** GET /public/orders/{id} — payment poll for the dining checkout. */
export interface DiningOrderStatus {
  order_id: string;
  status: FoodOrderStatus;
  escrow_status: EscrowStatus;
  is_funded: boolean;
  paid_at: string | null;
  total_amount: string;
}

// --- Restaurant manager credentials (POST /restaurants/{id}/manager) -------
export interface RestaurantManagerCreated {
  user_id: string;
  email: string;
  full_name: string;
  role: string;
  restaurant_id: string;
  tenant_id: string;
}
