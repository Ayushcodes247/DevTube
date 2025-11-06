const { imagekit } = require("@libs/db");
const { generateID } = require("@libs/utils");
const Channel = require("@models/channel.model");
const Subscription = require("@models/subscription.model");
const axios = require("axios");

module.exports.createChannel = async (req, res) => {
  try {
    const channel = req.channel;
    const uid = generateID(channel.id);

    if (
      req.query.handle &&
      (await Channel.findOne({ handle: req.query.handle })) &&
      req.query.handle !== req.channel.uid
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Channel handle already exists" });
    }

    if (req.file) {
      const response = await imagekit.upload({
        file: req.file?.buffer,
        fileName: req.file?.originalname,
      });

      if (response.url) {
        channel.logoURL = response.url;
      }
    }

    const collectionResponse = await axios.post(
      `https://video.bunnycdn.com/library/${process.env.BUNNY_STREAM_LIBRARY_ID}/collectios`,
      { name: uid },
      {
        headers: {
          AccessKey: process.env.BUNNY_API_KEY,
        },
      }
    );

    const { guid: collectionId } = collectionResponse.data;

    Object.assign(channel, {
      handle: req.body.handle,
      name: req.body.name,
      collectionId,
      uid,
    });

    await channel.save();

    return res
      .status(200)
      .json({ success: true, message: "Channel created successfully", uid });
  } catch (error) {
    console.error("Error while creating channel:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

module.exports.updateChannel = async (req, res) => {
  try {
    const channel = req.channel;

    if (req.files?.logo) {
      const response = await imagekit.upload({
        file: req.files?.logo[0].buffer,
        fileName: req.files.logo[0].originalname,
      });

      if (response.url) {
        channel.logoURL = response.url;
      }
    }

    if (req.files?.banner) {
      const response = await imagekit.upload({
        file: req.files?.banner[0].buffer,
        fileName: req.files?.banner[0].originalname,
      });

      if (response.url) {
        channel.bannerImageURL = response.url;
      }
    }

    Object.assign(channel, {
      handle: req.body?.handle,
      name: req.body?.name,
      description: req.body?.description,
    });

    await channel.save();

    return res
      .status(200)
      .json({ success: true, message: "Channel updated successfully." });
  } catch (error) {
    console.error("Error while updating the channel:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

module.exports.getChannelByHandle = async (handle) => {
  try {
    return await Channel.findOne({ handle });
  } catch (error) {
    console.error("Error while fetching channel by handle:", error);
    throw new Error("Failed to fetch channel by handle");
  }
};

module.exports.getChannelByUid = async (uid) => {
  try {
    return await Channel.findOne({ uid });
  } catch (error) {
    console.error("Error while fetching channel by UID:", error);
    throw new Error("Failed to fetch channel by UID");
  }
};

module.exports.getChannelById = async (id) => {
  try {
    return await Channel.findById(id);
  } catch (error) {
    console.error("Error while fetching channel by ID:", error);
    throw new Error("Failed to fetch channel by ID");
  }
};

module.exports.getSubscription = async ({ subscriber, channel }) => {
  try {
    return await Subscription.findOne({ subscriber, channel });
  } catch (error) {
    console.error("Error while fetching Subscription:", error);
    throw new Error("Failed to fetch Subscription");
  }
};

module.exports.getChannelAndSubscription = async (
  req,
  res,
  isHandle = true
) => {
  try {
    const currentChannel = isHandle
      ? await getChannelByHandle(req.params[0])
      : await getChannelByUid(req.params[0]);

    if (!currentChannel) res.redirect("/404");

    const subscription = await getSubscription({
      subscriber: req.channel?.id,
      channel: currentChannel.id,
    });

    res.render("devtube", { currentChannel, subscription, page: "channel" });
  } catch (error) {
    console.error("Error fetching ", error);
    throw new Error("Failed to fetch ");
  }
};

module.exports.subscribeChannel = async (req, res) => {
  if (!req.channel)
    return res.status(401).json({ error: "Login to subscribe" });

  try {
    const channel = await Channel.findOne({ uid: req.params.uid });

    if (!channel) return res.status(404).json({ error: "Channel not found" });

    if (req.channel.subscriptions.includes(channel.id)) {
      return res
        .status(400)
        .json({ error: "Already subscribed to this channel" });
    }

    const subscription = await Subscription.create({
      subscriber: req.channel.id,
      channel: channel.id,
      mode: "notification",
    });

    req.channel.subscriptions.push(subscription.id);
    channel.subscribers.push(req.channel.id);

    await req.channel.save();
    await channel.save();

    res.status(200).json({
      success: true,
      message: "Subscription successful! Welcome to the club",
    });
  } catch (error) {
    console.error("Subscription error:", error);
    res.status(500).json({
      success: false,
      message: "Oops! Something went wrong while subscribing.",
      error: error.message,
    });
  }
};

module.exports.unsubscribeChannel = async (req, res) => {
  try {
    const channel = await Channel.findOne({ uid: req.params.uid });

    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const subscription = await getSubscription({
      subscriber: req.channel.id,
      channel: channel.id,
    });

    if (!subscription)
      return res.status(404).json({ error: "Not subscribed to this channel" });

    req.channel.subscriptions.pull(subscription._id);
    channel.subscribers.pull(subscription.subscriber);

    await req.channel.save();
    await channel.save();
    await subscription.remove();

    res
      .status(200)
      .json({ success: false, message: "Unsubscribed successfully" });
  } catch (error) {
    console.error("Unsubscription error:", error);
    res.status(500).json({
      success: false,
      message: "Something went wrong while unsubscribing.",
      error: error.message,
    });
  }
};

module.exports.notificationsChannel = async (req, res) => {
  try {
    const channel = await Channel.findOne({ uid: req.params.uid });

    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const subscription = await getSubscription({
      subscriber: req.channel._id,
      channel: channel._id,
    });

    if (!subscription)
      return res.status(404).json({ error: "Not subscribed to this channel" });

    subscription.mode =
      req.params.mode === "notification" ? "notification" : "silent";

    await subscription.save();

    res
      .status(200)
      .json({ success: false, message: "Notifications successfully updated" });
  } catch (error) {
    console.error("Notifications error:", error);
    res.status(500).json({
      success: false,
      message: "Oops! Something went wrong while setting notifications.",
      error: error.message,
    });
  }
};
