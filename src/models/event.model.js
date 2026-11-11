const crypto = require("crypto");
const prisma = require("../prisma");

const SLUG_MAX_LENGTH = 120; // matches events.slug VARCHAR(120)
const SLUG_ATTEMPTS = 5;

// Turns "Ramadan Iftar 2026!" into "ramadan-iftar-2026".
function slugifyTitle(title) {
    return title
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
        .replace(/-+$/g, "");
}

// Readable prefix + 64 bits of randomness (16 hex chars), so links cannot
// be guessed from the title or by counting.
function generateSlug(title) {
    const random = crypto.randomBytes(8).toString("hex");
    const base = slugifyTitle(title);
    const slug = base ? `${base}-${random}` : `event-${random}`;
    return slug.slice(0, SLUG_MAX_LENGTH);
}

function isSlugCollision(err) {
    if (!err || err.code !== "P2002") {
        return false;
    }
    const target = err.meta && (err.meta.target || (err.meta.driverAdapterError && err.meta.driverAdapterError.cause && err.meta.driverAdapterError.cause.constraint));
    const text = JSON.stringify(target || "");
    // If Prisma does not tell us the column, events only has one unique
    // constraint besides the primary key, so it must be the slug.
    return !target || text.includes("slug");
}

async function create(organizerId, data) {
    for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
        try {
            return await prisma.event.create({
                data: {
                    organizerId: organizerId,
                    slug: generateSlug(data.title),
                    title: data.title,
                    location: data.location,
                    startsAt: data.startsAt,
                    capacity: data.capacity
                }
            });
        } catch (err) {
            if (isSlugCollision(err) && attempt < SLUG_ATTEMPTS) {
                continue;
            }
            throw err;
        }
    }
}

// Only returns the event when it belongs to this organizer.
async function findOwnedById(id, organizerId) {
    return prisma.event.findFirst({
        where: {
            id: id,
            organizerId: organizerId
        },
        include: {
            registrations: {
                orderBy: { createdAt: "asc" },
                select: { id: true, name: true, email: true, createdAt: true }
            }
        }
    });
}

async function listByOrganizer(organizerId) {
    return prisma.event.findMany({
        where: { organizerId: organizerId },
        orderBy: { startsAt: "asc" },
        include: {
            _count: { select: { registrations: true } }
        }
    });
}

// Public lookup: no organizer details, no attendee data, only a count.
async function findPublicBySlug(slug) {
    return prisma.event.findUnique({
        where: { slug: slug },
        select: {
            id: true,
            slug: true,
            title: true,
            location: true,
            startsAt: true,
            capacity: true,
            _count: { select: { registrations: true } }
        }
    });
}

module.exports = {
    create,
    findOwnedById,
    listByOrganizer,
    findPublicBySlug,
    generateSlug,
    slugifyTitle
};
