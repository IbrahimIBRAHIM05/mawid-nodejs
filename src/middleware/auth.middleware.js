
// Allows the request through only when an organizer is logged in.
// Anyone else is sent to the login page.
function requireAuth(req, res, next) {
    if (req.session && req.session.user && req.session.user.id) {
        return next();
    }

    return res.redirect("/login");
}

module.exports = {
    requireAuth
};
