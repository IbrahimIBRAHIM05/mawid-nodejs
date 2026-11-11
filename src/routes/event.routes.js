
const express = require("express");
const eventController = require("../controllers/event.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();

// Organizer-only pages. Ownership is checked inside the controller.
router.get("/dashboard", requireAuth, eventController.dashboard);
router.get("/events/new", requireAuth, eventController.showNew);
router.post("/events", requireAuth, eventController.create);
router.get("/events/:id", requireAuth, eventController.show);

module.exports = router;
