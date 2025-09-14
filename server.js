import express from "express";
import fetch from "node-fetch";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

const {
  STRIPE_SECRET,
  STRIPE_PUBLISHABLE,
  PAYTABS_PROFILE_ID,
  PAYTABS_SERVER_KEY,
  TAP_SECRET,
  PORT = 3000,
  BASE_URL = `http://localhost:${3000}`
} = process.env;

const stripe = new Stripe(STRIPE_SECRET || "", { apiVersion: "2023-10-16" });

const DATA_DIR = "data";
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, "[]");

function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8") || "[]");
  } catch {
    return [];
  }
}
function saveOrder(order) {
  const orders = loadOrders();
  orders.push(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// Publishable key for frontend
app.get("/config.js", (_req, res) => {
  res
    .type("application/javascript")
    .send(
      `window.STRIPE_PUBLISHABLE_KEY=${JSON.stringify(
        STRIPE_PUBLISHABLE || ""
      )};`
    );
});

// Ticket prices (AED)
const prices = { "regular+": 500, vip: 1000, vvip: 10000 };

/* -------------------------------
   STRIPE CHECKOUT
--------------------------------- */
app.post("/create-stripe-session", async (req, res) => {
  try {
    const { ticketType, qty, name, phone } = req.body;
    const amount = prices[ticketType];
    if (!amount) return res.status(400).json({ error: "Invalid ticket type" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "aed",
            product_data: {
              name:
                ticketType === "vvip"
                  ? "VVIP Table (8 People)"
                  : `${ticketType} Ticket`,
            },
            unit_amount: amount * 100,
          },
          quantity: qty || 1,
        },
      ],
      mode: "payment",
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel.html`,
      metadata: { ticketType, qty, name, phone, gateway: "stripe" },
    });

    saveOrder({
      id: session.id,
      gateway: "stripe",
      status: "PENDING",
      name,
      phone,
      ticketType,
      qty,
      amount: amount * (qty || 1),
      created_at: new Date().toISOString(),
    });

    res.json({ id: session.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

/* -------------------------------
   PAYTABS
--------------------------------- */
app.post("/create-paytabs-session", async (req, res) => {
  try {
    const { ticketType, qty, name, phone } = req.body;
    const unit = prices[ticketType];
    if (!unit) return res.status(400).json({ error: "Invalid ticket type" });
    const amount = unit * (qty || 1);
    const cart_id = "PT-" + Date.now();

    const payload = {
      profile_id: PAYTABS_PROFILE_ID,
      tran_type: "sale",
      tran_class: "ecom",
      cart_id,
      cart_currency: "AED",
      cart_amount: amount,
      cart_description:
        ticketType === "vvip"
          ? `VVIP Table (8 People) x ${qty || 1}`
          : `${ticketType} ticket(s)`,
      return: `${BASE_URL}/success.html`,
      callback: `${BASE_URL}/paytabs-callback`,
      customer_details: {
        name: name || "Guest",
        email: "guest@example.com",
        phone: phone || "971500000000",
        country: "AE",
      },
    };

    const resp = await fetch("https://secure.paytabs.com/payment/request", {
      method: "POST",
      headers: {
        authorization: PAYTABS_SERVER_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();

    saveOrder({
      id: cart_id,
      gateway: "paytabs",
      status: "PENDING",
      name,
      phone,
      ticketType,
      qty,
      amount,
      created_at: new Date().toISOString(),
    });

    res.json({ redirect_url: data.redirect_url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "PayTabs session failed" });
  }
});

app.post("/paytabs-callback", express.json(), (req, res) => {
  try {
    const body = req.body || {};
    const cart_id = body.cart_id || body.reference_no || "PT-" + Date.now();
    const status = body.response_status || body.payment_result || "UNKNOWN";
    const orders = loadOrders();
    const idx = orders.findIndex((o) => o.id === cart_id);

    const update = {
      status:
        typeof status === "string" ? status : JSON.stringify(status),
      gateway_txn: body.tran_ref || body.transaction_id || "",
    };

    if (idx >= 0) orders[idx] = { ...orders[idx], ...update };
    else
      orders.push({
        id: cart_id,
        gateway: "paytabs",
        ...update,
        created_at: new Date().toISOString(),
      });

    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

/* -------------------------------
   TAP
--------------------------------- */
app.post("/create-tap-link", async (req, res) => {
  try {
    const { ticketType, qty, name, phone } = req.body;
    const unit = prices[ticketType];
    if (!unit) return res.status(400).json({ error: "Invalid ticket type" });
    const amount = unit * (qty || 1);
    const ref = "TAP-" + Date.now();

    const payload = {
      amount,
      currency: "AED",
      invoice: { sup_id: "NANAS_PROMO" },
      customer: {
        first_name: name || "Guest",
        phone: {
          country_code: "971",
          number: (phone || "").replace(/\D/g, "") || "500000000",
        },
      },
      description:
        ticketType === "vvip"
          ? `VVIP Table (8 People) x ${qty || 1}`
          : `${ticketType} ticket(s)`,
      redirect_url: `${BASE_URL}/success.html`,
      notify_url: `${BASE_URL}/tap-callback`,
      metadata: { ticketType, qty, name, phone, ref },
    };

    const resp = await fetch("https://api.tap.company/v2/payment_links", {
      method: "POST",
      headers: { Authorization: `Bearer ${TAP_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    const link = data.url || data.redirect_url || "";

    saveOrder({
      id: ref,
      gateway: "tap",
      status: "PENDING",
      name,
      phone,
      ticketType,
      qty,
      amount,
      link,
      created_at: new Date().toISOString(),
    });

    res.json({ redirect_url: link });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "TAP link creation failed" });
  }
});

app.post("/tap-callback", express.json(), (req, res) => {
  try {
    const body = req.body || {};
    const ref =
      (body && body.metadata && body.metadata.ref) || "TAP-" + Date.now();
    const status =
      body.status || (body.response && body.response.message) || "UNKNOWN";
    const orders = loadOrders();
    const idx = orders.findIndex((o) => o.id === ref);

    const update = {
      status:
        typeof status === "string" ? status : JSON.stringify(status),
      gateway_txn: body.id || "",
    };

    if (idx >= 0) orders[idx] = { ...orders[idx], ...update };
    else
      orders.push({
        id: ref,
        gateway: "tap",
        ...update,
        created_at: new Date().toISOString(),
      });

    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

/* -------------------------------
   ADMIN ENDPOINTS
--------------------------------- */
app.get("/admin/orders.json", (_req, res) => res.json(loadOrders()));

app.get("/admin/orders.csv", (_req, res) => {
  const orders = loadOrders();
  const cols = [
    "id",
    "gateway",
    "status",
    "name",
    "phone",
    "ticketType",
    "qty",
    "amount",
    "link",
    "gateway_txn",
    "created_at",
  ];
  const header = cols.join(",");
  const rows = orders.map((o) =>
    cols
      .map((k) => `"${(o[k] ?? "").toString().replace(/\"/g, '""')}"`)
      .join(",")
  );
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=orders.csv");
  res.send([header, ...rows].join("\n"));
});

// File upload for tickets
const storage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, "public/tickets"),
  filename: (_r, f, cb) =>
    cb(null, "TICKET_" + Date.now() + path.extname(f.originalname || ".pdf")),
});
const upload = multer({ storage });

app.post("/admin/upload-ticket", upload.single("ticket"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const url = `${BASE_URL}/tickets/${req.file.filename}`;
  res.json({ url });
});

/* -------------------------------
   STATIC FILES
--------------------------------- */
app.use(express.static("public", { extensions: ["html"] }));

app.listen(PORT, () =>
  console.log(`✅ Server running on ${BASE_URL} (port ${PORT})`)
);
