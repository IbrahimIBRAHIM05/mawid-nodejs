
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const sessionMiddleware = require("./session");
const authRoutes = require("./routes/auth.routes");
const eventRoutes = require("./routes/event.routes");
const registrationRoutes = require("./routes/registration.routes");
const { formatDateTime } = require("./helpers");

const app = express();

if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "view"));

app.locals.formatDateTime = formatDateTime;

app.use(helmet());
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(sessionMiddleware);

app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

app.get("/", (req, res) => {
    res.render("home");
});

app.use(authRoutes);
app.use(eventRoutes);
app.use(registrationRoutes);

app.use((req, res) => {
    res.status(404).render("error", {
        status: 404,
        message: "Page not found."
    });
});

// Last-resort error handler. Logs the error on the server only and shows
// a generic message, so stack traces, SQL and config never reach the page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;

    if (status >= 500) {
        console.error(`[${req.method} ${req.originalUrl}] ${err.stack || err.message}`);
    }

    if (res.headersSent) {
        return;
    }

    res.locals.user = (req.session && req.session.user) || null;

    res.status(status).render("error", {
        status,
        message: status >= 500
            ? "Something went wrong. Please try again."
            : (status === 413 ? "The submitted form is too large." : "The request could not be processed.")
    });
});

module.exports = app;
