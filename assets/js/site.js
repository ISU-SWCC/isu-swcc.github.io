function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[ch]));
}

function onSubpage() {
    return window.location.pathname.includes("/pages/");
}

function assetPath(path) {
    if (!path) return "";
    if (/^(https?:|mailto:|\/)/.test(path)) return path;
    return (onSubpage() ? "../" : "") + path.replace(/^\.\//, "");
}

async function loadJSON(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json();
}

async function loadMenu() {
    const prefix = onSubpage() ? "../" : "";
    const response = await fetch(prefix + "components/menu.html");
    if (!response.ok) throw new Error("menu.html " + response.status);
    let html = await response.text();
    if (onSubpage()) {
        html = html
            .replaceAll('href="index.html"', 'href="../index.html"')
            .replaceAll('src="assets/', 'src="../assets/');
    } else {
        html = html
            .replaceAll('href="about.html"', 'href="pages/about.html"')
            .replaceAll('href="events.html"', 'href="pages/events.html"')
            .replaceAll('href="products.html"', 'href="pages/products.html"')
            .replaceAll('href="contact.html"', 'href="pages/contact.html"');
    }
    document.getElementById("menu-placeholder").innerHTML = html;
}

function initials(name) {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase();
}

function eventParts(event) {
    const pieces = String(event.date).split("-").map(Number);
    const year = pieces[0];
    const month = pieces[1];
    const day = pieces.length === 3 ? pieces[2] : null;
    let hours = null;
    let minutes = null;
    if (event.time) {
        const clock = event.time.split(":").map(Number);
        hours = clock[0];
        minutes = clock[1];
    }
    return { year, month, day, hours, minutes };
}

function eventDate(event) {
    const parts = eventParts(event);
    if (parts.day == null) return new Date(parts.year, parts.month - 1, 1);
    return new Date(parts.year, parts.month - 1, parts.day, parts.hours || 0, parts.minutes || 0);
}

function formatEventWhen(event) {
    const parts = eventParts(event);
    const monthName = new Date(parts.year, parts.month - 1, 1).toLocaleString("en-US", { month: "long" });
    if (parts.day == null) return `${monthName} ${parts.year}`;
    const stamp = new Date(parts.year, parts.month - 1, parts.day, parts.hours || 0, parts.minutes || 0);
    if (parts.hours == null) {
        return stamp.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    }
    return stamp.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

function eventIsPast(event, now) {
    const parts = eventParts(event);
    if (parts.day == null) {
        return parts.year < now.getFullYear() || (parts.year === now.getFullYear() && parts.month < now.getMonth() + 1);
    }
    const end = new Date(parts.year, parts.month - 1, parts.day, parts.hours == null ? 23 : parts.hours, parts.minutes == null ? 59 : parts.minutes);
    return end < now;
}
