const Video = require("@models/video.model");
const { generateID, formatNumber, getTimestamp } = require("@libs/utils");
const { conn } = require("@libs/db");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const { channel } = require("diagnostics_channel");
const { getSubscription } = require("./channel.controller");
const Channel = require("@models/channel.model");
const Tag = require("@models/tag.model");
const Comment = require("@models/comment.model");

const BUNNY_API_KEY = process.env.BUNNY_API_KEY;
const BUNNY_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;

const extractHashtags = (text, limit) =>
  (text.match(/#[\w]+/g) || [])
    .map((ht) => ht.slice(1))
    .slice(0, limit || undefined);

const createVideo = async (req, res) => {
  const thumbnail = req.file;
  const { visibility, videoId, tags, title, description, comments, view } =
    req.body;
  const tagsArray = JSON.parse(tags);

  try {
    if (thumbnail) {
      const partsArray = thumbnail.path.split("\\");
      const thumbnailUrl = `${process.env.HOST_URL}/${partsArray[1]}/${partsArray[2]}`;
      const bunnyResponse = await axios.post(
        `https://video.bunnycdn.com/library/${process.env.BUNNY_STREAM_LIBRARY_ID}/videos/${videoId}/thumbnail?thumbnailUrl=${thumbnailUrl}`,
        null,
        {
          headers: {
            accept: "application/json",
            AccessKey: process.env.BUNNY_API_KEY,
          },
        }
      );
      fs.unlink("./public/temp-upload/" + partsArray[2], (err) => {
        if (err) {
          console.error("Failed to delete file:", err);
        } else {
          console.info("File deleted successfully");
        }
      });
    }

    let video = await Video.findOneAndUpdate(
      { videoId },
      {
        $set: {
          isDraft: false,
          privacySettings: visibility,
          title,
          description,
          commentsStatus: comments.toLowerCase() === "on",
          viewsEnabled: view.toLowerCase() === "on",
        },
      },
      { upsert: true, new: true }
    );

    // Delete video reference from all existing tags
    await Tag.updateMany(
      { videos: video._id },
      { $pull: { videos: video._id } }
    );

    const hashTags = extractHashtags(description);

    const updatedTags = await Promise.all(
      tagsArray.map(async (tagName) => {
        let tag = await Tag.findOne({ name: tagName });
        if (!tag) tag = new Tag({ name: tagName });
        tag.videos.push(video._id);
        await tag.save();
        return tag;
      })
    );

    const updatedHashTags = await Promise.all(
      hashTags.map(async (hashTagName) => {
        let tag = await Tag.findOne({ name: hashTagName });
        if (!tag) tag = new Tag({ name: hashTagName });
        tag.videos.push(video._id);
        await tag.save();
        return tag;
      })
    );

    await axios.post(
      `https://video.bunnycdn.com/library/${process.env.BUNNY_LIBRARY_ID}/videos/${videoId}`,
      {
        metaTags: [
          { property: "title", value: title },
          { property: "description", value: description },
          {
            property: "tags",
            value: updatedTags.map((tag) => tag._id).join(","),
          },
          { property: "privacySettings", value: visibility },
          { property: "commentsStatus", value: comments },
          { property: "viewsEnabled", value: view },
          { property: "isDraft", value: "false" },
          { property: "uid", value: video.uid },
        ],
      },
      {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          AccessKey: process.env.BUNNY_API_KEY,
        },
        data: { title },
      }
    );

    if (!video.uploadDate && visibility == "public")
      video.uploadDate = new Date();

    video.tags = updatedTags.map((tag) => tag._id);
    video.hashTags = updatedHashTags.map((hashTag) => hashTag._id);
    await video.save();

    res.status(200).json({ message: "Video Updated" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong!" });
  }
};

const editVideo = async () => {};

const getVideo = async (req, res) => {
  try {
    const bunnyVideo = await getBunnyVideo(req.params.id);

    const video = await Video.findOne({ videoId: req.params.id }).populate(
      "tags"
    );
    const tagNames = video.tags.map((tag) => tag.name);
    const tags = tagNames.join(",");

    const {
      thumbnailFileName,
      category,
      title: filename,
      availableResolutions,
      metaTags,
    } = bunnyVideo;
    const {
      description,
      title,
      viewsEnabled,
      commentsStatus,
      status,
      privacySettings,
      uid,
    } = video;

    res.send({
      viewsEnabled,
      filename,
      thumbnailFileName,
      title,
      description,
      status,
      tags,
      uid,
      commentsStatus,
      privacySettings,
      availableResolutions,
      category,
    });
  } catch (error) {
    console.error(error.message);
    res.status(500).send("Internal Server Error");
  }
};

const getBunnyVideo = async (videoId) => {
  try {
    const response = await axios.get(
      `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoId}`,
      {
        headers: { accept: "application/json", AccessKey: BUNNY_API_KEY },
      }
    );
    return response.data;
  } catch (error) {
    console.error(error);
    return null;
  }
};

const getPlayerLink = async (req, res) => {
  const video = await Video.findOne({ uid: req.query.v })
    .populate("channel comments")
    .populate({
      path: "hashTags",
      select: "name",
    });

  if (!video) return res.render("error", { message: "Video Not Found" });

  const isOwner = video.channel.id === req.channel?.id;

  if ((video.isDraft || video.privacySettings === "private") && !isOwner)
    return res.render("error", {
      message: "This video isn't available anymore",
    });

  const bunnyVideo = await getBunnyVideo(video.videoId);

  video.views = bunnyVideo?.views;

  video.timestamp = getTimestamp(video?.uploadDate || video?.createdAt);

  const subscription = await getSubscription({
    subscriber: req.channel?.id,
    channel: video.channel.id,
  });

  return { subscription, video, page: "player" };
};

const createUpload = async (req, res) => {
  const { filename } = req.body;
  const channel = await Channel.findOne({ _id: req.channel.id });
  if (!channel) return res.status(404).send("Channel not found");

  const videoResponse = await axios.post(
    `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`,
    { title: filename, collectionId: channel.collectionId },
    { headers: { AccessKey: BUNNY_API_KEY } }
  );

  const { guid: videoId } = videoResponse.data;

  let uid;
  let tempVideo;
  do {
    uid = generateID(videoId, 11, " ");
    tempVideo = await Video.findOne({ uid });
  } while (tempVideo);

  const newVideo = new Video({
    filename,
    videoId,
    uid,
    channel: channel.id,
    title: filename,
  });
  await newVideo.save();

  channel.videos.push(newVideo._id);
  await channel.save();

  const expirationTime = Math.floor(Date.now() / 1000) + 3600;
  const authorizationSignature = crypto
    .createHash("sha256")
    .update(`${BUNNY_LIBRARY_ID}${BUNNY_API_KEY}${expirationTime}${videoId}`)
    .digest("hex");

  const headers = {
    AuthorizationSignature: authorizationSignature,
    AuthorizationExpire: expirationTime,
    VideoId: videoId,
    LibraryId: BUNNY_LIBRARY_ID,
  };

  res.json({ uploadUrl: `https://video.bunnycdn.com/tusupload`, headers });
};

const getStudioVideos = async (req, res) => {
  try {
    const videos = await getVideos({
      channel: req.channel._id,
      page: req.query?.page || 1,
      limit: req.query?.limit || 10,
    });
    res.status(200).json(videos);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
};

const getStudioShorts = async (req, res) => {
  try {
    const shorts = await getVideos({
      channel: req.channel._id,
      page: req.query?.page || 1,
      limit: req.query?.limit || 10,
      isShort: true,
    });
    res.status(200).json(shorts);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
};

const getTagShorts = async (req, res) => {
  try {
    const shorts = await getVideos({
      page: req.query?.page || 1,
      tag: req.param.tag,
      privacySettings: "public",
      limit: req.query?.limit || 10,
      isShort: true,
    });
    res.status(200).json(shorts);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
};

const getTagVideos = async (req, res) => {
  try {
    const videos = await getVideos({
      tag: req.params.tag,
      privacySettings: "public",
      page: req.query?.page || 1,
      limit: req.query?.limit || 10,
    });
    res.status(200).json(videos);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
};

const searchVideos = async ({
  page = 1,
  limit = 10,
  search = null,
  collection = null,
  orderBy = null,
}) => {
  const response = await axios.request({
    method: "GET",
    url: `https://video.bunnycdn.com/library/${
      process.env.BUNNY_STREAM_LIBRARY_ID
    }/videos?page=${page}&limit=${limit}&collection=${collection}${
      search ? "&search=" + search : ""
    }${orderBy ? "&orderBy=" + orderBy : ""}`,
    headers: {
      accept: "application/json",
      AccessKey: process.env.BUNNY_API_KEY,
    },
  });
  return response.data;
};

const deleteVideo = async (req, res) => {
  try {
    const video = await Video.findOneAndRemove({
      videoId: req.params.videoId,
      channel: req.channel.id,
    });

    if (!video) return res.status(404).send("Video not found");

    const videoResponse = await axios.delete(
      `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${req.params.videoId}`,
      { headers: { AccessKey: BUNNY_API_KEY } }
    );

    if (videoResponse.data.success)
      res.status(200).send("Video deleted successfully");
    else res.status(404).send("Video not found");
  } catch (error) {
    console.error(error);
  }
};

const canEdit = async (req, res) => {
  const video = await Video.findOne({ videoId: req.params.id });
  if (!video) return res.status(404).send("Video not found");
  if (video.channel.toString() == req.channel.id.toString())
    return res.status(200).send("You can edit this video");
  else return res.status(403).send("You are not authorized to edit this video");
};

const updateVideoLikesDislikes = async (req, res) => {
  try {
    const video = await Video.findById(req.params.videoId);
    if (!video) return res.status(404).json({ error: "Video not found" });

    const update = {
      $pull: {
        [req.query.action === "like" ? "dislikes" : "likes"]: req.channel.id,
      },
      ...(req.query.action === "like"
        ? {
            [video.likes.includes(req.channel.id) ? "$pull" : "$addToSet"]: {
              likes: req.channel.id,
            },
          }
        : {
            [video.dislikes.includes(req.channel.id) ? "$pull" : "$addToSet"]: {
              dislikes: req.channel.id,
            },
          }),
    };

    const updatedVideo = await Video.findByIdAndUpdate(
      req.params.videoId,
      update,
      { new: true }
    );
    res.status(200).json({ likes: formatNumber(updatedVideo.likes.length) });
  } catch (error) {
    res.status(500).json({ error: `Error updating video: ${error.message}` });
  }
};

const getPublicVideos = async (req, res) => {
  try {
    const videos = await getVideos({
      privacySettings: "public",
      page: req.query?.page || 1,
      limit: req.query?.limit || 10,
      channel: req.query?.channel,
      tag: req.query?.tag,
      searchText: req.query?.search,
    });
    res.status(200).json(videos);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
};

const getShorts = async (req, res) => {
  try {
    console.log(req.query);
    const videos = await getVideos({
      privacySettings: "public",
      page: req.query?.page || 1,
      limit: parseInt(req.query?.limit) || 1,
      uid: req.query?.uid,
      notUid: req.query?.notUid,
      channel: req.query?.channel,
      tag: req.query?.tag,
      isShort: true,
    });
    res.status(200).json(videos);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
};

const getVideos = async (criteria) => {
  var {
    channel,
    lengthGreaterThan,
    lengthLessThan,
    privacySettings,
    category,
    title,
    description,
    sortOrder,
    isShort = false,
    page = 1,
    limit = 10,
    tag,
    searchText,
    uid,
    notUid,
  } = criteria;

  limit = parseInt(limit);

  const query = {};

  if (channel) query.channel = channel;

  if (lengthGreaterThan !== undefined)
    query.length = { ...query.length, $gt: lengthGreaterThan };

  if (lengthLessThan !== undefined)
    query.length = { ...query.length, $lt: lengthLessThan };

  if (privacySettings) query.privacySettings = privacySettings;

  if (title) query.title = { $regex: title, $options: "i" };
  if (description) query.description = { $regex: description, $options: "i" };

  if (searchText) {
    const sanitizedSearchText = searchText.replace(/\s+/g, "");
    query.$or = [
      { title: { $regex: sanitizedSearchText, $options: "i" } },
      { description: { $regex: sanitizedSearchText, $options: "i" } },
    ];
  }

  if (category) query.category = category.toLowerCase();

  if (isShort !== undefined) query.isShort = isShort;

  if (uid) {
    query.uid = uid;
  }

  if (notUid) {
    query.uid = { $ne: notUid };
  }

  if (tag) {
    const tagData = await Tag.findOne({ name: tag });
    query.$or = [
      { tags: { $in: [tagData?._id || null] } },
      { hashTags: { $in: [tagData?._id || null] } },
    ];
  }

  const sortOptions = {};
  if (sortOrder) sortOptions.uploadDate = sortOrder === "asc" ? 1 : -1;

  try {
    const totalItems = await Video.countDocuments(query).exec();

    const videos = await Video.find(query)
      .select(
        "title videoId description isDraft privacySettings likes dislikes uid uploadDate comments"
      )
      .sort(sortOptions)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .populate({
        path: "channel",
        select: "name uid logoURL",
      })
      .exec();

    const next = page * limit < totalItems ? page + 1 : null;
    const previous = page > 1 ? page - 1 : null;
    const videosWithDetails = await Promise.all(
      videos.map(async (video) => {
        const {
          videoId,
          channel,
          description,
          isDraft,
          uploadDate,
          privacySettings,
          title,
          comments,
          uid,
          likes,
          dislikes,
        } = video;

        const bunnyVideo = await getBunnyVideo(videoId);

        const { views, length, thumbnailFileName, category } = bunnyVideo;

        return {
          restrictions:
            category.toLowerCase() === "adult" ||
            category.toLowerCase() === "hentai"
              ? "18+"
              : "none",
          thumbnailFileName,
          uid,
          videoId,
          channel,
          likes,
          views,
          length,
          description,
          isDraft,
          uploadDate,
          privacySettings,
          title,
          comments: comments.length,
          likeDislike:
            likes.length + dislikes.length === 0
              ? 0
              : (likes.length / (likes.length + dislikes.length)) * 100,
        };
      })
    );

    return {
      totalItems,
      currentPage: page,
      next,
      previous,
      items: videosWithDetails,
    };
  } catch (error) {
    console.error("Error fetching videos:", error);
    throw error;
  }
};

module.exports = {
  getShorts,
  getTagVideos,
  getPublicVideos,
  getTagShorts,
  updateVideoLikesDislikes,
  editVideo,
  createVideo,
  canEdit,
  createUpload,
  getBunnyVideo,
  getPlayerLink,
  getVideo,
  getVideos,
  deleteVideo,
  searchVideos,
  getStudioVideos,
  getStudioShorts,
};
