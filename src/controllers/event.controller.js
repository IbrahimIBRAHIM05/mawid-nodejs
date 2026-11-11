
const Event = require("../models/event.model");
const { publicEventUrl, parseLocalDateTime } = require("../helpers");

const MAX_CAPACITY = 10000;

function validateEvent(body) {
    const values = {
        title: String(body.title || "").trim(),
        location: String(body.location || "").trim(),
        startsAt: String(body.startsAt || "").trim(),
        capacity: String(body.capacity || "").trim()
    };

    if (!values.title || !values.startsAt || !values.capacity) {
        return { values, error: "Title, start date/time and capacity are required." };
    }

    if (values.title.length > 200) {
        return { values, error: "Title must be 200 characters or fewer." };
    }

    if (values.location.length > 255) {
        return { values, error: "Location must be 255 characters or fewer." };
    }

    const startsAt = parseLocalDateTime(values.startsAt);

    if (!startsAt) {
        return { values, error: "Start date/time is not a valid date." };
    }

    if (startsAt.getTime() <= Date.now()) {
        return { values, error: "Start date/time must be in the future." };
    }

    if (!/^\d+$/.test(values.capacity)) {
        return { values, error: "Capacity must be a whole number." };
    }

    const capacity = Number(values.capacity);

    if (capacity < 1 || capacity > MAX_CAPACITY) {
        return { values, error: `Capacity must be between 1 and ${MAX_CAPACITY}.` };
    }

    return {
        values,
        error: null,
        data: {
            title: values.title,
            location: values.location || null,
            startsAt: startsAt,
            capacity: capacity
        }
    };
}

async function dashboard(req, res) {
    const events = await Event.listByOrganizer(req.session.user.id);

    res.render("dashboard", {
        events: events.map((event) => ({
            ...event,
            registered: event._count.registrations,
            publicUrl: publicEventUrl(req, event.slug)
        }))
    });
}

function showNew(req, res) {
    res.render("event-new", { error: null, values: {} });
}

async function create(req, res) {
    const result = validateEvent(req.body || {});

    if (result.error) {
        return res.status(400).render("event-new", {
            error: result.error,
            values: result.values
        });
    }

    const event = await Event.create(req.session.user.id, result.data);

    res.redirect(`/events/${event.id}?created=1`);
}

async function show(req, res) {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;

    // findOwnedById only matches events owned by the logged-in organizer.
    // Another organizer's event gets the same 404 as a missing one, so
    // event IDs cannot be probed.
    const event = Number.isSafeInteger(id)
        ? await Event.findOwnedById(id, req.session.user.id)
        : null;

    if (!event) {
        return res.status(404).render("error", {
            status: 404,
            message: "Event not found."
        });
    }

    res.render("event-show", {
        event,
        publicUrl: publicEventUrl(req, event.slug),
        created: req.query.created === "1"
    });
}

module.exports = {
    dashboard,
    showNew,
    create,
    show,
    validateEvent
};
