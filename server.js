// server.js — Email Tracking Backend (Mongoose Version)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const requestIp = require("request-ip");
const { connectDB } = require("./lib/db");

// Models
const User = require("./models/User");
const Contact = require("./models/Contact");
const Email = require("./models/Email");
const Event = require("./models/Event");
const Campaign = require("./models/Campaign");

const app = express();
const PORT = process.env.PORT || 3000;

const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

// ✅ CORS — সব allowed origins
app.use(cors({
  origin: [
    "https://optramail.vercel.app",
    "https://mail.google.com",
    /^chrome-extension:\/\//
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-secret"]
}));
app.options("*", cors()); // preflight
app.use(express.json());
app.use(requestIp.mw());

// ✅ Ensure DB is connected for serverless
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("DB Connection Error:", err);
    res.status(500).json({ error: "Database connection failed" });
  }
});

app.get("/", (req, res) => {
  res.send("OptraMail Tracker Server is running! (Mongoose Version)");
});

// ─── PIXEL (OPEN TRACKING) ────────────────────────────────────────────────
app.get("/pixel/:trackingId", async (req, res) => {
  const trackingId = req.params.trackingId.replace(".gif", "");

  res.set({
    "Content-Type": "image/gif",
    "Content-Length": PIXEL_GIF.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Pragma": "no-cache",
    "Expires": "0"
  });
  res.send(PIXEL_GIF);

  try {
    const ip = req.clientIp;
    const userAgent = req.headers["user-agent"] || "";
    const isBot = /bot|crawler|preview|prefetch|GoogleImageProxy/i.test(userAgent);

    const email = await Email.findOne({ trackingId });

    // Store in Event model
    await Event.create({
      emailId: email ? email._id : null,
      eventType: "open",
      meta: { ip, userAgent, isBot, trackingId },
      // Backward compatibility fields
      trackingId,
      isBot,
      ip,
      userAgent,
      timestamp: new Date()
    });

    console.log(`📬 Email opened: ${trackingId} | IP: ${ip} | Bot: ${isBot}`);
  } catch (err) {
    console.error("Failed to log open:", err);
  }
});

// ─── UNIFIED EVENT TRACKING API (Click / PDF Open / PDF Download) ─────────
app.get("/api/track/event", async (req, res) => {
  try {
    const { id, type, url } = req.query;
    if (!id || !url || !type) return res.status(400).send("Missing parameters");

    const ip = req.clientIp;
    const userAgent = req.headers["user-agent"] || "";
    const isBot = /bot|crawler|preview|prefetch|GoogleImageProxy/i.test(userAgent);

    await Event.create({
      trackingId: id,
      eventType: type,
      meta: { url: decodeURIComponent(url) },
      isBot,
      ip,
      userAgent,
      timestamp: new Date()
    });

    console.log(`🖱️ Event [${type}]: ${id} -> ${url}`);
    return res.redirect(decodeURIComponent(url));
  } catch (err) {
    console.error("Failed to log event:", err);
    res.status(500).send("Error");
  }
});

// ─── DASHBOARD: GET ALL CLICKS ────────────────────────────────────────────
app.get("/api/clicks", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "email required" });

    const emails = await Email.find({ userEmail: email }).lean();
    const trackingIds = emails.map(e => e.trackingId);

    const events = await Event.find({
      trackingId: { $in: trackingIds },
      eventType: "click"
    }).sort({ timestamp: -1, createdAt: -1 }).lean();

    const result = events.map(ev => {
      const parentEmail = emails.find(e => e.trackingId === ev.trackingId);
      return {
        ...ev,
        subject: parentEmail?.subject || "Unknown Email",
        url: ev.meta?.url || "Unknown URL"
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch clicks" });
  }
});

// ─── DASHBOARD: GET ALL PDF ANALYTICS ─────────────────────────────────────
app.get("/api/pdf/analytics", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "email required" });

    const emails = await Email.find({ userEmail: email }).lean();
    const trackingIds = emails.map(e => e.trackingId);

    const events = await Event.find({
      trackingId: { $in: trackingIds },
      eventType: { $in: ["pdf_open", "pdf_download"] }
    }).sort({ timestamp: -1, createdAt: -1 }).lean();

    const pdfStats = {};
    events.forEach(ev => {
      const url = ev.meta?.url;
      if (!url) return;
      if (!pdfStats[url]) {
        const parentEmail = emails.find(e => e.trackingId === ev.trackingId);
        pdfStats[url] = { url, subject: parentEmail?.subject || "Unknown", opens: 0, downloads: 0 };
      }
      if (ev.eventType === "pdf_open") pdfStats[url].opens++;
      if (ev.eventType === "pdf_download") pdfStats[url].downloads++;
    });

    res.json(Object.values(pdfStats));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch PDF analytics" });
  }
});

// ─── DASHBOARD: GET PERFORMANCE METRICS ───────────────────────────────────
app.get("/api/performance", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "email required" });

    // 1. Get all emails
    const emails = await Email.find({ userEmail: email }).lean();
    const trackingIds = emails.map(e => e.trackingId);

    // 2. Get all events
    const events = await Event.find({ trackingId: { $in: trackingIds } }).lean();

    const totalSent = emails.length;
    let totalOpen = 0;
    let totalClick = 0;

    events.forEach(e => {
      if (e.eventType === "click") totalClick++;
      else if (e.eventType === "open" || e.eventType === "pdf_open" || !e.eventType) totalOpen++;
    });

    const openRate = totalSent ? (totalOpen / totalSent) * 100 : 0;
    const clickRate = totalSent ? (totalClick / totalSent) * 100 : 0;

    const engagementScore = (totalOpen * 1) + (totalClick * 3);

    let performanceLevel = "Weak";
    if (engagementScore > 50) performanceLevel = "Excellent";
    else if (engagementScore > 20) performanceLevel = "Good";

    res.json({
      totalSent,
      totalOpen,
      totalClick,
      openRate: Number(openRate.toFixed(2)),
      clickRate: Number(clickRate.toFixed(2)),
      engagementScore,
      performanceLevel,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch performance" });
  }
});

// ─── DASHBOARD: MY CRM ────────────────────────────────────────────────────

// 1. Create Contact
app.post("/api/crm/create", async (req, res) => {
  try {
    const { email, name, contactEmail, company } = req.body;
    if (!email || !contactEmail) return res.status(400).json({ error: "missing data" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "user not found" });

    const contact = await Contact.create({
      userId: user._id,
      name,
      email: contactEmail,
      company,
      status: "new",
      tags: []
    });

    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: "Failed to create contact" });
  }
});

// 2. Update Status
app.post("/api/crm/update", async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!id || !status) return res.status(400).json({ error: "missing data" });

    await Contact.findByIdAndUpdate(id, { status });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update status" });
  }
});

// 3. Get Contacts + Auto Insights
app.get("/api/crm/list", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "email required" });

    const user = await User.findOne({ email });
    if (!user) return res.json([]); // return empty if user doesn't exist yet

    const contacts = await Contact.find({ userId: user._id }).lean();
    
    // Find all emails sent by this user
    const emails = await Email.find({ userEmail: email }).lean();
    const trackingIds = emails.map(e => e.trackingId);

    // Find all events for these emails
    const events = await Event.find({ trackingId: { $in: trackingIds } }).lean();

    const enriched = contacts.map(c => {
      // Find emails where the recipient matches the contact's email
      // Note: currently we don't store recipient email in Email schema directly if we use extension, 
      // but wait... in the extension, does the Email schema save `to`?
      // No, `Email` schema only has `subject`.
      // The user's snippet uses `emails.filter(e => e.contactId === c._id)`.
      // We haven't been setting `contactId` on `Email` yet.
      // For MVP, since we don't automatically link extension emails to Contact, we'll return 0s 
      // OR we can check if `email.subject` contains their name? No.
      // I will implement the exact logic the user provided: match by contactId.
      const relatedEmails = emails.filter(e => String(e.contactId) === String(c._id));

      let opens = 0;
      let clicks = 0;

      relatedEmails.forEach(em => {
        events.forEach(ev => {
          if (ev.trackingId === em.trackingId) {
            if (ev.eventType === "open" || ev.eventType === "pdf_open" || !ev.eventType) opens++;
            if (ev.eventType === "click") clicks++;
          }
        });
      });

      const score = (opens * 1) + (clicks * 3);

      return {
        ...c,
        metrics: {
          emailsSent: relatedEmails.length,
          opens,
          clicks,
          score
        }
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch CRM list" });
  }
});

// ─── GET OPEN STATS (Backward Compatibility) ──────────────────────────────
app.get("/api/opens/:trackingId", async (req, res) => {
  try {
    const { trackingId } = req.params;
    // $ne: "click" to catch both "open" events and old missing eventType records
    const opens = await Event.find({ trackingId, eventType: { $ne: "click" }, isBot: { $ne: true } })
      .sort({ timestamp: -1 });

    res.json({
      trackingId,
      openCount: opens.length,
      opens: opens.map(o => ({
        timestamp: o.timestamp,
        ip: o.ip,
        userAgent: o.userAgent
      }))
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch opens" });
  }
});

// ─── TIMELINE API ─────────────────────────────────────────────────────────
app.get("/api/timeline/:trackingId", async (req, res) => {
  try {
    const { trackingId } = req.params;
    const events = await Event.find({ trackingId }).sort({ timestamp: 1, createdAt: 1 });
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch timeline" });
  }
});

// ─── REGISTER EMAIL ───────────────────────────────────────────────────────
app.post("/api/track", async (req, res) => {
  try {
    const { trackingId, subject, sentAt, userEmail } = req.body;
    if (!trackingId) return res.status(400).json({ error: "trackingId required" });

    let user = null;
    if (userEmail) {
      user = await User.findOne({ email: userEmail });
      if (!user) {
        user = await User.create({ email: userEmail });
      }
    }

    await Email.create({
      userId: user ? user._id : null,
      userEmail: userEmail || null, // backward compatibility
      trackingId,
      subject,
      sentAt: sentAt || new Date()
    });

    res.json({ ok: true, trackingId });
  } catch (err) {
    res.status(500).json({ error: "Failed to register email" });
  }
});

// ─── GET USER'S EMAILS (for dashboard) ────────────────────────────────────
app.get("/api/emails", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "email required" });

    const emails = await Email.find({ userEmail: email })
      .sort({ sentAt: -1 })
      .limit(50)
      .lean();

    // Attach open counts
    const result = await Promise.all(emails.map(async (e) => {
      const openCount = await Event.countDocuments({
        trackingId: e.trackingId,
        eventType: { $ne: "click" },
        isBot: { $ne: true }
      });
      const lastOpen = await Event.findOne(
        { trackingId: e.trackingId, eventType: { $ne: "click" }, isBot: { $ne: true } }
      ).sort({ timestamp: -1 });

      return {
        ...e,
        openCount,
        lastOpened: lastOpen?.timestamp || null
      };
    }));

    res.json({ emails: result });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch emails" });
  }
});

// ─── VERIFY LICENSE ───────────────────────────────────────────────────────
app.get("/api/verify-license", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ isPro: false });

    const user = await User.findOne({ email });
    res.json({ isPro: user?.isPro === true });
  } catch (err) {
    res.status(500).json({ isPro: false });
  }
});

// ─── WHOP WEBHOOK ─────────────────────────────────────────────────────────
app.post("/api/whop-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("📦 Whop webhook:", event.action, event?.data?.user?.email);

    const email = event?.data?.user?.email || event?.data?.email;
    if (!email) return res.json({ ok: true });

    if (event.action === "membership_activated") {
      await User.findOneAndUpdate(
        { email },
        { email, isPro: true },
        { upsert: true, new: true }
      );
      console.log(`✅ Pro activated: ${email}`);
    }

    if (event.action === "membership_deactivated") {
      await User.findOneAndUpdate(
        { email },
        { isPro: false },
        { new: true }
      );
      console.log(`❌ Pro revoked: ${email}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

// ─── ADMIN MIDDLEWARE ─────────────────────────────────────────────────────
const jwt = require("jsonwebtoken");
const Admin = require("./models/Admin");

async function adminAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(403).json({ error: "Forbidden: No token provided" });
    }
    const token = authHeader.split(" ")[1];
    const JWT_SECRET = process.env.ADMIN_SECRET || "optramail-admin-2025";
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.adminId) throw new Error("Invalid token");
    req.adminId = decoded.adminId;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Forbidden: Invalid or expired token" });
  }
}

// POST /api/admin/login
app.post("/api/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    // Auto-create default admin if no admins exist
    const adminCount = await Admin.countDocuments();
    if (adminCount === 0) {
      console.log("No admins found, creating default admin");
      const defaultPassword = process.env.ADMIN_SECRET || "OptraMail@Admin2026";
      await Admin.create({ email: "sonjoy.bairagee@gmail.com", password: defaultPassword });
    }

    const admin = await Admin.findOne({ email });
    if (!admin) return res.status(401).json({ error: "Invalid credentials" });

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    const JWT_SECRET = process.env.ADMIN_SECRET || "optramail-admin-2025";
    const token = jwt.sign({ adminId: admin._id }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ ok: true, token });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
}

// GET /api/admin/stats
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const totalUsers  = await User.countDocuments();
    const proUsers    = await User.countDocuments({ isPro: true });
    const freeUsers   = totalUsers - proUsers;
    const totalEmails = await Email.countDocuments();
    const totalOpens  = await Event.countDocuments({ eventType: { $ne: "click" }, isBot: { $ne: true } });
    res.json({ totalUsers, proUsers, freeUsers, totalEmails, totalOpens });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

// GET /api/admin/users
app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).sort({ updatedAt: -1 }).limit(200);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

// GET /api/admin/emails
app.get("/api/admin/emails", adminAuth, async (req, res) => {
  try {
    const emails = await Email.find({}).sort({ sentAt: -1 }).limit(200).lean();

    const result = await Promise.all(emails.map(async (e) => {
      const openCount = await Event.countDocuments({
        trackingId: e.trackingId, eventType: { $ne: "click" }, isBot: { $ne: true }
      });
      return { ...e, openCount };
    }));

    res.json({ emails: result });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

// POST /api/admin/set-pro
app.post("/api/admin/set-pro", adminAuth, async (req, res) => {
  try {
    const { email, isPro } = req.body;
    if (!email) return res.status(400).json({ error: "email required" });

    await User.findOneAndUpdate(
      { email },
      { email, isPro: !!isPro },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

// MANUAL LICENSE GRANT
app.post("/api/grant-pro", async (req, res) => {
  try {
    const { email, secret } = req.body;
    const ADMIN_SECRET = process.env.ADMIN_SECRET || "optramail-admin-2025";

    if (secret !== ADMIN_SECRET) return res.status(403).json({ error: "Forbidden" });
    if (!email) return res.status(400).json({ error: "email required" });

    await User.findOneAndUpdate(
      { email },
      { email, isPro: true },
      { upsert: true, new: true }
    );

    res.json({ ok: true, message: `Pro granted to ${email}` });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Start
connectDB().then(() => {
  if (process.env.NODE_ENV !== "production") {
    app.listen(PORT, () => {
      console.log(`🚀 Tracking server running on port ${PORT}`);
      console.log(`📡 Pixel URL: http://localhost:${PORT}/pixel/:id.gif`);
    });
  }
}).catch(console.error);

// Export for Vercel Serverless
module.exports = app;
