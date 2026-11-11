const prisma = require("../prisma");

// Error with a machine-readable code the controller maps to an HTTP status.
class RegistrationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "RegistrationError";
        this.code = code;
    }
}

const MAX_ATTEMPTS = 3;

function isRetryable(err) {
    if (!err) return false;
    // P2034: write conflict / deadlock reported by Prisma.
    if (err.code === "P2034") return true;
    const text = String(err.message || "");
    // MySQL 1213 = deadlock, 1205 = lock wait timeout.
    return /deadlock|lock wait timeout|\b1213\b|\b1205\b/i.test(text);
}

// Registers one attendee for the event with this public slug.
//
// Concurrency strategy (all inside one InnoDB transaction):
//   1. SELECT ... FOR UPDATE on the event row. Every registration for the
//      same event must take this row lock first, so registrations for one
//      event are processed one at a time while other events are unaffected.
//   2. With the lock held, check for an existing registration with this
//      email and count the current registrations. The transaction runs at
//      READ COMMITTED, so these reads always see rows committed by the
//      previous lock holder, and InnoDB takes no gap locks on the
//      registrations index (registrations for different events never
//      block each other).
//   3. Insert only if there is still room. The lock is released on commit.
//
// The UNIQUE(event_id, email) constraint stays as a final safety net: if
// it ever fires (P2002) it is reported as a duplicate, not a server error.
async function register(slug, name, email) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await prisma.$transaction(async (tx) => {
                const events = await tx.$queryRaw`
                    SELECT id, capacity FROM events WHERE slug = ${slug} FOR UPDATE`;

                if (events.length === 0) {
                    throw new RegistrationError("NOT_FOUND", "This event does not exist.");
                }

                const eventId = Number(events[0].id);
                const capacity = Number(events[0].capacity);

                const existing = await tx.registration.findUnique({
                    where: { eventId_email: { eventId: eventId, email: email } },
                    select: { id: true }
                });

                if (existing) {
                    throw new RegistrationError("DUPLICATE", "This email is already registered for this event.");
                }

                const counted = await tx.$queryRaw`
                    SELECT COUNT(*) AS taken FROM registrations WHERE event_id = ${eventId}`;
                const taken = Number(counted[0].taken);

                if (taken >= capacity) {
                    throw new RegistrationError("FULL", "Sorry, this event is full.");
                }

                return tx.registration.create({
                    data: { eventId: eventId, name: name, email: email },
                    select: { id: true, name: true, email: true, createdAt: true }
                });
            }, {
                isolationLevel: "ReadCommitted",
                maxWait: 10000, // ms to wait for a free connection
                timeout: 10000  // ms the transaction may run, including lock waits
            });
        } catch (err) {
            if (err instanceof RegistrationError) {
                throw err;
            }

            if (err && err.code === "P2002") {
                throw new RegistrationError("DUPLICATE", "This email is already registered for this event.");
            }

            if (isRetryable(err) && attempt < MAX_ATTEMPTS) {
                continue;
            }

            if (err && (err.code === "P2028" || isRetryable(err))) {
                throw new RegistrationError("BUSY", "Registration is busy right now. Please try again in a moment.");
            }

            throw err;
        }
    }
}

module.exports = {
    register,
    RegistrationError
};
