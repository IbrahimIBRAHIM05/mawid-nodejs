
const bcrypt = require("bcrypt");
const User = require("../models/user.model");

// Issues a fresh session ID when someone logs in, so a session ID planted
// before login (session fixation) cannot be reused afterwards.
function startSession(req, user) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
            if (err) {
                return reject(err);
            }

            req.session.user = user;
            req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
        });
    });
}

function showSignup(req, res) {
    res.render("signup", { error: null });
}

async function signup(req, res) {
    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";

    if (!name || !email || !password) {
        return res.status(400).render("signup", {
            error: "All fields are required."
        });
    }

    if (password.length < 8) {
        return res.status(400).render("signup", {
            error: "Password must be at least 8 characters."
        });
    }

    const existing = await User.findByEmail(email);

    if (existing) {
        return res.status(400).render("signup", {
            error: "That email is already taken."
        });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    let id;
    try {
        id = await User.create(name, email, passwordHash);
    } catch (err) {
        // Two sign-ups with the same email at the same moment: the unique
        // index on users.email rejects the second one.
        if (err && err.code === "P2002") {
            return res.status(400).render("signup", {
                error: "That email is already taken."
            });
        }
        throw err;
    }

    await startSession(req, { id, name });

    res.redirect("/");
}

function showLogin(req, res) {
    res.render("login", { error: null });
}

async function login(req, res) {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";

    const user = await User.findByEmail(email);

    if (!user) {
        return res.status(401).render("login", {
            error: "Wrong email or password."
        });
    }

    const match = await bcrypt.compare(password, user.passwordHash);

    if (!match) {
        return res.status(401).render("login", {
            error: "Wrong email or password."
        });
    }

    await startSession(req, {
        id: user.id,
        name: user.name
    });

    res.redirect("/");
}

function logout(req, res) {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).send("Logout failed");
        }

        res.clearCookie("connect.sid");
        res.redirect("/");
    });
}

module.exports = {
    showSignup,
    signup,
    showLogin,
    login,
    logout
};
