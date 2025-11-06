const { Schema, model } = require("mongoose");

const subscriptionSchema = new Schema(
  {
    subscriber: { type: Schema.Types.ObjectId, ref: "Channel", required: true },
    channel: { type: Schema.Types.ObjectId, ref: "Channel", required: true },
    mode: { type: String, enum: ["silent", "notification"], required: true },
  },
  {
    timestamps: true,
  }
);

const Subscription = model("Subscription", subscriptionSchema);

module.exports = Subscription;
