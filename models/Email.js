const mongoose = require("mongoose");

const EmailSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    userEmail: { type: String }, // backward compatibility
    trackingId: { type: String, unique: true },
    subject: { type: String, default: "No Subject" },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Email || mongoose.model("Email", EmailSchema);
