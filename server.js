import express from "express";
import Stripe from "stripe";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

const { STRIPE_SECRET, STRIPE_PUBLISHABLE, PORT = 3000, BASE_URL = `http://localhost:${3000}` } = process.env;
const stripe = new Stripe(STRIPE_SECRET || "", { apiVersion: "2023-10-16" });

app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(`window.STRIPE_PUBLISHABLE_KEY=${JSON.stringify(STRIPE_PUBLISHABLE || "")};`);
});

const prices = { "regular+": 500, vip: 1000, vvip: 10000 };

app.post("/create-stripe-session", async (req, res) => {
  try {
    const { ticketType, qty = 1 } = req.body || {};
    const unit = prices[ticketType];
    if (!unit) return res.status(400).json({ error: "Invalid ticket type" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "aed",
          product_data: { name: ticketType === "vvip" ? "VVIP Table (8 People)" : `${ticketType} Ticket` },
          unit_amount: unit * 100
        },
        quantity: qty
      }],
      mode: "payment",
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel.html`
    });
    res.json({ id: session.id });
  } catch (e) {
    console.error("Stripe error:", e);
    res.status(500).json({ error: "Stripe session failed" });
  }
});

app.get("/success.html", (_req, res) => res.send("<h1>Payment successful</h1><a href='/'>Back</a>"));
app.get("/cancel.html", (_req, res) => res.send("<h1>Payment cancelled</h1><a href='/'>Back</a>"));

app.use(express.static("public", { extensions: ["html"] }));

app.listen(PORT, () => console.log(`✅ Server running on ${BASE_URL} (port ${PORT})`));
