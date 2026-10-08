const WATERSHED_COLORS = ["white", "dem", "satellite", "topo"];
const US_BOXES = [
    [-125, 24, -66, 50],
    [-170, 51, -129, 72],
    [-161, 18, -154, 23],
    [-68, 17.5, -64.5, 18.6],
];

function finite(value) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
}

function product(values) {
    let total = 1;
    for (const value of values) {
        if (!Number.isFinite(value)) return null;
        total *= value;
    }
    return total;
}

function featureName(feature, index) {
    const props = feature.properties || {};
    return String(props.name || props.Name || props.id || `Basin ${index + 1}`);
}

function featureBbox(feature) {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    const visit = (coords) => {
        if (typeof coords[0] === "number") {
            bounds[0] = Math.min(bounds[0], coords[0]);
            bounds[1] = Math.min(bounds[1], coords[1]);
            bounds[2] = Math.max(bounds[2], coords[0]);
            bounds[3] = Math.max(bounds[3], coords[1]);
            return;
        }
        coords.forEach(visit);
    };
    visit(feature.geometry.coordinates);
    return bounds;
}

function featureCenter(feature) {
    const box = featureBbox(feature);
    return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

function centroidInUS(feature) {
    const [lng, lat] = featureCenter(feature);
    return US_BOXES.some(([west, south, east, north]) => lng >= west && lng <= east && lat >= south && lat <= north);
}

function featurePointsMeters(feature) {
    const [lng0, lat0] = featureCenter(feature);
    const points = [];
    const visit = (coords) => {
        if (typeof coords[0] === "number") {
            points.push(localMeters(coords[0], coords[1], lng0, lat0));
            return;
        }
        coords.forEach(visit);
    };
    visit(feature.geometry.coordinates);
    return { lng0, lat0, points };
}

function rotateMeters(east, north, deg) {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [east * c - north * s, east * s + north * c];
}

function boundsOf(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    points.forEach(([x, y]) => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    });
    return {
        minX, minY, maxX, maxY,
        width: maxX - minX,
        height: maxY - minY,
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
    };
}

function factorPairs(count) {
    const pairs = [];
    for (let cols = 1; cols <= count; cols += 1) {
        if (count % cols === 0) pairs.push([cols, count / cols]);
    }
    return pairs;
}

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2);

function meridianArc(phi) {
    const e2 = WGS84_E2;
    const e4 = e2 * e2;
    const e6 = e4 * e2;
    return WGS84_A * (
        (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
        - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
        + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
        - (35 * e6 / 3072) * Math.sin(6 * phi)
    );
}

function utmForward(lon, lat, zone, south) {
    const e2 = WGS84_E2;
    const ep2 = WGS84_EP2;
    const k0 = 0.9996;
    const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    const phi = lat * Math.PI / 180;
    const lam = lon * Math.PI / 180;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const tanPhi = Math.tan(phi);
    const n = WGS84_A / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const t = tanPhi * tanPhi;
    const c = ep2 * cosPhi * cosPhi;
    const a = (lam - lon0) * cosPhi;
    const m = meridianArc(phi);
    const a2 = a * a;
    const a3 = a2 * a;
    const a4 = a2 * a2;
    const a5 = a4 * a;
    const a6 = a4 * a2;
    const east = k0 * n * (
        a
        + (1 - t + c) * a3 / 6
        + (5 - 18 * t + t * t + 72 * c - 58 * ep2) * a5 / 120
    ) + 500000.0;
    let north = k0 * (
        m
        + n * tanPhi * (
            a2 / 2
            + (5 - t + 9 * c + 4 * c * c) * a4 / 24
            + (61 - 58 * t + t * t + 600 * c - 330 * ep2) * a6 / 720
        )
    );
    if (south) north += 10000000.0;
    return [east, north];
}

function utmInverse(east, north, zone, south) {
    const e2 = WGS84_E2;
    const ep2 = WGS84_EP2;
    const e4 = e2 * e2;
    const e6 = e4 * e2;
    const k0 = 0.9996;
    const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    const x = east - 500000.0;
    const y = north - (south ? 10000000.0 : 0.0);
    const m = y / k0;
    const mu = m / (WGS84_A * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const e12 = e1 * e1;
    const e13 = e12 * e1;
    const e14 = e12 * e12;
    const phi1 = (
        mu
        + (3 * e1 / 2 - 27 * e13 / 32) * Math.sin(2 * mu)
        + (21 * e12 / 16 - 55 * e14 / 32) * Math.sin(4 * mu)
        + (151 * e13 / 96) * Math.sin(6 * mu)
        + (1097 * e14 / 512) * Math.sin(8 * mu)
    );
    const sinPhi = Math.sin(phi1);
    const cosPhi = Math.cos(phi1);
    const tanPhi = Math.tan(phi1);
    const n1 = WGS84_A / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const t1 = tanPhi * tanPhi;
    const c1 = ep2 * cosPhi * cosPhi;
    const r1 = WGS84_A * (1 - e2) / (1 - e2 * sinPhi * sinPhi) ** 1.5;
    const d = x / (n1 * k0);
    const d2 = d * d;
    const d3 = d2 * d;
    const d4 = d2 * d2;
    const d5 = d4 * d;
    const d6 = d4 * d2;
    const lat = phi1 - (n1 * tanPhi / r1) * (
        d2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d6 / 720
    );
    const lon = lon0 + (
        d
        - (1 + 2 * t1 + c1) * d3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d5 / 120
    ) / cosPhi;
    return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

function albersQ(phi) {
    const e = Math.sqrt(WGS84_E2);
    const s = Math.sin(phi);
    return (1 - WGS84_E2) * (
        s / (1 - WGS84_E2 * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s))
    );
}

function albersM(phi) {
    return Math.cos(phi) / Math.sqrt(1 - WGS84_E2 * Math.sin(phi) ** 2);
}

function albersConstants(lat1, lat2, lat0) {
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const phi0 = lat0 * Math.PI / 180;
    const q1 = albersQ(phi1);
    const q2 = albersQ(phi2);
    const q0 = albersQ(phi0);
    const m1 = albersM(phi1);
    const m2 = albersM(phi2);
    const n = Math.abs(q2 - q1) < 1e-14 ? Math.sin(phi1) : (m1 * m1 - m2 * m2) / (q2 - q1);
    const c = m1 * m1 + n * q1;
    const rho0 = WGS84_A * Math.sqrt(c - n * q0) / n;
    return { n, c, rho0 };
}

function albersForward(lon, lat, lat1, lat2, lat0, lon0) {
    const constants = albersConstants(lat1, lat2, lat0);
    const q = albersQ(lat * Math.PI / 180);
    const rho = WGS84_A * Math.sqrt(Math.max(0, constants.c - constants.n * q)) / constants.n;
    const theta = constants.n * (lon - lon0) * Math.PI / 180;
    return [rho * Math.sin(theta), constants.rho0 - rho * Math.cos(theta)];
}

function phiFromQ(q) {
    let phi = Math.asin(Math.max(-1, Math.min(1, q / 2)));
    for (let step = 0; step < 20; step += 1) {
        const qn = albersQ(phi);
        const delta = 1e-8;
        const slope = (albersQ(phi + delta) - qn) / delta;
        if (Math.abs(slope) < 1e-14) break;
        const change = (qn - q) / slope;
        phi -= change;
        if (Math.abs(change) < 1e-14) break;
    }
    return phi;
}

function albersInverse(east, north, lat1, lat2, lat0, lon0) {
    const { n, c, rho0 } = albersConstants(lat1, lat2, lat0);
    let theta;
    let rho;
    if (n > 0) {
        theta = Math.atan2(east, rho0 - north);
        rho = Math.hypot(east, rho0 - north);
    } else {
        theta = Math.atan2(-east, north - rho0);
        rho = -Math.hypot(east, rho0 - north);
    }
    const q = (c - (rho * n / WGS84_A) ** 2) / n;
    const phi = phiFromQ(q);
    const lam = lon0 * Math.PI / 180 + theta / n;
    return [lam * 180 / Math.PI, phi * 180 / Math.PI];
}

function projectPoint(lon, lat, crs) {
    if (crs.kind === "utm") return utmForward(lon, lat, crs.zone, crs.south);
    return albersForward(lon, lat, crs.lat_1, crs.lat_2, crs.lat_0, crs.lon_0);
}

function unprojectPoint(east, north, crs) {
    if (crs.kind === "utm") return utmInverse(east, north, crs.zone, crs.south);
    return albersInverse(east, north, crs.lat_1, crs.lat_2, crs.lat_0, crs.lon_0);
}

function utmZoneFromLon(lon) {
    return Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
}

function crsUtm(zone, south) {
    const number = Math.min(60, Math.max(1, Math.floor(zone) || 1));
    return {
        kind: "utm",
        zone: number,
        south: !!south,
        epsg: (south ? 32700 : 32600) + number,
        label: `UTM zone ${number}${south ? "S" : "N"}`,
    };
}

function crsAlbersBasin(bounds) {
    const south = bounds[1];
    const north = bounds[3];
    const span = Math.max(0.5, north - south);
    return {
        kind: "albers",
        lat_1: south + span / 6,
        lat_2: north - span / 6,
        lat_0: (south + north) / 2,
        lon_0: (bounds[0] + bounds[2]) / 2,
        epsg: null,
        label: "Albers equal area",
    };
}

function crsAlbersNA() {
    return {
        kind: "albers",
        lat_1: 29.5,
        lat_2: 45.5,
        lat_0: 23,
        lon_0: -96,
        epsg: 5070,
        label: "Albers equal area EPSG:5070",
    };
}

function sameCrs(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "utm") return a.zone === b.zone && !!a.south === !!b.south;
    return Math.abs(a.lat_1 - b.lat_1) < 1e-6
        && Math.abs(a.lat_2 - b.lat_2) < 1e-6
        && Math.abs(a.lat_0 - b.lat_0) < 1e-6
        && Math.abs(a.lon_0 - b.lon_0) < 1e-6;
}

function projectOutline(geometry, crs) {
    const visit = (coords) => {
        if (coords && typeof coords[0] === "number") return projectPoint(coords[0], coords[1], crs);
        return coords.map(visit);
    };
    return visit(geometry.coordinates);
}

function outlinePoints(outline) {
    const points = [];
    const visit = (coords) => {
        if (coords && typeof coords[0] === "number") {
            points.push([coords[0], coords[1]]);
            return;
        }
        if (Array.isArray(coords)) coords.forEach(visit);
    };
    visit(outline);
    return points;
}

function fitSquares(feature, count, alignment, outline, crs) {
    const n = Math.max(1, Math.min(100, Math.floor(count) || 1));
    let lng0;
    let lat0;
    let points;
    let origin = null;
    let fitCrs = null;
    const raw = outline && crs ? outlinePoints(outline) : [];
    if (raw.length) {
        const frame = boundsOf(raw);
        origin = [frame.cx, frame.cy];
        points = raw.map(([east, north]) => [east - origin[0], north - origin[1]]);
        fitCrs = crs;
        const center = featureCenter(feature);
        lng0 = center[0];
        lat0 = center[1];
    } else {
        const local = featurePointsMeters(feature);
        lng0 = local.lng0;
        lat0 = local.lat0;
        points = local.points;
    }
    const border = n > 1 ? 0.5 : 0;
    const angles = alignment === "max" ? Array.from({ length: 180 }, (_, index) => index) : [0];
    let best = null;
    angles.forEach((deg) => {
        const rotated = points.map(([east, north]) => rotateMeters(east, north, deg));
        const box = boundsOf(rotated);
        if (box.width <= 0 || box.height <= 0) return;
        factorPairs(n).forEach(([cols, rows]) => {
            const innerW = cols * 24 - 2 * border;
            const innerH = rows * 24 - 2 * border;
            const inchesPerMeter = Math.min(innerW / box.width, innerH / box.height);
            if (!best || inchesPerMeter > best.inchesPerMeter) {
                best = {
                    cols, rows, rotationDeg: deg, inchesPerMeter, borderIn: border,
                    lng0, lat0, count: n, cx: box.cx, cy: box.cy,
                    crs: fitCrs, origin,
                };
            }
        });
    });
    const squares = new Set();
    for (let col = 0; col < best.cols; col += 1) {
        for (let row = 0; row < best.rows; row += 1) squares.add(squareKey(col, row));
    }
    best.squares = squares;
    best.metersPerInch = 1 / best.inchesPerMeter;
    best.outerWidthIn = best.cols * 24;
    best.outerHeightIn = best.rows * 24;
    return best;
}

function modelInchesToLngLat(mx, my, fit) {
    const rx = mx / fit.inchesPerMeter + fit.cx;
    const ry = my / fit.inchesPerMeter + fit.cy;
    const t = (fit.rotationDeg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const east = rx * c + ry * s;
    const north = -rx * s + ry * c;
    if (fit.crs && fit.origin) return unprojectPoint(east + fit.origin[0], north + fit.origin[1], fit.crs);
    return localLngLat(east, north, fit.lng0, fit.lat0);
}

function modelSquareRing(col, row, fit) {
    const left = (col - fit.cols / 2) * 24;
    const bottom = (row - fit.rows / 2) * 24;
    const corners = [
        [left, bottom],
        [left + 24, bottom],
        [left + 24, bottom + 24],
        [left, bottom + 24],
        [left, bottom],
    ];
    return corners.map(([x, y]) => modelInchesToLngLat(x, y, fit));
}

function modelInsetRing(fit) {
    const inset = fit.borderIn;
    const left = -fit.outerWidthIn / 2 + inset;
    const right = fit.outerWidthIn / 2 - inset;
    const bottom = -fit.outerHeightIn / 2 + inset;
    const top = fit.outerHeightIn / 2 - inset;
    return [[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]]
        .map(([x, y]) => modelInchesToLngLat(x, y, fit));
}

function localMeters(lng, lat, lng0, lat0) {
    const east = (lng - lng0) * 111320 * Math.cos((lat0 * Math.PI) / 180);
    const north = (lat - lat0) * 110540;
    return [east, north];
}

function localLngLat(east, north, lng0, lat0) {
    return [
        lng0 + east / (111320 * Math.cos((lat0 * Math.PI) / 180)),
        lat0 + north / 110540,
    ];
}

function squareKey(col, row) {
    return `${col},${row}`;
}

function parseSquare(key) {
    const [col, row] = key.split(",").map(Number);
    return { col, row };
}

function squaresConnected(keys) {
    if (keys.size <= 1) return true;
    const first = keys.values().next().value;
    const seen = new Set([first]);
    const queue = [first];
    while (queue.length) {
        const { col, row } = parseSquare(queue.pop());
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dc, dr]) => {
            const key = squareKey(col + dc, row + dr);
            if (keys.has(key) && !seen.has(key)) {
                seen.add(key);
                queue.push(key);
            }
        });
    }
    return seen.size === keys.size;
}

function squareRing(col, row, scale, lng0, lat0) {
    const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]];
    return corners.map(([dc, dr]) => localLngLat((col + dc) * scale, (row + dr) * scale, lng0, lat0));
}

function layoutSize(keys) {
    const cells = [...keys].map(parseSquare);
    const cols = cells.map((cell) => cell.col);
    const rows = cells.map((cell) => cell.row);
    const width = (Math.max(...cols) - Math.min(...cols) + 1) * 24;
    const height = (Math.max(...rows) - Math.min(...rows) + 1) * 24;
    return { count: keys.size, widthIn: width, heightIn: height };
}

function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersect = ((yi > lat) !== (yj > lat))
            && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function pointInFeature(lng, lat, feature) {
    const polygons = feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    return polygons.some((rings) => pointInRing(lng, lat, rings[0]) && !rings.slice(1).some((hole) => pointInRing(lng, lat, hole)));
}

function squareContains(lng, lat, col, row, scale, lng0, lat0) {
    const [east, north] = localMeters(lng, lat, lng0, lat0);
    return east >= (col - 0.5) * scale && east <= (col + 0.5) * scale
        && north >= (row - 0.5) * scale && north <= (row + 0.5) * scale;
}

function basinCoverage(feature, keys, scale) {
    if (!feature || !keys.size) return null;
    const box = featureBbox(feature);
    const [lng0, lat0] = featureCenter(feature);
    let inside = 0;
    let covered = 0;
    const steps = 24;
    for (let x = 0; x < steps; x += 1) {
        for (let y = 0; y < steps; y += 1) {
            const lng = box[0] + ((x + 0.5) / steps) * (box[2] - box[0]);
            const lat = box[1] + ((y + 0.5) / steps) * (box[3] - box[1]);
            if (!pointInFeature(lng, lat, feature)) continue;
            inside += 1;
            const hit = [...keys].some((key) => {
                const { col, row } = parseSquare(key);
                return squareContains(lng, lat, col, row, scale, lng0, lat0);
            });
            if (hit) covered += 1;
        }
    }
    if (!inside) return null;
    return covered / inside;
}

const CUBIC_INCH_CM3 = 16.387064;
const LB_PER_KG = 2.2046226218;
const ZONE_DAYS = { 2: "1–2", 3: "2", 4: "2–3", 5: "3", 6: "3–4", 7: "4", 8: "4–5" };

function padZip(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length < 5) return "";
    return digits.slice(0, 5);
}

function isUnitedStates(country) {
    const text = String(country || "").trim().toLowerCase();
    return text === "us" || text === "usa" || text === "united states";
}

function nearestZip(rows, lon, lat) {
    if (!rows || !rows.length) return "";
    let best = null;
    let bestDistance = Infinity;
    const scale = Math.cos((lat * Math.PI) / 180);
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const dLat = row[1] / 1000 - lat;
        const dLon = (row[2] / 1000 - lon) * scale;
        const distance = dLat * dLat + dLon * dLon;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = row[0];
        }
    }
    return best == null ? "" : String(best).padStart(5, "0");
}

function zipRecord(rows, zip) {
    const wanted = padZip(zip);
    if (!wanted || !rows) return null;
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (String(row[0]).padStart(5, "0") === wanted) return row;
    }
    return null;
}

function haversineMiles(lon1, lat1, lon2, lat2) {
    const radius = 3958.7613;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dPhi = (lat2 - lat1) * Math.PI / 180;
    const dLam = (lon2 - lon1) * Math.PI / 180;
    const chord = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
    return 2 * radius * Math.asin(Math.min(1, Math.sqrt(chord)));
}

function zoneFromMiles(miles, cuts) {
    for (let index = 0; index < cuts.length; index += 1) {
        if (miles <= cuts[index]) return index + 2;
    }
    return cuts.length + 2;
}

function groundRate(ship, pounds, zone) {
    const weights = ship.weights_lb || [];
    const table = ship.rates || [];
    const column = zone - 2;
    if (!weights.length || !table.length || column < 0 || column >= table[0].length) return null;
    const prices = table.map((row) => row[column]);
    if (prices.some((price) => finite(price) == null)) return null;
    if (pounds <= weights[0]) return prices[0];
    const last = weights.length - 1;
    if (pounds >= weights[last]) {
        const span = weights[last] - weights[last - 1];
        const slope = span > 0 ? (prices[last] - prices[last - 1]) / span : 0;
        return prices[last] + slope * (pounds - weights[last]);
    }
    for (let index = 1; index < weights.length; index += 1) {
        if (pounds <= weights[index]) {
            const span = weights[index] - weights[index - 1];
            const share = span > 0 ? (pounds - weights[index - 1]) / span : 0;
            return prices[index - 1] + share * (prices[index] - prices[index - 1]);
        }
    }
    return null;
}

function modelInchesFromLngLat(lng, lat, fit) {
    let east;
    let north;
    if (fit.crs && fit.origin) {
        const projected = projectPoint(lng, lat, fit.crs);
        east = projected[0] - fit.origin[0];
        north = projected[1] - fit.origin[1];
    } else {
        const local = localMeters(lng, lat, fit.lng0, fit.lat0);
        east = local[0];
        north = local[1];
    }
    const angle = (fit.rotationDeg * Math.PI) / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const rotatedX = east * cosine - north * sine;
    const rotatedY = east * sine + north * cosine;
    return [(rotatedX - fit.cx) * fit.inchesPerMeter, (rotatedY - fit.cy) * fit.inchesPerMeter];
}

function squarePeaks(grid, fit) {
    const cols = grid.cols;
    const rows = grid.rows || grid.n;
    const signature = [
        grid.key,
        fit.cols,
        fit.rows,
        fit.rotationDeg,
        fit.metersPerInch,
        fit.cx,
        fit.cy,
        fit.crs ? fit.crs.label : "",
    ].join("|");
    if (grid._peaks && grid._peaks.signature === signature) return grid._peaks.peaks;
    const peaks = new Map();
    fit.squares.forEach((key) => peaks.set(key, null));
    const [west, south, east, north] = grid.box;
    for (let row = 0; row < rows; row += 1) {
        const lat = south + (row + 0.5) / rows * (north - south);
        for (let col = 0; col < cols; col += 1) {
            const elev = grid.values[row * cols + col];
            if (elev == null) continue;
            const lng = west + (col + 0.5) / cols * (east - west);
            const [mx, my] = modelInchesFromLngLat(lng, lat, fit);
            const squareCol = Math.floor((mx + fit.outerWidthIn / 2) / 24);
            const squareRow = Math.floor((my + fit.outerHeightIn / 2) / 24);
            if (squareCol < 0 || squareRow < 0 || squareCol >= fit.cols || squareRow >= fit.rows) continue;
            const key = squareKey(squareCol, squareRow);
            if (!peaks.has(key)) continue;
            const prior = peaks.get(key);
            if (prior == null || elev > prior) peaks.set(key, elev);
        }
    }
    grid._peaks = { signature, peaks };
    return peaks;
}

function stackInches(grid, fit, exaggeration) {
    if (!grid || !fit || !fit.squares || !fit.squares.size || !(fit.metersPerInch > 0)) return null;
    const peaks = squarePeaks(grid, fit);
    let total = 0;
    peaks.forEach((elev) => {
        const rise = elev == null ? 0 : Math.max(0, elev - grid.min) / fit.metersPerInch * (Number(exaggeration) || 0);
        total += 0.5 + rise;
    });
    return total;
}

function shippingEstimate(state, kg, heightIn) {
    const ship = state.rates && state.rates.ship;
    const rows = state.zips && state.zips.rows;
    if (!ship || !rows || !(kg > 0) || !(heightIn > 0)) return { amount: null };
    if (!isUnitedStates(state.country)) return { amount: null, reason: "country" };
    const zip = padZip(state.postal);
    const destination = zipRecord(rows, zip);
    if (!destination) return { amount: null, reason: "zip" };
    const originLat = finite(ship.origin_lat);
    const originLon = finite(ship.origin_lon);
    const weightFactor = finite(ship.packaging_weight);
    const divisor = finite(ship.dim_divisor);
    const box = finite(ship.box_in);
    if ([originLat, originLon, weightFactor, divisor, box].some((value) => value == null) || divisor <= 0) return { amount: null };
    const miles = haversineMiles(originLon, originLat, destination[2] / 1000, destination[1] / 1000);
    const zone = zoneFromMiles(miles, ship.zone_miles || []);
    const scaleLb = kg * (1 + weightFactor) * LB_PER_KG;
    const dimLb = (box * box * heightIn) / divisor;
    const billableLb = Math.max(1, Math.ceil(Math.max(scaleLb, dimLb) - 1e-9));
    const longest = Math.max(box, heightIn);
    const sides = [box, box, heightIn].sort((left, right) => right - left);
    const lengthGirth = sides[0] + 2 * (sides[1] + sides[2]);
    const limited = billableLb > (finite(ship.max_lb) || 150) || lengthGirth > (finite(ship.max_length_girth_in) || 165);
    const amount = groundRate(ship, billableLb, zone);
    if (amount == null) return { amount: null };
    return {
        amount,
        zip,
        originZip: ship.origin_zip || "",
        miles,
        zone,
        days: ZONE_DAYS[zone] || "1–5",
        scaleLb,
        dimLb,
        billableLb,
        heightIn,
        lengthGirth,
        longest,
        limited,
        extended: billableLb > 50 || limited,
    };
}

function kitUnitPrice(kit) {
    return (kit.materials || []).reduce((sum, item) => sum + (finite(item.price) || 0), 0);
}

function meanHeightIn(grid, fit, exaggeration) {
    if (!grid || !fit || !(fit.metersPerInch > 0) || !grid.values) return null;
    let sum = 0;
    let count = 0;
    grid.values.forEach((value) => {
        if (value == null) return;
        sum += value;
        count += 1;
    });
    if (!count) return null;
    const rise = Math.max(0, (sum / count) - grid.min) / fit.metersPerInch * (Number(exaggeration) || 0);
    return 0.5 + rise;
}

function printEstimate(state) {
    const spec = state.rates && state.rates.print;
    const material = spec && spec.materials ? spec.materials[state.material] : null;
    const grade = spec && spec.grades ? spec.grades[state.grade] : null;
    const squares = state.squares ? state.squares.size : 0;
    const height = meanHeightIn(
        state.elevGrid,
        state.fit,
        state.vertical ? state.vertical.applied : state.exaggeration,
    );
    if (!spec || !material || !grade || !squares || height == null) return { ready: false };
    const infill = finite(spec.infill);
    const density = finite(material.density_g_cm3);
    const price = finite(material.usd_per_kg);
    const flow = finite(grade.flow_mm3_s);
    const square = finite(spec.square_in);
    const life = finite(spec.printer_life_hours);
    const printer = finite(spec.printer_cost);
    const power = finite(spec.power_w);
    const energy = finite(spec.energy_per_kwh);
    const wage = finite(spec.wage_per_hour);
    const laborEach = finite(spec.labor_hours_per_tile);
    const failure = finite(spec.failure_rate);
    const packagingRate = finite(spec.packaging_cost);
    const safety = finite(spec.safety_factor);
    const profit = finite(spec.profit);
    const numbers = [infill, density, price, flow, square, life, printer, power, energy, wage, laborEach, failure, packagingRate, safety, profit];
    if (numbers.some((value) => value == null) || failure >= 1 || life <= 0 || flow <= 0) return { ready: false };
    const plasticCm3 = square * square * height * CUBIC_INCH_CM3 * infill;
    const kg = (plasticCm3 * density / 1000) * squares;
    const hours = ((plasticCm3 * 1000) / flow / 3600) * squares;
    const tileFactor = (square / 24) * (square / 24);
    const laborHours = squares * laborEach * tileFactor;
    const materialCost = kg * price;
    const machineCost = hours * (printer / life);
    const energyCost = hours * (power / 1000) * energy;
    const laborCost = laborHours * wage;
    const production = materialCost + machineCost + energyCost + laborCost;
    const withFailure = production / (1 - failure);
    let kitTotal = 0;
    const kitLines = (state.rates.kits || []).map((kit) => {
        const qty = Math.max(0, Math.floor(finite(state.kitQty && state.kitQty[kit.id]) || 0));
        const amount = qty * kitUnitPrice(kit);
        kitTotal += amount;
        return { id: kit.id, label: kit.label, qty, amount };
    });
    const applied = state.vertical ? state.vertical.applied : state.exaggeration;
    const boxHeight = stackInches(state.elevGrid, state.fit, applied) || height * squares;
    const goods = withFailure + kitTotal;
    const packagingAmount = goods * packagingRate;
    const before = goods + packagingAmount;
    const safetyAmount = before * safety;
    const profitAmount = (before + safetyAmount) * profit;
    const ship = shippingEstimate(state, kg, boxHeight);
    const markedUp = before + safetyAmount + profitAmount;
    return {
        ready: true,
        material,
        grade,
        squares,
        heightIn: height,
        boxHeightIn: boxHeight,
        kg,
        hours,
        laborHours,
        materialCost,
        machineCost,
        energyCost,
        laborCost,
        reprint: withFailure - production,
        kitLines,
        packagingAmount,
        safetyAmount,
        profitAmount,
        ship,
        total: ship && ship.amount != null ? markedUp + ship.amount : null,
        activeDays: finite(spec.active_print_days),
    };
}

function quoteLines(state) {
    const estimate = printEstimate(state);
    if (!estimate.ready) {
        return [
            { label: "Print Estimate", amount: null },
            { label: "Accessory Kits", amount: 0 },
            { label: "Shipping", amount: null },
        ];
    }
    const lines = [
        { label: `Material, ${estimate.material.label}, ${estimate.kg.toFixed(2)} kg`, amount: estimate.materialCost },
        { label: `Printer, ${estimate.squares} ${estimate.squares === 1 ? "square" : "squares"}, ${estimate.hours.toFixed(1)} h`, amount: estimate.machineCost },
        { label: "Energy", amount: estimate.energyCost },
        { label: `Labor, ${estimate.laborHours.toFixed(1)} h`, amount: estimate.laborCost },
        { label: "Reprint Allowance, 10%", amount: estimate.reprint },
    ];
    estimate.kitLines.forEach((kit) => {
        lines.push({ label: `${kit.label} × ${kit.qty}`, amount: kit.amount });
    });
    lines.push({ label: "Packaging, 10%", amount: estimate.packagingAmount });
    lines.push({ label: "Safety Factor, 10%", amount: estimate.safetyAmount });
    lines.push({ label: "Profit, 50%", amount: estimate.profitAmount });
    const ship = estimate.ship;
    if (!ship || ship.amount == null) lines.push({ label: "Shipping", amount: null });
    else {
        const extra = ship.extended ? ", extended" : "";
        lines.push({
            label: `Shipping, ${ship.zip}, Zone ${ship.zone}, ${ship.billableLb} lb${extra}`,
            amount: ship.amount,
        });
    }
    return lines;
}

function shipmentGrams(state) {
    const color = (state.rates.colors && state.rates.colors[state.color]) || {};
    const perSquare = finite(color.grams_per_square);
    if (perSquare == null) return null;
    let grams = state.squares.size * perSquare + (finite(state.rates.packaging_grams) || 0);
    const kits = state.rates.kits || [];
    for (let index = 0; index < kits.length; index += 1) {
        const kit = kits[index];
        const qty = Math.max(0, Math.floor(finite(state.kitQty && state.kitQty[kit.id]) || 0));
        if (!qty) continue;
        const kitGrams = (kit.materials || []).reduce((sum, item) => sum + (finite(item.grams) || 0), 0);
        if (!kitGrams) return null;
        grams += qty * kitGrams;
    }
    return grams;
}

function shippingRow(state) {
    const country = state.country.trim().toLowerCase();
    return (state.rates.shipping || []).find((row) => String(row.country || "").trim().toLowerCase() === country) || null;
}

function shippingCost(state, grams) {
    const row = shippingRow(state);
    if (!row || grams == null) return null;
    const perKg = finite(row.per_kg);
    const minimum = finite(row.minimum);
    const weightCost = perKg == null ? null : perKg * (grams / 1000);
    if (weightCost == null) return minimum;
    if (minimum == null) return weightCost;
    return Math.max(minimum, weightCost);
}

function deliveryDays(state) {
    const estimate = printEstimate(state);
    const assembly = state.rates ? finite(state.rates.assembly_days) : null;
    const row = shippingRow(state);
    return {
        printDays: estimate.ready ? Math.ceil(estimate.hours / 24) : null,
        printHours: estimate.ready ? estimate.hours : null,
        activeDays: estimate.ready ? estimate.activeDays : null,
        assemblyDays: assembly,
        transitMin: row ? finite(row.transit_days_min) : null,
        transitMax: row ? finite(row.transit_days_max) : null,
    };
}

function reliefColor(elev, stops) {
    if (!stops || !stops.length) return [214, 226, 232];
    if (elev <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i += 1) {
        const [high, color] = stops[i];
        const [low, prev] = stops[i - 1];
        if (elev <= high) {
            const span = high - low;
            const t = span === 0 ? 0 : (elev - low) / span;
            return prev.map((channel, index) => Math.round(channel + (color[index] - channel) * t));
        }
    }
    return stops[stops.length - 1][1];
}

function roundDownTenth(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.floor((value + 1e-9) * 10) / 10;
}

function maxExaggeration(reliefM, metersPerInch) {
    if (!(reliefM > 0) || !(metersPerInch > 0)) return 100;
    return Math.min(100, roundDownTenth((17.5 * metersPerInch) / reliefM));
}

function appliedExaggeration(requested, reliefM, metersPerInch) {
    const asked = Math.min(100, Math.max(0, Number(requested) || 0));
    return Math.min(asked, maxExaggeration(reliefM, metersPerInch));
}

function terrainHeight(elev, elevMin, metersPerInch, exaggeration) {
    const rise = metersPerInch > 0 ? (Math.max(0, elev - elevMin) / metersPerInch) * exaggeration : 0;
    return { baseIn: 0.5, totalIn: 0.5 + rise };
}

function orderPayload(state) {
    const lines = quoteLines(state);
    const missing = lines.filter((line) => line.amount == null).map((line) => line.label);
    const total = missing.length ? null : lines.reduce((sum, line) => sum + line.amount, 0);
    return {
        product: "watershed-flow-model",
        watershed: state.feature ? {
            id: (state.feature.properties && state.feature.properties.id) || null,
            name: featureName(state.feature, 0),
        } : null,
        method: state.method,
        pour_point: state.pourPoint,
        square_count: state.squares.size,
        alignment: state.alignment || "north",
        rotation_deg: state.fit ? state.fit.rotationDeg : 0,
        cols: state.fit ? state.fit.cols : null,
        rows: state.fit ? state.fit.rows : null,
        border_in: state.fit ? state.fit.borderIn : 0,
        meters_per_inch: state.fit ? state.fit.metersPerInch : null,
        scale_m: state.fit ? state.fit.metersPerInch * 24 : state.scale,
        squares: [...state.squares].map(parseSquare),
        color: state.color,
        print_material: state.material || null,
        print_grade: state.grade || null,
        kits: (state.rates && state.rates.kits || []).map((kit) => ({
            id: kit.id,
            label: kit.label,
            qty: Math.max(0, Math.floor(finite(state.kitQty && state.kitQty[kit.id]) || 0)),
            unit_price: kitUnitPrice(kit),
        })),
        destination: {
            country: state.country,
            region: state.region,
            postal_code: state.postal,
            city: state.city,
            street: state.street,
            name: state.recipient,
        },
        lines,
        total,
        missing,
        delivery: deliveryDays(state),
        vertical: state.vertical || null,
        print: state.printCrs ? {
            crs: state.printCrs.label,
            resolution_m: state.elevGrid && sameCrs(state.printCrs, state.elevGrid.crs) && state.elevGrid.resolution_m != null
                ? state.elevGrid.resolution_m
                : null,
        } : null,
        dem_ramp: (() => {
            const chosen = state.rampBook && (state.rampBook.ramps.find((ramp) => ramp.id === state.ramp) || state.rampBook.ramps[0]);
            return chosen ? { id: chosen.id, label: chosen.label } : null;
        })(),
        quote_complete: missing.length === 0 && Boolean(state.feature) && state.squares.size > 0,
    };
}

function decodeElevationValues(payload) {
    const binary = atob(payload.values);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const view = new DataView(bytes.buffer);
    const count = payload.rows * payload.cols;
    const values = new Array(count);
    for (let index = 0; index < count; index += 1) {
        const sample = view.getInt16(index * 2, true);
        values[index] = sample === payload.nodata ? null : sample;
    }
    return values;
}

async function sampleElevations(feature, signal) {
    const id = feature.properties && feature.properties.id;
    if (!id) throw new Error("no id");
    const response = await fetch(assetPath(`data/elevation/${id}.json`), { signal });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    let streams = null;
    if (data.streams) {
        const streamResponse = await fetch(assetPath(data.streams), { signal });
        if (streamResponse.ok) streams = await streamResponse.json();
    }
    return {
        n: data.cols,
        rows: data.rows,
        cols: data.cols,
        values: decodeElevationValues(data),
        box: data.box,
        min: data.min,
        max: data.max,
        key: id,
        crs: data.crs,
        crs_label: data.crs_label,
        resolution_m: data.resolution_m,
        outline_m: data.outline_m,
        attribution: data.attribution,
        streams,
    };
}

function paintRelief(grid, exaggeration, stops, rampId) {
    const rows = grid.rows || grid.n;
    const cols = grid.cols || grid.n;
    const scale = Math.max(1, Math.min(8, Math.floor(1024 / Math.max(rows, cols))));
    const canvas = document.createElement("canvas");
    canvas.width = cols * scale;
    canvas.height = rows * scale;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(cols, rows);
    const midLat = (((grid.box[1] + grid.box[3]) / 2) * Math.PI) / 180;
    const cellX = Math.max(1, ((grid.box[2] - grid.box[0]) * 111320 * Math.cos(midLat)) / cols);
    const cellY = Math.max(1, ((grid.box[3] - grid.box[1]) * 110540) / rows);
    const at = (row, col) => {
        if (row < 0 || col < 0 || row >= rows || col >= cols) return null;
        return grid.values[row * cols + col];
    };
    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
            const elev = at(row, col);
            const pixel = ((rows - 1 - row) * cols + col) * 4;
            if (elev == null) {
                image.data[pixel + 3] = 0;
                continue;
            }
            const east = at(row, col + 1);
            const north = at(row + 1, col);
            const dzdx = ((east == null ? elev : east) - elev) / cellX;
            const dzdy = ((north == null ? elev : north) - elev) / cellY;
            const light = 0.78 + Math.max(-0.28, Math.min(0.28, (dzdy - dzdx) * exaggeration * 2));
            const color = reliefColor(elev, stops).map((channel) => Math.max(0, Math.min(255, Math.round(channel * light))));
            image.data[pixel] = color[0];
            image.data[pixel + 1] = color[1];
            image.data[pixel + 2] = color[2];
            image.data[pixel + 3] = 255;
        }
    }
    const sample = document.createElement("canvas");
    sample.width = cols;
    sample.height = rows;
    sample.getContext("2d").putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sample, 0, 0, canvas.width, canvas.height);
    const [west, south, east, north] = grid.box;
    return {
        url: canvas.toDataURL("image/png"),
        coordinates: [[west, north], [east, north], [east, south], [west, south]],
        exaggeration,
        ramp: rampId,
    };
}

function bootFolds() {
    document.querySelectorAll(".fold").forEach((fold) => {
        const button = fold.querySelector("h2 button");
        if (!button) return;
        const setOpen = (open) => {
            fold.classList.toggle("is-open", open);
            button.setAttribute("aria-expanded", open ? "true" : "false");
            const mark = button.querySelector(".fold-mark");
            if (mark) mark.textContent = open ? "−" : "+";
        };
        setOpen(fold.classList.contains("is-open"));
        button.addEventListener("click", () => setOpen(!fold.classList.contains("is-open")));
    });
}

if (typeof document !== "undefined" && document.getElementById("map")) {
    bootWatershedPage();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootFolds);
    else bootFolds();
}

function bootWatershedPage() {
    const state = {
        rates: null,
        boundaries: [],
        feature: null,
        method: "catalog",
        pourPoint: null,
        squareCount: 4,
        alignment: "north",
        fit: null,
        squares: new Set(),
        scale: null,
        color: "dem",
        ramp: "cd-a",
        rampBook: null,
        projection: "utm",
        utmZoneManual: false,
        printCrs: null,
        exaggeration: 1,
        elevGrid: null,
        reliefImage: null,
        elevLoading: null,
        elevAbort: null,
        material: "pla-bulk",
        grade: "standard",
        kitQty: {},
        zips: null,
        country: "US",
        region: "",
        postal: "",
        city: "",
        street: "",
        recipient: "",
    };

    let map = null;
    let marker = null;
    try {
        map = new maplibregl.Map({
            container: "map",
            style: mapStyle("white", "cd-a"),
            center: [-93.63, 42.03],
            zoom: 4,
        });
    } catch (error) {
        map = null;
        document.getElementById("map-note").textContent = "The map did not start. Basin search, squares, and the quote still work.";
        console.error(error);
    }
    if (map) {
        try {
            map.addControl(new maplibregl.NavigationControl(), "top-right");
        } catch (error) {
            console.error(error);
        }
        map.on("click", onMapClick);
    }

    loadMenu().catch((error) => console.error(error));
    Promise.all([
        loadJSON("../data/watershed-model.json"),
        loadJSON(assetPath("data/ramps.json")),
        loadJSON(assetPath("data/zip-centroids.json")).catch(() => null),
    ]).then(async ([rates, rampBook, zips]) => {
        state.rates = rates;
        state.zips = zips;
        state.rampBook = rampBook;
        state.ramp = rampBook.default || "cd-a";
        document.getElementById("intro").textContent = rates.intro;
        document.getElementById("kit-note").textContent = rates.kits_intro || "";
        buildColorButtons();
        buildRampSelect();
        buildPrintControls();
        buildKitControls();
        const response = await fetch(assetPath(rates.boundaries_url));
        const collection = response.ok ? await response.json() : { features: [] };
        state.boundaries = (collection.features || []).filter((feature) => feature.geometry
            && (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon"));
        renderResults("");
        const first = state.boundaries.find((feature) => feature.properties && feature.properties.example) || state.boundaries[0];
        if (first) adoptFeature(first);
        else render();
    }).catch((error) => {
        document.getElementById("map-note").textContent = "The model rates did not load.";
        console.error(error);
    });

    document.getElementById("mode-catalog").addEventListener("click", () => setMode("catalog"));
    document.getElementById("mode-point").addEventListener("click", () => setMode("point"));
    document.getElementById("basin-search").addEventListener("input", (event) => renderResults(event.target.value));
    document.getElementById("square-count").addEventListener("input", (event) => {
        const next = Math.floor(finite(event.target.value) || 1);
        state.squareCount = Math.max(1, Math.min(state.rates ? state.rates.max_squares || 100 : 100, next));
        render();
    });
    document.getElementById("align-north").addEventListener("click", () => setAlignment("north"));
    document.getElementById("align-max").addEventListener("click", () => setAlignment("max"));
    document.getElementById("proj-utm").addEventListener("click", () => {
        state.projection = "utm";
        render();
    });
    document.getElementById("proj-albers").addEventListener("click", () => {
        state.projection = "albers";
        render();
    });
    document.getElementById("proj-albers-na").addEventListener("click", () => {
        state.projection = "albers-na";
        render();
    });
    document.getElementById("utm-zone").addEventListener("input", (event) => {
        const zone = Number(event.target.value);
        if (!Number.isFinite(zone)) return;
        state.utmZoneManual = true;
        state.projection = "utm";
        render();
    });
    document.getElementById("dem-ramp").addEventListener("change", (event) => {
        state.ramp = event.target.value;
        state.reliefImage = null;
        render();
    });
    document.getElementById("exaggeration").addEventListener("input", (event) => {
        const next = Number(event.target.value);
        state.exaggeration = Number.isFinite(next) ? Math.min(100, Math.max(0, next)) : 0;
        state.reliefImage = null;
        render();
    });
    ["country", "region", "postal", "city", "street", "recipient"].forEach((id) => {
        document.getElementById(id).addEventListener("input", (event) => {
            state[id === "recipient" ? "recipient" : id] = event.target.value;
            render();
        });
    });
    document.getElementById("model-form").addEventListener("submit", (event) => event.preventDefault());
    document.getElementById("save-quote").addEventListener("click", saveQuote);

    function moneyText(amount) {
        return Number(amount).toLocaleString("en-US", { style: "currency", currency: "USD" });
    }

    function buildPrintControls() {
        const spec = (state.rates && state.rates.print) || {};
        const materialSelect = document.getElementById("print-material");
        const gradeSelect = document.getElementById("print-grade");
        const materials = spec.materials || {};
        const grades = spec.grades || {};
        materialSelect.innerHTML = Object.entries(materials).map(([id, item]) => (
            `<option value="${escapeHtml(id)}">${escapeHtml(item.label)} · ${moneyText(item.usd_per_kg)}/kg</option>`
        )).join("");
        gradeSelect.innerHTML = Object.entries(grades).map(([id, item]) => (
            `<option value="${escapeHtml(id)}">${escapeHtml(item.label)} · ${Number(item.layer_mm).toFixed(2)} mm</option>`
        )).join("");
        state.material = materials["pla-bulk"] ? "pla-bulk" : (Object.keys(materials)[0] || "");
        state.grade = grades.standard ? "standard" : (Object.keys(grades)[0] || "");
        materialSelect.value = state.material;
        gradeSelect.value = state.grade;
        materialSelect.addEventListener("change", (event) => {
            state.material = event.target.value;
            render();
        });
        gradeSelect.addEventListener("change", (event) => {
            state.grade = event.target.value;
            render();
        });
    }

    function buildKitControls() {
        const host = document.getElementById("kit-choices");
        const kits = (state.rates && state.rates.kits) || [];
        host.innerHTML = kits.map((kit) => {
            const lines = (kit.materials || []).map((item) => (
                `<li>${escapeHtml(item.name)} · ${moneyText(item.price)}</li>`
            )).join("");
            const options = Array.from({ length: 21 }, (_, count) => `<option value="${count}">${count}</option>`).join("");
            return `<div class="kit-block">
                <h3>${escapeHtml(kit.label)}</h3>
                <ul class="kit-lines">${lines}</ul>
                <p class="kit-price">${moneyText(kitUnitPrice(kit))} each</p>
                <label for="kit-${escapeHtml(kit.id)}">Quantity</label>
                <select id="kit-${escapeHtml(kit.id)}" data-kit="${escapeHtml(kit.id)}">${options}</select>
            </div>`;
        }).join("");
        host.querySelectorAll("select[data-kit]").forEach((select) => {
            state.kitQty[select.dataset.kit] = 0;
            select.addEventListener("change", () => {
                state.kitQty[select.dataset.kit] = Math.max(0, Math.floor(finite(select.value) || 0));
                render();
            });
        });
    }

    function renderPrintNote(estimate) {
        const note = document.getElementById("print-note");
        const spec = state.rates && state.rates.print;
        const basis = (spec && spec.basis) || "";
        if (!estimate.ready) {
            note.textContent = basis
                ? `The print estimate appears after the elevation loads. ${basis}`
                : "The print estimate appears after the elevation loads.";
            return;
        }
        const perKg = moneyText(estimate.material.usd_per_kg);
        const each = estimate.squares ? estimate.kg / estimate.squares : estimate.kg;
        const machineRate = spec.printer_life_hours > 0 ? spec.printer_cost / spec.printer_life_hours : null;
        const rateText = machineRate == null ? "" : ` The machine rate is ${moneyText(machineRate)} per hour.`;
        note.textContent = `${estimate.material.label} is ${perKg}/kg. ${estimate.squares} squares use ${estimate.kg.toFixed(2)} kg at 15% infill (${each.toFixed(2)} kg each) at a mean height of ${estimate.heightIn.toFixed(2)} in. Print time is about ${estimate.hours.toFixed(1)} h. The stacked box is 24 by 24 by ${estimate.boxHeightIn.toFixed(1)} in. ${basis}${rateText} The 180 print days are the shop year and do not change that hourly rate. Height changes material and print time. Labor stays one hour per 24 in square.`;
    }

    function setMode(mode) {
        state.method = mode;
        document.getElementById("mode-catalog").setAttribute("aria-pressed", mode === "catalog" ? "true" : "false");
        document.getElementById("mode-point").setAttribute("aria-pressed", mode === "point" ? "true" : "false");
        document.getElementById("catalog-tools").hidden = mode !== "catalog";
        document.getElementById("point-note").hidden = mode !== "point";
        render();
    }

    function onMapClick(event) {
        if (state.method !== "point" || !state.rates) return;
        state.pourPoint = [event.lngLat.lng, event.lngLat.lat];
        if (!state.rates.delineate_url) {
            state.feature = null;
            render();
            return;
        }
        fetch(state.rates.delineate_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lng: state.pourPoint[0], lat: state.pourPoint[1] }),
        }).then((response) => {
            if (!response.ok) throw new Error(String(response.status));
            return response.json();
        }).then((body) => {
            const feature = body.type === "Feature" ? body : (body.features && body.features[0]);
            if (!feature || !feature.geometry) throw new Error("no polygon");
            adoptFeature(feature);
        }).catch(() => {
            state.feature = null;
            document.getElementById("point-note").textContent = "The delineation service did not return a boundary.";
            render();
        });
    }

    function setAlignment(alignment) {
        state.alignment = alignment;
        document.getElementById("align-north").setAttribute("aria-pressed", alignment === "north" ? "true" : "false");
        document.getElementById("align-max").setAttribute("aria-pressed", alignment === "max" ? "true" : "false");
        render();
    }

    function adoptFeature(feature) {
        state.feature = feature;
        if (state.color === "topo" && !centroidInUS(feature)) state.color = "dem";
        const rows = state.zips && state.zips.rows;
        const zip = rows ? nearestZip(rows, featureCenter(feature)[0], featureCenter(feature)[1]) : "";
        if (zip) {
            state.postal = zip;
            document.getElementById("postal").value = zip;
        }
        render();
    }

    function renderResults(query) {
        const list = document.getElementById("basin-results");
        const text = query.trim().toLowerCase();
        const matches = state.boundaries.filter((feature, index) => featureName(feature, index).toLowerCase().includes(text)).slice(0, 20);
        if (!state.boundaries.length) {
            list.innerHTML = "<li class='field-note'>The boundary dataset is empty. Add basins to the club GeoJSON file.</li>";
            return;
        }
        list.innerHTML = matches.map((feature, index) => {
            const name = featureName(feature, index);
            return `<li><button type="button" data-index="${state.boundaries.indexOf(feature)}">${escapeHtml(name)}</button></li>`;
        }).join("") || "<li class='field-note'>No basin matches that name.</li>";
        list.querySelectorAll("button").forEach((button) => {
            button.addEventListener("click", () => {
                state.method = "catalog";
                adoptFeature(state.boundaries[Number(button.dataset.index)]);
            });
        });
    }

    function autoZone() {
        const id = state.feature && state.feature.properties && state.feature.properties.id;
        const grid = state.elevGrid;
        if (grid && grid.key === id && grid.crs && grid.crs.kind === "utm") return grid.crs.zone;
        if (!state.feature) return 15;
        return utmZoneFromLon(featureCenter(state.feature)[0]);
    }

    function chosenCrs() {
        if (!state.feature) return null;
        const bounds = featureBbox(state.feature);
        if (state.projection === "albers") return crsAlbersBasin(bounds);
        if (state.projection === "albers-na") return crsAlbersNA();
        const zone = state.utmZoneManual ? Number(document.getElementById("utm-zone").value) : autoZone();
        let south = (bounds[1] + bounds[3]) / 2 < 0;
        const id = state.feature.properties && state.feature.properties.id;
        const grid = state.elevGrid;
        if (!state.utmZoneManual && grid && grid.key === id && grid.crs && grid.crs.kind === "utm" && grid.crs.zone === zone) {
            south = !!grid.crs.south;
        }
        return crsUtm(zone, south);
    }

    function applyFit() {
        if (!state.feature) {
            state.fit = null;
            state.squares = new Set();
            state.scale = null;
            state.printCrs = null;
            return;
        }
        const crs = chosenCrs();
        state.printCrs = crs;
        const id = state.feature.properties && state.feature.properties.id;
        const grid = state.elevGrid;
        const baked = crs && grid && grid.key === id && grid.outline_m && grid.crs && sameCrs(grid.crs, crs);
        const outline = baked ? grid.outline_m : projectOutline(state.feature.geometry, crs);
        state.fit = fitSquares(
            state.feature,
            state.squareCount,
            state.alignment,
            outline,
            crs,
        );
        state.squares = state.fit.squares;
        state.scale = state.fit.metersPerInch * 24;
    }

    function renderProjection() {
        document.getElementById("proj-utm").setAttribute("aria-pressed", state.projection === "utm" ? "true" : "false");
        document.getElementById("proj-albers").setAttribute("aria-pressed", state.projection === "albers" ? "true" : "false");
        document.getElementById("proj-albers-na").setAttribute("aria-pressed", state.projection === "albers-na" ? "true" : "false");
        document.getElementById("utm-zone-tools").hidden = state.projection !== "utm";
        const crs = state.printCrs;
        if (state.projection === "utm" && !state.utmZoneManual && crs && crs.zone) {
            document.getElementById("utm-zone").value = String(crs.zone);
        }
        const note = document.getElementById("projection-readout");
        if (!crs) {
            note.textContent = "Choose a basin to set the print projection.";
            return;
        }
        const grid = state.elevGrid;
        const matched = grid && grid.crs && sameCrs(crs, grid.crs);
        if (matched && grid.resolution_m) {
            note.textContent = `Print projection: ${crs.label}, ${grid.resolution_m} m.`;
            return;
        }
        const sample = grid && grid.resolution_m ? ` Elevation sample: ${grid.resolution_m} m.` : "";
        note.textContent = `Print projection: ${crs.label}.${sample} The squares refit in this projection.`;
    }

    function renderLayout() {
        const painter = document.getElementById("painter");
        if (!state.fit) {
            painter.innerHTML = "";
            return;
        }
        const { cols, rows } = state.fit;
        painter.style.gridTemplateColumns = `repeat(${cols}, 28px)`;
        const cells = [];
        for (let row = rows - 1; row >= 0; row -= 1) {
            for (let col = 0; col < cols; col += 1) cells.push("<span></span>");
        }
        painter.innerHTML = cells.join("");
    }

    function activeRamp() {
        const book = state.rampBook;
        if (!book || !book.ramps || !book.ramps.length) return null;
        return book.ramps.find((ramp) => ramp.id === state.ramp) || book.ramps[0];
    }

    function buildRampSelect() {
        const select = document.getElementById("dem-ramp");
        const book = state.rampBook;
        select.innerHTML = (book && book.ramps ? book.ramps : []).map((ramp) => (
            `<option value="${escapeHtml(ramp.id)}">${escapeHtml(ramp.label)}</option>`
        )).join("");
        select.value = state.ramp;
    }

    function buildColorButtons() {
        const box = document.getElementById("color-choices");
        box.innerHTML = WATERSHED_COLORS.map((color) => {
            const label = state.rates.colors[color] ? state.rates.colors[color].label : color;
            return `<button type="button" data-color="${color}">${escapeHtml(label)}</button>`;
        }).join("");
        box.querySelectorAll("button").forEach((button) => {
            button.addEventListener("click", () => {
                if (button.disabled) return;
                state.color = button.dataset.color;
                render();
            });
        });
    }

    function render() {
        if (!state.rates) return;
        const id = state.feature && state.feature.properties && state.feature.properties.id;
        if (state.elevGrid && state.elevGrid.key !== id) {
            state.elevGrid = null;
            state.reliefImage = null;
        }
        applyFit();
        const topoOk = !state.feature || centroidInUS(state.feature);
        document.querySelectorAll("#color-choices button").forEach((button) => {
            const blocked = button.dataset.color === "topo" && state.feature && !topoOk;
            button.disabled = blocked;
            button.setAttribute("aria-pressed", button.dataset.color === state.color ? "true" : "false");
        });
        document.getElementById("color-note").textContent = state.feature && !topoOk
            ? "USGS Topo is available when the basin is in the United States."
            : "Solid White, DEM, and Satellite can be used for any basin. USGS Topo is a United States surface.";
        const rampSelect = document.getElementById("dem-ramp");
        const rampOn = state.color === "white" || state.color === "dem";
        rampSelect.disabled = !rampOn;
        if (rampSelect.value !== state.ramp) rampSelect.value = state.ramp;
        const ramp = activeRamp();
        const rampNote = document.getElementById("ramp-note");
        if (!rampOn) {
            rampNote.textContent = "The color ramp colors the DEM overview and the basin. Satellite and USGS Topo replace that overview.";
        } else if (ramp && state.rampBook) {
            rampNote.textContent = `${ramp.label} uses the same stops on the overview and the basin, from ${state.rampBook.z_min.toLocaleString("en-US")} to ${state.rampBook.z_max.toLocaleString("en-US")} m. ${state.rampBook.attribution}`;
        }
        document.getElementById("point-note").textContent = state.rates.delineate_url
            ? "Click the map at the outlet. The delineation service returns the upstream boundary."
            : "Click the map to save a pour point. The boundary appears after a delineation service is connected. Until then, use the boundary dataset.";
        const fit = state.fit;
        if (!fit) {
            document.getElementById("size-readout").textContent = "Choose a basin to size the squares.";
        } else {
            const ground = fit.metersPerInch >= 1000
                ? `${(fit.metersPerInch / 1000).toFixed(2)} km`
                : `${Math.round(fit.metersPerInch).toLocaleString("en-US")} m`;
            const border = fit.borderIn
                ? "A 1/2 inch border is left around the outside so the squares can lock."
                : "This single square uses the full 24 by 24 inches.";
            const facing = state.alignment === "north"
                ? "The top of the model is true north."
                : `The model is turned ${fit.rotationDeg}° so the basin prints as large as it can.`;
            document.getElementById("size-readout").textContent = `${fit.cols} × ${fit.rows} squares. The model is ${fit.outerWidthIn} in × ${fit.outerHeightIn} in. 1 inch represents ${ground} of ground. ${border} ${facing}`;
        }
        renderLayout();
        renderProjection();
        renderVertical();
        renderQuote();
        ensureElevation();
        drawMap();
    }

    function renderVertical() {
        const note = document.getElementById("vert-readout");
        const fit = state.fit;
        const grid = state.elevGrid;
        if (!fit || !grid) {
            state.vertical = null;
            note.textContent = grid ? "Choose a basin to scale the height." : "Elevation for this basin is loading.";
            return;
        }
        const reliefM = Math.max(0, grid.max - grid.min);
        const limit = maxExaggeration(reliefM, fit.metersPerInch);
        const applied = appliedExaggeration(state.exaggeration, reliefM, fit.metersPerInch);
        const peak = terrainHeight(grid.max, grid.min, fit.metersPerInch, applied);
        state.vertical = {
            requested: state.exaggeration,
            applied,
            limit,
            elev_min_m: grid.min,
            elev_max_m: grid.max,
            base_in: 0.5,
            max_height_in: peak.totalIn,
        };
        const limited = applied + 0.001 < state.exaggeration
            ? ` The requested ${state.exaggeration} is above the cap, so ${applied.toFixed(1)} is used.`
            : "";
        const print = state.printCrs
            ? ` Print grid: ${state.printCrs.label}${grid.resolution_m && sameCrs(state.printCrs, grid.crs) ? `, ${grid.resolution_m} m` : ""}.`
            : "";
        note.textContent = `Elevation spans ${Math.round(grid.min).toLocaleString("en-US")}–${Math.round(grid.max).toLocaleString("en-US")} m. Applied exaggeration is ${applied.toFixed(1)} (maximum ${limit.toFixed(1)}). The base is 0.5 in and the highest point is ${peak.totalIn.toFixed(2)} in.${limited}${print}`;
    }

    function ensureElevation() {
        if (!state.feature) return;
        const id = state.feature.properties && state.feature.properties.id;
        const note = document.getElementById("vert-readout");
        if (!id) {
            state.elevGrid = null;
            state.reliefImage = null;
            if (note) note.textContent = "Elevation for this basin has not been baked.";
            return;
        }
        const ramp = activeRamp();
        if (state.elevGrid && state.elevGrid.key === id) {
            const applied = state.vertical ? state.vertical.applied : state.exaggeration;
            const stale = !ramp
                || !state.reliefImage
                || state.reliefImage.ramp !== ramp.id
                || state.reliefImage.exaggeration !== applied;
            if (!ramp) state.reliefImage = null;
            else if (stale) state.reliefImage = paintRelief(state.elevGrid, applied, ramp.stops, ramp.id);
            return;
        }
        if (state.elevLoading === id) return;
        if (state.elevAbort) state.elevAbort.abort();
        const controller = new AbortController();
        state.elevAbort = controller;
        state.elevLoading = id;
        sampleElevations(state.feature, controller.signal).then((grid) => {
            if (controller.signal.aborted) return;
            if (!state.feature || !(state.feature.properties && state.feature.properties.id === id)) return;
            state.elevGrid = grid;
            state.elevLoading = null;
            state.reliefImage = null;
            render();
        }).catch((error) => {
            if (error && error.name === "AbortError") return;
            if (state.elevAbort !== controller) return;
            state.elevLoading = null;
            state.elevGrid = null;
            state.reliefImage = null;
            if (note) note.textContent = "Elevation for this basin has not been baked.";
        });
    }

    function renderQuote() {
        const form = readForm();
        const estimate = printEstimate(form);
        renderPrintNote(estimate);
        const payload = orderPayload(form);
        const money = (amount) => amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
        const rows = payload.lines.map((line) => `<div><span>${escapeHtml(line.label)}</span><span class="${line.amount == null ? "missing" : ""}">${line.amount == null ? "Rate not set" : money(line.amount)}</span></div>`).join("");
        const total = payload.total == null
            ? `<div class="total"><span>Total</span><span class="missing">Needs ${escapeHtml(payload.missing.join(", "))}</span></div>`
            : `<div class="total"><span>Total</span><span>${money(payload.total)}</span></div>`;
        document.getElementById("quote").innerHTML = rows + total;
        const days = payload.delivery;
        const parts = [];
        if (days.printHours == null) parts.push("Print time appears after the elevation loads.");
        else {
            const dayWord = days.printDays === 1 ? "day" : "days";
            const shop = days.activeDays == null ? "" : ` The shop schedules ${days.activeDays} print days a year.`;
            parts.push(`Print time about ${days.printHours.toFixed(1)} h, about ${days.printDays} ${dayWord} if one printer runs 24 hours.${shop}`);
        }
        parts.push(days.assemblyDays == null ? "Assembly time is not set." : `Assembly is ${days.assemblyDays} day${days.assemblyDays === 1 ? "" : "s"}.`);
        const ship = estimate.ship;
        if (!estimate.ready || !ship || ship.amount == null) parts.push("Shipping needs a US ZIP Code from the census table.");
        else {
            const limit = ship.limited
                ? " This box is past the 150 lb or 165 in parcel limit, so the rate extends the published 30 to 50 lb slope."
                : "";
            const extended = ship.extended && !ship.limited ? " The rate above 50 lb extends the published 30 to 50 lb slope." : "";
            parts.push(`Ships from Ames ${ship.originZip} to ${ship.zip}, about ${Math.round(ship.miles)} miles, Zone ${ship.zone}. The box is 24 by 24 by ${ship.heightIn.toFixed(1)} in. Scale weight is ${ship.scaleLb.toFixed(1)} lb after 30% packaging. Dimensional weight is ${ship.dimLb.toFixed(1)} lb, so the billable weight is ${ship.billableLb} lb.${limit}${extended} UPS Ground is about ${ship.days} business days. This is the published daily base rate, without a residential surcharge.`);
        }
        document.getElementById("eta").textContent = parts.join(" ");
        if (map) document.getElementById("map-note").textContent = mapCaption();
    }

    function mapCaption() {
        if (!state.feature) return "Choose a basin, or save a pour point.";
        const exampleOnly = state.boundaries.length === 1 && state.boundaries[0].properties && state.boundaries[0].properties.example;
        const name = featureName(state.feature, 0);
        let text = `${name}${exampleOnly ? " is an example, standing in until the club boundary dataset is loaded" : ""}. The red line is the basin. The black squares are the model. The surface inside them is a preview, not the print file.`;
        const id = state.feature.properties && state.feature.properties.id;
        const grid = state.elevGrid;
        if (grid && grid.key === id) {
            if (grid.attribution) text += ` ${grid.attribution}.`;
            if (state.printCrs) {
                const resolution = grid.resolution_m && sameCrs(state.printCrs, grid.crs) ? `, ${grid.resolution_m} m` : "";
                text += ` Print grid: ${state.printCrs.label}${resolution}.`;
            }
        }
        if (state.color === "white" || state.color === "dem") {
            const ramp = activeRamp();
            const rampName = ramp ? ` Colored with ${ramp.label}.` : "";
            text += ` The base map is a Copernicus DEM overview at about 5 km, for finding the basin.${rampName}`;
        }
        return text;
    }

    function readForm() {
        return {
            rates: state.rates,
            feature: state.method === "catalog" || state.feature ? state.feature : null,
            method: state.method,
            pourPoint: state.pourPoint,
            squares: state.squares,
            scale: state.scale,
            fit: state.fit,
            alignment: state.alignment,
            color: state.color,
            ramp: state.ramp,
            rampBook: state.rampBook,
            exaggeration: state.exaggeration,
            vertical: state.vertical,
            elevGrid: state.elevGrid,
            printCrs: state.printCrs,
            material: state.material,
            grade: state.grade,
            kitQty: state.kitQty,
            zips: state.zips,
            country: document.getElementById("country").value,
            region: document.getElementById("region").value,
            postal: document.getElementById("postal").value,
            city: document.getElementById("city").value,
            street: document.getElementById("street").value,
            recipient: document.getElementById("recipient").value,
        };
    }

    function drawMap() {
        if (!map) return;
        const styleColor = state.color;
        const fit = state.fit;
        const printKey = state.printCrs ? state.printCrs.label : "";
        const ramp = activeRamp();
        const rampKey = ramp ? ramp.id : "";
        const signature = `${styleColor}|${rampKey}|${printKey}|${state.feature ? featureName(state.feature, 0) : ""}|${fit ? `${fit.cols}x${fit.rows}@${fit.rotationDeg}` : ""}|${state.pourPoint}|${state.exaggeration}|${state.reliefImage ? state.reliefImage.exaggeration : ""}|${state.reliefImage ? state.reliefImage.ramp : ""}|${state.elevGrid ? state.elevGrid.key : ""}`;
        if (map._swccSignature === signature) return;
        map._swccSignature = signature;
        const token = (map._swccToken || 0) + 1;
        map._swccToken = token;
        map.setStyle(mapStyle(styleColor, rampKey));
        const addOverlays = () => {
            if (map._swccToken !== token || !map.isStyleLoaded()) return;
            const squareFeatures = fit ? [...fit.squares].map((key) => {
                const { col, row } = parseSquare(key);
                return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [modelSquareRing(col, row, fit)] } };
            }) : [];
            map.addSource("squares", {
                type: "geojson",
                data: { type: "FeatureCollection", features: squareFeatures },
            });
            map.addLayer({
                id: "square-fill",
                type: "fill",
                source: "squares",
                paint: { "fill-color": "#ffffff", "fill-opacity": styleColor === "white" ? 0.35 : 0.04 },
            });
            map.addLayer({
                id: "square-line",
                type: "line",
                source: "squares",
                paint: { "line-color": "#1d1d1f", "line-width": 2 },
            });
            if (fit && fit.borderIn > 0) {
                map.addSource("inset", {
                    type: "geojson",
                    data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [modelInsetRing(fit)] } },
                });
                map.addLayer({
                    id: "inset-line",
                    type: "line",
                    source: "inset",
                    paint: { "line-color": "#8a6a12", "line-width": 2, "line-dasharray": [2, 1] },
                });
            }
            if (styleColor === "dem" && state.reliefImage) {
                map.addSource("relief", {
                    type: "image",
                    url: state.reliefImage.url,
                    coordinates: state.reliefImage.coordinates,
                });
                map.addLayer({ id: "relief", type: "raster", source: "relief" });
                document.getElementById("map").dataset.dem = "shown";
            }
            const basinId = state.feature && state.feature.properties && state.feature.properties.id;
            const streams = state.elevGrid && state.elevGrid.key === basinId ? state.elevGrid.streams : null;
            if (styleColor === "dem" && streams && streams.features && streams.features.length) {
                map.addSource("streams", { type: "geojson", data: streams });
                map.addLayer({
                    id: "streams",
                    type: "line",
                    source: "streams",
                    paint: { "line-color": "#143d66", "line-width": 1.5 },
                });
                document.getElementById("map").dataset.streams = "shown";
            }
            document.getElementById("map-note").textContent = mapCaption();
            if (state.feature) {
                map.addSource("basin", { type: "geojson", data: state.feature });
                map.addLayer({
                    id: "basin-fill",
                    type: "fill",
                    source: "basin",
                    paint: { "fill-color": "#C8102E", "fill-opacity": styleColor === "dem" ? 0.08 : 0.28 },
                });
                map.addLayer({
                    id: "basin-line",
                    type: "line",
                    source: "basin",
                    paint: { "line-color": "#7a0019", "line-width": 3 },
                });
                document.getElementById("map").dataset.basin = "shown";
            }
            if (marker) marker.remove();
            if (state.pourPoint) {
                marker = new maplibregl.Marker({ color: "#C8102E" }).setLngLat(state.pourPoint).addTo(map);
            }
            const bounds = new maplibregl.LngLatBounds();
            squareFeatures.forEach((feature) => feature.geometry.coordinates[0].forEach((coord) => bounds.extend(coord)));
            if (state.feature) {
                const visit = (coords) => {
                    if (typeof coords[0] === "number") {
                        bounds.extend(coords);
                        return;
                    }
                    coords.forEach(visit);
                };
                visit(state.feature.geometry.coordinates);
            }
            if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 36, duration: 0 });
        };
        if (map.isStyleLoaded()) addOverlays();
        else map.once("idle", addOverlays);
    }

    function saveQuote() {
        const payload = orderPayload(readForm());
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "watershed-model-quote.json";
        link.click();
        URL.revokeObjectURL(url);
    }

    window.SWCCWatershed = {
        orderPayload: () => orderPayload(readForm()),
        estimate: () => printEstimate(readForm()),
        rampColor: (elev) => {
            const ramp = activeRamp();
            return ramp ? reliefColor(elev, ramp.stops) : null;
        },
    };
}

function mapStyle(color, rampId) {
    const bases = {
        satellite: {
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            maxzoom: 19,
            attribution: "Satellite imagery © Esri",
        },
        topo: {
            tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"],
            maxzoom: 16,
            attribution: "USGS Topo",
        },
    };
    const base = bases[color];
    if (!base) {
        return {
            version: 8,
            sources: {
                overview: {
                    type: "raster",
                    tiles: [assetPath(`data/map/${rampId || "cd-a"}/{z}/{x}/{y}.png?v=20261008e`)],
                    tileSize: 256,
                    maxzoom: 4,
                    attribution: "Copernicus DEM GLO-30",
                },
            },
            layers: [{ id: "overview", type: "raster", source: "overview" }],
        };
    }
    return {
        version: 8,
        sources: {
            base: {
                type: "raster",
                tiles: base.tiles,
                tileSize: 256,
                maxzoom: base.maxzoom,
                attribution: base.attribution,
            },
        },
        layers: [{ id: "base", type: "raster", source: "base" }],
    };
}
