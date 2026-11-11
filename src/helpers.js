
// Small helpers shared by controllers and views.

// Base URL used to build shareable links. APP_URL wins (set it when the app
// runs behind a proxy or on another host); otherwise use the request's host.
function baseUrl(req) {
    const configured = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
    if (configured) {
        return configured;
    }
    return `${req.protocol}://${req.get("host")}`;
}

function publicEventUrl(req, slug) {
    return `${baseUrl(req)}/e/${encodeURIComponent(slug)}`;
}

// Example: "Friday, November 20, 2026 at 6:00 PM". Uses the server's time
// zone, which is the same machine as the organizer during local development.
function formatDateTime(date) {
    return new Date(date).toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "short"
    });
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
    return email.length <= 255 && EMAIL_PATTERN.test(email);
}

// Parses the value of <input type="datetime-local"> ("2026-11-20T18:00")
// as server-local time. Returns null for anything malformed or impossible
// (e.g. February 30th).
function parseLocalDateTime(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!match) {
        return null;
    }

    const [, y, mo, d, h, mi, s] = match.map((part) => (part === undefined ? undefined : Number(part)));
    const date = new Date(y, mo - 1, d, h, mi, s || 0);

    if (
        Number.isNaN(date.getTime()) ||
        date.getFullYear() !== y ||
        date.getMonth() !== mo - 1 ||
        date.getDate() !== d ||
        date.getHours() !== h ||
        date.getMinutes() !== mi
    ) {
        return null;
    }

    return date;
}

module.exports = {
    baseUrl,
    publicEventUrl,
    formatDateTime,
    isValidEmail,
    parseLocalDateTime
};
