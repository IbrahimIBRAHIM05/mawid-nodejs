
const express = require("express");
const registrationController = require("../controllers/registration.controller");

const router = express.Router();

// Public pages: no login required.
router.get("/e/:slug", registrationController.showEvent);
router.post("/e/:slug/register", registrationController.register);

module.exports = router;
