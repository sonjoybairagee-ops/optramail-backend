const mongoose = require("mongoose");

const ContactSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    email: String,
    name: String,
    company: String,
    status: { 
      type: String, 
      enum: ["new", "contacted", "interested", "converted"], 
      default: "new" 
    },
    tags: [String],
  },
  { timestamps: true }
);

module.exports = mongoose.models.Contact || mongoose.model("Contact", ContactSchema);
