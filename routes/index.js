const express = require("express");
const router = express.Router();
const api = require("./api");
const channel = require("./channel");
const studio = require("./studio");
const watch = require("./watch");
const { getPlayerLink , getTagVideos , getPublicVideos , getShorts } = require("@controllers/video.controller");

const axios = require("axios");

const { getChannelAndSubscription } = require("@controllers/channel.controller");
const { checkChannel , isLoggedIn } = require("@middlewares/all.middleware");
const Tag = require("@models/tag.model");

router.get("/", async (req, res) => {
    res.render("devtube", { page: "home" });
});

module.exports = router;