const { Schema, model } = require("mongoose");

const tagSchema = new Schema(
  {
    name: { type: String, trim: true, required: true, unique: true },
    videos: [{ type: Schema.Types.ObjectId, ref: "Video" }],
    channels: [{ type: Schema.Types.ObjectId, ref: "Channel" }],
  },
  {
    timestamps: true,
  }
);

const Tag = model("Tag", tagSchema);

module.exports = Tag;
