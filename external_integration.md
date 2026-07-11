# 🚀 Гадаад Системүүдийн Холболтын Гарын Авлага (External API Integrations Guide)

**Төслийн Архитектороос (Lead Architect):**
Сайн байна уу? Энэхүү баримт бичиг нь манай B2B2C Hotel PMS & Police Security платформд e-Mongolia, ХУР (XYP) болон QPay системүүдийн бодит (Production) холболтыг хийхэд зориулагдсан болно. 

Одоогийн байдлаар эдгээр системүүдийн "Mock" (Хийсвэр) үйлчилгээнүүд бичигдсэн байгаа ба Системийн архитектур, Баазын түгжээ (Row-level lock), Аюулгүй байдлын тусгаарлалт (RLS) бүрэн хийгдэж дууссан. Таны гол ажил бол **Эдгээр Mock сервисүүдийн дотоод логикийг Бодит API дуудлагаар солих** юм.

⚠️ **АРХИТЕКТУРЫН ХАТУУ ДҮРМҮҮД (MUST DO):**
1. **PII Хамгаалалт:** Системийн баазад Регистрийн Дугаар (РД) **ХЭЗЭЭ Ч** илээр хадгалагдах ёсгүй. Зөвхөн `compute_registry_hash()` ашиглаж Hash хэлбэрээр хадгална.
2. **Idempotency (Давхардал):** Төлбөрийн webhook болон баазын бичилтүүд `SELECT ... FOR UPDATE` гэсэн Lock-той байгаа. Үүнийг хэрхэвч устгаж, өөрчилж болохгүй.
3. **Realm Isolation:** Зочид буудлын ажилтан, Нийтийн хэрэглэгч, Цагдаагийн эрхүүд баазын түвшинд (RLS) хатуу тусгаарлагдсан байгаа.

---

## 1️⃣ ХУР (XYP) Системийн Холболт (Police & Reception Realm)

**Зорилго:** Цагдаа сэжигтнийг бүртгэх болон Ресепшн зочныг оруулах үед РД-аар ХУР системээс иргэний мэдээлэл татах.
**Засах файл:** `backend/gov_service.py` (болон холбогдох service)

### Хийгдэх ажлууд:
*   Одоо байгаа `mock_khur_client` логикийг жинхэнэ ХУР системийн WSDL/SOAP эсвэл REST API дуудлагаар солих.
*   **Authentication:** ХУР системийн VPN эсвэл Тоон гарын үсэг (Digital Signature / Certificate) ашиглан хүсэлт илгээх логикийг бичих.
*   **Mapping:** ХУР-аас ирсэн мэдээллийг манай системийн шаардаж буй `first_name`, `last_name`, `address`, `district` талбарууд руу хөрвүүлэх (Map хийх).

**Анхаарах зүйл:**
> `POST /api/v1/police/watchlist` API нь ХУР руу РД явуулж мэдээллийг нь аваад, РД-г Hash болгон хувиргаж баазад хадгалдаг. Та ХУР-аас дата татаж ирэх сервис давхаргыг л янзлах бөгөөд Router болон Database логикт гар хүрэх шаардлагагүй.

---

## 2️⃣ QPay Төлбөрийн Систем (B2C Marketplace)

**Зорилго:** B2C хэрэглэгчдийн захиалгыг баталгаажуулах динамик QR үүсгэх, төлбөр төлөгдсөн Webhook хүлээж авах.
**Засах файл:** `backend/qpay_service.py` болон `public_router.py`

### Хийгдэх ажлууд:
*   **QPay Token Management:** QPay v2 API руу `client_id`, `client_secret` ашиглан хандаж Access Token авах. Токен нь хугацаатай тул Redis эсвэл in-memory (cache) дотор хадгалж, дууссан үед дахин авах логик хийх.
*   **Invoice үүсгэх:** Хэрэглэгч `POST /api/v1/public/bookings` дуудах үед QPay руу `invoice_receiver_code`, `amount`, `callback_url` явуулж Invoice ID болон QR текстийг татаж авах.
*   **Webhook Signature:** QPay-ээс ирэх `POST /api/v1/payments/qpay-webhook` хүсэлтийн `X-QPay-Signature` (HMAC-SHA256) баталгаажуулалтыг жинхэнэ Secret key ашиглан баталгаажуулах.

**Анхаарах зүйл (Idempotency):**
> Одоогийн Webhook дээр байгаа `UPDATE bookings SET status='CONFIRMED', escrow_status='FUNDED' WHERE status='PENDING' AND qpay_invoice_id = :invoice_id RETURNING id` гэсэн код нь QPay-ийн давхардсан дуудлагуудаас хамгаалсан (Idempotent) цөм хэсэг юм. Энэ логикийг хэвээр нь үлдээнэ үү!

---

## 3️⃣ e-Mongolia SSO Нэвтрэх хэсэг (B2C Marketplace)

**Зорилго:** Нийтийн хэрэглэгчид Marketplace-д e-Mongolia апп ашиглан нэвтэрч орох.
**Засах файл:** `backend/public_router.py` (`POST /api/v1/auth/emongolia`) болон шинээр `sso_service.py` үүсгэх.

### Хийгдэх ажлууд:
*   **OAuth 2.0 / OIDC Flow:** e-Mongolia-ийн Authorization Code Grant урсгалыг нэвтрүүлэх.
*   Хэрэглэгч e-Mongolia-оос буцаж ирэх үед (Callback) ирсэн `code`-ийг Access Token-оор сольж, e-Mongolia-аас хэрэглэгчийн утас, нэрийг татаж авах.
*   Тухайн утасны дугаараар манай баазад `UserRole.GUEST` эрхтэй хэрэглэгч байгаа эсэхийг шалгах, байхгүй бол үүсгэх.
*   Эцэст нь манай системийн `auth.py` доторх `create_access_token(..., realm="app")` функцийг ашиглаж өөрсдийн JWT-г буцаах.

---

## 🛠 Гадаад орчны хувьсагчид (Environment Variables)

Та хөгжүүлэлт хийхдээ доорх хувьсагчуудыг `.env` файл дотроо нэмж ажиллана уу:

```env
# XYP / KHUR
KHUR_API_BASE_URL=[https://api.xyp.gov.mn](https://api.xyp.gov.mn)...
KHUR_CLIENT_CERT_PATH=/etc/certs/khur.crt
KHUR_CLIENT_KEY_PATH=/etc/certs/khur.key

# QPAY
QPAY_USE_MOCKS=False  # Үүнийг False болгож байж жинхэнэ API ажиллана
QPAY_BASE_URL=[https://merchant.qpay.mn/v2](https://merchant.qpay.mn/v2)
QPAY_CLIENT_ID=your_client_id
QPAY_CLIENT_SECRET=your_client_secret
QPAY_WEBHOOK_SECRET=your_webhook_hmac_secret

# E-MONGOLIA
EMONGOLIA_CLIENT_ID=your_emongolia_client
EMONGOLIA_CLIENT_SECRET=your_emongolia_secret
EMONGOLIA_REDIRECT_URI=[https://your-domain.mn/api/v1/auth/emongolia/callback](https://your-domain.mn/api/v1/auth/emongolia/callback)