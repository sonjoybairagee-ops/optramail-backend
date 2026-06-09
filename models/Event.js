const mongoose = require("mongoose");

const EventSchema = new mongoose.Schema(
  {
    emailId: { type: mongoose.Schema.Types.ObjectId, ref: "Email" },
    eventType: { type: String }, // "open" | "click"
    meta: Object, // { ua, ip, isBot, url, etc. }
    
    // Backward compatibility for old "opens" records
    trackingId: { type: String }, 
    isBot: { type: Boolean },
    ip: { type: String },
    userAgent: { type: String },
    timestamp: { type: Date }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Event || mongoose.model("Event", EventSchema, "opens");
