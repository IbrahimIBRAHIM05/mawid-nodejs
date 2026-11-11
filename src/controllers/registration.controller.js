
const Event = require("../models/event.model");
const Registration = require("../models/registration.model");
const { isValidEmail } = require("../helpers");

const SLUG_PATTERN = /^[a-z0-9-]{1,120}$/;

const STATUS_BY_CODE = {
    NOT_FOUND: 404,
    DUPLICATE: 409,
    FULL: 409,
    BUSY: 503
};

function notFound(res) {
    return res.status(404).render("error", {
        status: 404,
        message: "Event not found."
    });
}

function renderEventPage(res, status, event, error, values) {
    const registered = event._count.registrations;

    return res.status(status).render("public-event", {
        event,
        registered,
        spotsLeft: Math.max(event.capacity - registered, 0),
        error,
        values
    });
}

async function showEvent(req, res) {
    const slug = req.params.slug;

    if (!SLUG_PATTERN.test(slug)) {
        return notFound(res);
    }

    const event = await Event.findPublicBySlug(slug);

    if (!event) {
        return notFound(res);
    }

    return renderEventPage(res, 200, event, null, {});
}

async function register(req, res) {
    const slug = req.params.slug;

    if (!SLUG_PATTERN.test(slug)) {
        return notFound(res);
    }

    const body = req.body || {};
    const values = {
        name: String(body.name || "").trim(),
        email: String(body.email || "").trim().toLowerCase()
    };

    let error = null;

    if (!values.name || !values.email) {
        error = "Name and email are required.";
    } else if (values.name.length > 100) {
        error = "Name must be 100 characters or fewer.";
    } else if (!isValidEmail(values.email)) {
        error = "Please enter a valid email address.";
    }

    if (error) {
        const event = await Event.findPublicBySlug(slug);
        if (!event) {
            return notFound(res);
        }
        return renderEventPage(res, 400, event, error, values);
    }

    try {
        await Registration.register(slug, values.name, values.email);
    } catch (err) {
        if (!(err instanceof Registration.RegistrationError)) {
            throw err;
        }

        if (err.code === "NOT_FOUND") {
            return notFound(res);
        }

        const event = await Event.findPublicBySlug(slug);
        if (!event) {
            return notFound(res);
        }
        return renderEventPage(res, STATUS_BY_CODE[err.code] || 400, event, err.message, values);
    }

    const event = await Event.findPublicBySlug(slug);

    return res.status(201).render("registered", {
        event,
        name: values.name
    });
}

module.exports = {
    showEvent,
    register
};
