const WATERSHED_COLORS = ["white", "dem", "satellite", "topo"];
const DEFAULT_HUC = "0708020806";
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

const HUC_LABEL = {
    2: "HUC2", 4: "HUC4", 6: "HUC6", 8: "HUC8",
    10: "HUC10", 12: "HUC12", 14: "HUC14", 16: "HUC16",
};

function catalogOutlineSentence(level) {
    if (level === "HUC10") return "The outline is simplified to about 110 m.";
    if (level === "HUC12") return "The outline is simplified to about 55 m.";
    if (level === "HUC14" || level === "HUC16") return "The outline is simplified to about 22 m.";
    if (level === "HUC2" || level === "HUC4" || level === "HUC6" || level === "HUC8") {
        return "The outline is simplified to about 550 m.";
    }
    return "The outline is simplified for the web catalog.";
}
const DEM_RESOLUTIONS = [30, 90, 250, 500, 1000, 2000, 5000];
const COARSE_RESOLUTIONS = [500, 1000, 2000];
const FINE_RESOLUTIONS = [30, 90, 250];
const DEM_CELL_MIN = 100000;
const DEM_CELL_MAX = 1000000;
const BASIN_CELL_CAP = 4000000;
// Cells inside the outline. The sample rectangle can be larger.
// Copperas-Duck at 30 m is about 2.85 million basin cells in a
// 17.1 million cell box. 32 million still rejects a pathological box.
const BOX_CELL_CAP = 32000000;

function resolutionLabel(meters) {
    const value = Number(meters);
    if (value >= 1000 && value % 1000 === 0) return `${value / 1000} km`;
    return `${value} m`;
}

function ringAreaM2(ring) {
    if (!ring || ring.length < 4) return 0;
    let total = 0;
    for (let index = 0; index < ring.length - 1; index += 1) {
        const [lon1, lat1] = ring[index];
        const [lon2, lat2] = ring[index + 1];
        total += ((lon2 - lon1) * Math.PI) / 180 * (Math.sin((lat2 * Math.PI) / 180) + Math.sin((lat1 * Math.PI) / 180));
    }
    return Math.abs(total) * WGS84_A * WGS84_A / 2;
}

function geometryAreaM2(geometry) {
    if (!geometry) return 0;
    if (geometry.type === "Polygon") {
        const rings = geometry.coordinates || [];
        let area = ringAreaM2(rings[0]);
        rings.slice(1).forEach((hole) => {
            area -= ringAreaM2(hole);
        });
        return area;
    }
    if (geometry.type === "MultiPolygon") {
        return (geometry.coordinates || []).reduce((sum, part) => (
            sum + geometryAreaM2({ type: "Polygon", coordinates: part })
        ), 0);
    }
    return 0;
}

function basinAreaM2(feature) {
    const given = feature && feature.properties ? finite(feature.properties.area_km2) : null;
    if (given > 0) return given * 1e6;
    const measured = feature && feature.geometry ? geometryAreaM2(feature.geometry) : 0;
    return measured > 0 ? measured : null;
}

function basinCellEstimate(feature, resolution) {
    const area = basinAreaM2(feature);
    if (!(area > 0) || !(resolution > 0)) return null;
    return area / (resolution * resolution);
}

function cellCountText(count) {
    return Math.round(count).toLocaleString("en-US");
}

function defaultResolutionM(areaM2) {
    if (!(areaM2 > 0)) return DEM_RESOLUTIONS[0];
    const inBand = DEM_RESOLUTIONS.find((resolution) => {
        const cells = areaM2 / (resolution * resolution);
        return cells >= DEM_CELL_MIN && cells <= DEM_CELL_MAX;
    });
    if (inBand) return inBand;
    if (areaM2 / (DEM_RESOLUTIONS[0] * DEM_RESOLUTIONS[0]) < DEM_CELL_MIN) return DEM_RESOLUTIONS[0];
    return DEM_RESOLUTIONS[DEM_RESOLUTIONS.length - 1];
}

function featureName(feature, index) {
    const props = feature.properties || {};
    return String(props.name || props.Name || props.id || `Basin ${index + 1}`);
}

function catalogMatches(rows, query) {
    const text = String(query || "").trim().toLowerCase();
    if (text.length < 2 || !rows) return [];
    const digits = /^\d+$/.test(text);
    const hits = [];
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const code = String(row[1]);
        const name = String(row[2] || "");
        const lower = name.toLowerCase();
        let rank = 9;
        if (digits) {
            if (code === text) rank = 0;
            else if (code.startsWith(text)) rank = 1;
            else continue;
        } else if (lower === text) rank = 0;
        else if (lower.startsWith(text)) rank = 1;
        else if (lower.includes(text)) rank = 2;
        else continue;
        hits.push({ rank, row });
    }
    hits.sort((left, right) => left.rank - right.rank
        || left.row[0] - right.row[0]
        || String(left.row[1]).length - String(right.row[1]).length
        || String(left.row[2]).localeCompare(String(right.row[2])));
    return hits.slice(0, 20).map((hit) => hit.row);
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

function fitSquares(feature, count, alignment, outline, crs, bufferIn) {
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
    const border = clampBufferIn(bufferIn);
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
const MM_PER_IN = 25.4;
const MODEL_MAX_IN = 18;
const AMES_TAX_RATE = 0.07;
const AMES_STATE_RATE = 0.06;
const AMES_LOCAL_RATE = 0.01;
const ZONE_DAYS = { 2: "1–2", 3: "2", 4: "2–3", 5: "3", 6: "3–4", 7: "4", 8: "4–5" };

function defaultBaseMm(tileCount) {
    const count = Math.max(1, Math.min(100, Math.floor(Number(tileCount)) || 1));
    const mm = 2 + 0.2 * (count - 1);
    return Math.min(40, Math.max(2, Math.round(mm * 10) / 10));
}

function clampBaseMm(value, tileCount) {
    if (value == null || String(value).trim() === "") return defaultBaseMm(tileCount);
    const next = Number(value);
    if (!Number.isFinite(next)) return defaultBaseMm(tileCount);
    return Math.min(40, Math.max(2, next));
}

function clampBufferIn(value) {
    if (value == null || String(value).trim() === "") return 0.5;
    const next = Number(value);
    if (!Number.isFinite(next)) return 0.5;
    return Math.min(3, Math.max(0, next));
}

function moneyCents(amount) {
    if (!Number.isFinite(amount)) return null;
    const sign = amount < 0 ? -1 : 1;
    return sign * Math.round(Math.abs(amount) * 100) / 100;
}

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

function stackInches(grid, fit, exaggeration, baseIn) {
    if (!grid || !fit || !fit.squares || !fit.squares.size || !(fit.metersPerInch > 0)) return null;
    const slab = Number(baseIn);
    const base = Number.isFinite(slab) && slab >= 0 ? slab : 0;
    const peaks = squarePeaks(grid, fit);
    let total = 0;
    peaks.forEach((elev) => {
        const rise = elev == null ? 0 : Math.max(0, elev - grid.min) / fit.metersPerInch * (Number(exaggeration) || 0);
        total += base + rise;
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

function meanRiseIn(grid, fit, exaggeration) {
    if (!grid || !fit || !(fit.metersPerInch > 0) || !grid.values) return null;
    let sum = 0;
    let count = 0;
    grid.values.forEach((value) => {
        if (value == null) return;
        sum += value;
        count += 1;
    });
    if (!count) return null;
    return Math.max(0, (sum / count) - grid.min) / fit.metersPerInch * (Number(exaggeration) || 0);
}

function modelSampleCounts(widthIn, depthIn, cellIn, budget) {
    const cell = cellIn > 0 ? cellIn : Math.max(widthIn, depthIn) / 127;
    const limit = budget > 0 ? budget : 2000000;
    let nx = Math.max(2, Math.round(widthIn / cell) + 1);
    let ny = Math.max(2, Math.round(depthIn / cell) + 1);
    while (nx * ny > limit && (nx > 2 || ny > 2)) {
        nx = Math.max(2, Math.ceil(nx * 0.7));
        ny = Math.max(2, Math.ceil(ny * 0.7));
    }
    return { nx, ny };
}

function chamferDistances(mask, nx, ny, stepX, stepY) {
    const dist = new Float32Array(nx * ny);
    const diag = Math.hypot(stepX, stepY);
    const far = 1e6;
    for (let index = 0; index < dist.length; index += 1) dist[index] = mask[index] ? 0 : far;
    for (let j = 0; j < ny; j += 1) {
        const row = j * nx;
        const prev = row - nx;
        for (let i = 0; i < nx; i += 1) {
            let next = dist[row + i];
            if (i > 0) next = Math.min(next, dist[row + i - 1] + stepX);
            if (j > 0) {
                next = Math.min(next, dist[prev + i] + stepY);
                if (i > 0) next = Math.min(next, dist[prev + i - 1] + diag);
                if (i + 1 < nx) next = Math.min(next, dist[prev + i + 1] + diag);
            }
            dist[row + i] = next;
        }
    }
    for (let j = ny - 1; j >= 0; j -= 1) {
        const row = j * nx;
        const above = row + nx;
        for (let i = nx - 1; i >= 0; i -= 1) {
            let next = dist[row + i];
            if (i + 1 < nx) next = Math.min(next, dist[row + i + 1] + stepX);
            if (j + 1 < ny) {
                next = Math.min(next, dist[above + i] + stepY);
                if (i + 1 < nx) next = Math.min(next, dist[above + i + 1] + diag);
                if (i > 0) next = Math.min(next, dist[above + i - 1] + diag);
            }
            dist[row + i] = next;
        }
    }
    return dist;
}

function baseFootprintIn2(grid, fit) {
    const empty = { baseIn2: 0, basinRasterIn2: 0 };
    if (!grid || !fit || !(fit.outerWidthIn > 0) || !(fit.outerHeightIn > 0) || !grid.values) return empty;
    const border = fit.borderIn || 0;
    const signature = [
        grid.key,
        grid.resolution_m,
        fit.cols,
        fit.rows,
        fit.rotationDeg,
        fit.inchesPerMeter,
        border,
        fit.cx,
        fit.cy,
        fit.crs ? fit.crs.label : "",
    ].join("|");
    if (grid._footprint && grid._footprint.signature === signature) return grid._footprint;
    const widthIn = fit.outerWidthIn;
    const depthIn = fit.outerHeightIn;
    const counts = modelSampleCounts(widthIn, depthIn, demCellInches(grid, fit), 400000);
    const nx = counts.nx;
    const ny = counts.ny;
    const stepX = nx === 1 ? widthIn : widthIn / (nx - 1);
    const stepY = ny === 1 ? depthIn : depthIn / (ny - 1);
    const mask = new Uint8Array(nx * ny);
    const halfW = widthIn / 2;
    const halfH = depthIn / 2;
    for (let j = 0; j < ny; j += 1) {
        const my = -halfH + (ny === 1 ? 0 : (j / (ny - 1)) * depthIn);
        for (let i = 0; i < nx; i += 1) {
            const mx = -halfW + (nx === 1 ? 0 : (i / (nx - 1)) * widthIn);
            const lnglat = modelInchesToLngLat(mx, my, fit);
            if (sampleGridElev(grid, lnglat[0], lnglat[1]) == null) continue;
            mask[j * nx + i] = 1;
        }
    }
    const dist = border > 0 ? chamferDistances(mask, nx, ny, stepX, stepY) : null;
    const limit = border + 1e-6;
    let basinCells = 0;
    let baseCells = 0;
    for (let index = 0; index < mask.length; index += 1) {
        if (mask[index]) basinCells += 1;
        if (mask[index] || (dist && dist[index] <= limit)) baseCells += 1;
    }
    const cellArea = stepX * stepY;
    const result = {
        signature,
        basinRasterIn2: basinCells * cellArea,
        baseIn2: baseCells * cellArea,
    };
    grid._footprint = result;
    return result;
}

function printEstimate(state) {
    const spec = state.rates && state.rates.print;
    const material = spec && spec.materials ? spec.materials[state.material] : null;
    const grade = spec && spec.grades ? spec.grades[state.grade] : null;
    const squares = state.squares ? state.squares.size : 0;
    const appliedEarly = state.vertical ? state.vertical.applied : state.exaggeration;
    const riseIn = meanRiseIn(state.elevGrid, state.fit, appliedEarly);
    if (!spec || !material || !grade || !squares || riseIn == null) return { ready: false };
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
    const baseMm = clampBaseMm(state.baseMm == null ? defaultBaseMm(squares) : state.baseMm, squares);
    const baseIn = baseMm / MM_PER_IN;
    const tileIn2 = square * square * squares;
    const basinM2 = basinAreaM2(state.feature);
    const scale = state.fit && state.fit.inchesPerMeter > 0 ? state.fit.inchesPerMeter : 0;
    let basinIn2 = basinM2 && scale ? basinM2 * scale * scale : 0;
    let areaSource = "basin";
    if (!(basinIn2 > 0)) {
        basinIn2 = tileIn2;
        areaSource = "tiles";
    } else if (basinIn2 > tileIn2) basinIn2 = tileIn2;
    const footprint = baseFootprintIn2(state.elevGrid, state.fit);
    let baseIn2 = footprint.baseIn2;
    if (areaSource === "basin" && footprint.basinRasterIn2 > 0 && basinIn2 > 0) {
        baseIn2 *= basinIn2 / footprint.basinRasterIn2;
    }
    if (!(baseIn2 > 0)) baseIn2 = tileIn2;
    if (baseIn2 > tileIn2) baseIn2 = tileIn2;
    const baseCm3 = baseIn2 * baseIn * CUBIC_INCH_CM3 * infill;
    const reliefCm3 = basinIn2 * riseIn * CUBIC_INCH_CM3 * infill;
    const plasticCm3 = baseCm3 + reliefCm3;
    const kg = plasticCm3 * density / 1000;
    const hours = (plasticCm3 * 1000) / flow / 3600;
    const height = baseIn2 > 0 ? (baseIn * baseIn2 + riseIn * basinIn2) / baseIn2 : baseIn;
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
    const boxHeight = stackInches(state.elevGrid, state.fit, applied, baseIn) || height * squares;
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
        baseMm,
        baseIn,
        riseIn,
        tileIn2,
        basinIn2,
        baseIn2,
        areaSource,
        baseCm3,
        reliefCm3,
        plasticCm3,
        withFailure,
        kitTotal,
        markedUp,
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

function rampRange(book, scale, grid) {
    const conusLow = book ? Number(book.z_min) : 0;
    const conusHigh = book ? Number(book.z_max) : 8000;
    if (scale === "watershed" && grid && grid.max > grid.min) {
        return { mode: "watershed", low: grid.min, high: grid.max, conusLow, conusHigh };
    }
    return { mode: "conus", low: conusLow, high: conusHigh, conusLow, conusHigh };
}

function scaleRampStops(stops, fromLow, fromHigh, toLow, toHigh) {
    const fromSpan = fromHigh - fromLow;
    const toSpan = toHigh - toLow;
    if (!stops || !(fromSpan > 0) || !(toSpan > 0)) return stops;
    return stops.map(([elev, color]) => [
        toLow + ((elev - fromLow) / fromSpan) * toSpan,
        color,
    ]);
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

function maxExaggeration(reliefM, metersPerInch, baseIn) {
    if (!(reliefM > 0) || !(metersPerInch > 0)) return 100;
    const room = Math.max(0, MODEL_MAX_IN - (Number(baseIn) || 0));
    return Math.min(100, roundDownTenth((room * metersPerInch) / reliefM));
}

function appliedExaggeration(requested, reliefM, metersPerInch, baseIn) {
    const asked = Math.min(100, Math.max(0, Number(requested) || 0));
    return Math.min(asked, maxExaggeration(reliefM, metersPerInch, baseIn));
}

function terrainHeight(elev, elevMin, metersPerInch, exaggeration, baseIn) {
    const base = Number(baseIn);
    const slab = Number.isFinite(base) && base >= 0 ? base : 0;
    const rise = metersPerInch > 0 ? (Math.max(0, elev - elevMin) / metersPerInch) * exaggeration : 0;
    return { baseIn: slab, totalIn: slab + rise };
}

function customerView(estimate, state) {
    const squares = state.squares ? state.squares.size : 0;
    const modelLabel = `Watershed Flow Model (${squares})`;
    if (!estimate || !estimate.ready) {
        return {
            lines: [
                { label: modelLabel, amount: null },
                { label: "Accessory kits (0)", amount: null },
                { label: "Shipping", amount: null },
            ],
            total: null,
            tax: null,
        };
    }
    const goods = estimate.withFailure + estimate.kitTotal;
    const markedCents = moneyCents(estimate.markedUp);
    const modelShare = goods > 0 ? estimate.withFailure / goods : 1;
    const modelAmount = markedCents == null ? null : moneyCents(estimate.markedUp * modelShare);
    const kitAmount = markedCents == null || modelAmount == null ? null : moneyCents(markedCents - modelAmount);
    const kitCount = estimate.kitLines.reduce((sum, kit) => sum + kit.qty, 0);
    const shipAmount = estimate.ship && estimate.ship.amount != null ? moneyCents(estimate.ship.amount) : null;
    const exempt = !!state.isuAffiliated;
    const taxAmount = exempt || markedCents == null ? 0 : moneyCents(markedCents * AMES_TAX_RATE);
    const lines = [
        { label: modelLabel, amount: modelAmount },
        { label: `Accessory kits (${kitCount})`, amount: kitAmount },
    ];
    if (!exempt) lines.push({ label: "Sales tax, 7%", amount: taxAmount });
    lines.push({ label: "Shipping", amount: shipAmount });
    const known = lines.every((line) => line.amount != null);
    const total = known ? moneyCents(lines.reduce((sum, line) => sum + line.amount, 0)) : null;
    return {
        lines,
        total,
        tax: {
            exempt,
            rate: exempt ? 0 : AMES_TAX_RATE,
            jurisdiction: "Ames, Story County, Iowa",
            state_rate: AMES_STATE_RATE,
            local_rate: AMES_LOCAL_RATE,
            basis: "model and kits, after markup, before shipping",
            amount: taxAmount,
        },
    };
}

function gridMean(grid) {
    let sum = 0;
    let count = 0;
    grid.values.forEach((value) => {
        if (value == null) return;
        sum += value;
        count += 1;
    });
    return count ? sum / count : null;
}

function orderPayload(state) {
    const lines = quoteLines(state);
    const estimate = printEstimate(state);
    const missing = lines.filter((line) => line.amount == null).map((line) => line.label);
    const internalTotal = missing.length ? null : lines.reduce((sum, line) => sum + line.amount, 0);
    const view = customerView(estimate, state);
    const total = missing.length ? null : view.total;
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
        border_in: state.fit ? state.fit.borderIn : clampBufferIn(state.bufferIn),
        buffer_in: state.fit ? state.fit.borderIn : clampBufferIn(state.bufferIn),
        base_mm: estimate.ready ? estimate.baseMm : clampBaseMm(state.baseMm, state.squares ? state.squares.size : 1),
        base_in: estimate.ready ? estimate.baseIn : null,
        isu_affiliated: !!state.isuAffiliated,
        volume: estimate.ready ? {
            tile_in2: estimate.tileIn2,
            basin_in2: estimate.basinIn2,
            base_in2: estimate.baseIn2,
            area_source: estimate.areaSource,
            base_cm3: estimate.baseCm3,
            relief_cm3: estimate.reliefCm3,
            plastic_cm3: estimate.plasticCm3,
        } : null,
        meters_per_inch: state.fit ? state.fit.metersPerInch : null,
        inches_per_meter: state.fit ? state.fit.inchesPerMeter : null,
        cx: state.fit ? state.fit.cx : null,
        cy: state.fit ? state.fit.cy : null,
        origin: state.fit && state.fit.origin ? state.fit.origin : null,
        lng0: state.fit ? state.fit.lng0 : null,
        lat0: state.fit ? state.fit.lat0 : null,
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
        customer_lines: view.lines,
        tax: view.tax,
        internal_total: internalTotal,
        total,
        missing,
        delivery: deliveryDays(state),
        vertical: state.vertical || null,
        print: state.printCrs ? {
            crs: state.printCrs.label,
            crs_fit: {
                kind: state.printCrs.kind,
                zone: state.printCrs.zone,
                south: !!state.printCrs.south,
                lat_1: state.printCrs.lat_1,
                lat_2: state.printCrs.lat_2,
                lat_0: state.printCrs.lat_0,
                lon_0: state.printCrs.lon_0,
                label: state.printCrs.label,
            },
            resolution_m: state.resolution,
            published_resolution_m: state.elevGrid && state.elevGrid.resolution_m != null
                ? state.elevGrid.resolution_m
                : null,
        } : null,
        elevation: state.elevGrid ? {
            box: state.elevGrid.box,
            cols: state.elevGrid.cols,
            rows: state.elevGrid.rows || state.elevGrid.n,
            min: state.elevGrid.min,
            max: state.elevGrid.max,
            mean: gridMean(state.elevGrid),
            resolution_m: state.elevGrid.resolution_m,
        } : null,
        dem_cells: (() => {
            const area = basinAreaM2(state.feature);
            return area && state.resolution ? Math.round(area / (state.resolution * state.resolution)) : null;
        })(),
        dem_ramp: (() => {
            const chosen = state.rampBook && (state.rampBook.ramps.find((ramp) => ramp.id === state.ramp) || state.rampBook.ramps[0]);
            if (!chosen) return null;
            const limits = rampRange(state.rampBook, state.rampScale, state.elevGrid);
            return {
                id: chosen.id,
                label: chosen.label,
                scale: limits.mode,
                z_min: limits.low,
                z_max: limits.high,
            };
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

let demBookPromise = null;
let fineBookPromise = null;
let fineBook = null;
const demTileCache = new Map();

function loadDemBook() {
    if (!demBookPromise) {
        demBookPromise = loadJSON(assetPath("data/dem/index.json")).catch((error) => {
            demBookPromise = null;
            throw error;
        });
    }
    return demBookPromise;
}

function loadFineBook() {
    if (!fineBookPromise) {
        fineBookPromise = loadJSON(assetPath("data/dem/fine.json")).then((book) => {
            fineBook = book;
            return book;
        }).catch((error) => {
            fineBookPromise = null;
            fineBook = null;
            throw error;
        });
    }
    return fineBookPromise;
}

function decodeMask(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function maskHas(mask, tilesX, tx, ty) {
    const index = ty * tilesX + tx;
    const byteIndex = index >> 3;
    if (byteIndex < 0 || byteIndex >= mask.length) return false;
    return (mask[byteIndex] & (1 << (index & 7))) !== 0;
}

async function demTile(url, signal, missingMode) {
    if (demTileCache.has(url)) return demTileCache.get(url);
    const response = await fetch(url, { signal, redirect: missingMode === "fail" ? "error" : "follow" });
    if (response.status === 404) {
        if (missingMode === "fail") throw new Error("missing tile");
        demTileCache.set(url, null);
        return null;
    }
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    bitmap.close();
    demTileCache.set(url, pixels);
    return pixels;
}

function maskRaster(geometry, west, north, cell, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.beginPath();
    const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
    polygons.forEach((rings) => {
        rings.forEach((ring) => {
            ring.forEach((coord, index) => {
                const x = (coord[0] - west) / cell;
                const y = (north - coord[1]) / cell;
                if (index === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.closePath();
        });
    });
    ctx.fillStyle = "#fff";
    ctx.fill("evenodd");
    return ctx.getImageData(0, 0, width, height).data;
}

async function sampleTiled(feature, resolution, signal, book, urlFor, maskMode) {
    const id = feature.properties && feature.properties.id;
    const spec = book && book.grids && book.grids[String(resolution)];
    if (!id || !spec) throw new Error("no coarse grid");
    const presence = maskMode === "mask" ? decodeMask(spec.mask || "") : null;
    if (maskMode === "mask" && (!presence || !spec.tiles_x)) throw new Error("no fine grid");
    const bounds = featureBbox(feature);
    const cell = spec.cell_deg;
    let col0 = Math.floor((bounds[0] - spec.west) / cell);
    let col1 = Math.ceil((bounds[2] - spec.west) / cell);
    let row0 = Math.floor((spec.north - bounds[3]) / cell);
    let row1 = Math.ceil((spec.north - bounds[1]) / cell);
    col0 = Math.max(0, Math.min(spec.cols, col0));
    col1 = Math.max(0, Math.min(spec.cols, col1));
    row0 = Math.max(0, Math.min(spec.rows, row0));
    row1 = Math.max(0, Math.min(spec.rows, row1));
    const width = col1 - col0;
    const height = row1 - row0;
    if (width < 2 || height < 2) throw new Error("empty grid");
    const boxCells = width * height;
    const basinCells = basinCellEstimate(feature, resolution);
    // A box past the hard cap cannot be allocated. If the basin itself
    // is over the cell cap, say that. Otherwise name the box.
    if (boxCells > BOX_CELL_CAP) {
        const error = new Error(basinCells > BASIN_CELL_CAP ? "grid size" : "grid box");
        error.boxCells = boxCells;
        error.basinCells = basinCells;
        throw error;
    }
    const west = spec.west + col0 * cell;
    const north = spec.north - row0 * cell;
    let mask;
    try {
        mask = maskRaster(feature.geometry, west, north, cell, width, height);
    } catch (rasterError) {
        const error = new Error(basinCells > BASIN_CELL_CAP ? "grid size" : "grid box");
        error.boxCells = boxCells;
        error.basinCells = basinCells;
        throw error;
    }
    const tile = book.tile || 256;
    const tiles = new Map();
    const jobs = [];
    for (let ty = Math.floor(row0 / tile); ty <= Math.floor((row1 - 1) / tile); ty += 1) {
        for (let tx = Math.floor(col0 / tile); tx <= Math.floor((col1 - 1) / tile); tx += 1) {
            jobs.push([tx, ty]);
        }
    }
    let cursor = 0;
    const worker = async () => {
        while (cursor < jobs.length) {
            const index = cursor;
            cursor += 1;
            const [tx, ty] = jobs[index];
            if (presence && !maskHas(presence, spec.tiles_x, tx, ty)) {
                tiles.set(`${tx}/${ty}`, null);
                continue;
            }
            const pixels = await demTile(urlFor(tx, ty), signal, presence ? "fail" : "ocean");
            tiles.set(`${tx}/${ty}`, pixels);
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    const values = new Array(width * height);
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    const sample = (localCol, imageRow) => {
        const col = col0 + localCol;
        const row = row0 + imageRow;
        const pixels = tiles.get(`${Math.floor(col / tile)}/${Math.floor(row / tile)}`);
        if (!pixels) return 0;
        const px = col - Math.floor(col / tile) * tile;
        const py = row - Math.floor(row / tile) * tile;
        const stored = pixels[(py * tile + px) * 4] * 256 + pixels[(py * tile + px) * 4 + 1];
        if (stored === book.nodata) return null;
        return stored - book.offset;
    };
    for (let imageRow = 0; imageRow < height; imageRow += 1) {
        const outRow = height - 1 - imageRow;
        for (let col = 0; col < width; col += 1) {
            const inside = mask[(imageRow * width + col) * 4 + 3] >= 128;
            let elev = null;
            if (inside) {
                elev = sample(col, imageRow);
                if (elev != null) {
                    if (elev < min) min = elev;
                    if (elev > max) max = elev;
                    count += 1;
                }
            }
            values[outRow * width + col] = elev;
        }
    }
    if (!count) throw new Error("empty grid");
    if (count > BASIN_CELL_CAP) {
        const error = new Error("grid size");
        error.basinCells = count;
        error.boxCells = boxCells;
        throw error;
    }
    return {
        n: width,
        rows: height,
        cols: width,
        values,
        box: [west, spec.north - row1 * cell, spec.west + col1 * cell, north],
        min,
        max,
        key: id,
        crs: null,
        resolution_m: resolution,
        outline_m: null,
        attribution: book.attribution,
        streams: null,
    };
}

async function sampleCoarse(feature, resolution, signal) {
    const book = await loadDemBook();
    return sampleTiled(
        feature,
        resolution,
        signal,
        book,
        (tx, ty) => assetPath(`data/dem/${resolution}/${tx}/${ty}.png`),
        "ocean",
    );
}

const FINE_TILE_BASES = new Set();
const HOSTED_TILE_BASE = "https://raw.githubusercontent.com/ISU-SWCC/isu-swcc.github.io/dem-tiles";
const HOSTED_RESOLUTIONS = [250];

function hostedTileUrl(resolution, tx, ty) {
    return `${HOSTED_TILE_BASE}/${resolution}/${tx}/${ty}.png`;
}

async function sampleHosted(feature, resolution, signal) {
    const book = await loadDemBook();
    return sampleTiled(
        feature,
        resolution,
        signal,
        book,
        (tx, ty) => hostedTileUrl(resolution, tx, ty),
        "ocean",
    );
}

async function sampleFine(feature, resolution, signal) {
    const book = await loadFineBook();
    const base = book && book.base ? String(book.base).replace(/\/$/, "") : "";
    if (!FINE_TILE_BASES.has(base.toLowerCase())) throw new Error("no fine grid");
    return sampleTiled(
        feature,
        resolution,
        signal,
        book,
        (tx, ty) => `${base}/${resolution}/${tx}/${ty}.png`,
        "mask",
    );
}

function bakedFileId(id, resolution) {
    if (id !== DEFAULT_HUC) return null;
    if (resolution === 30) return id;
    if (resolution === 90 || resolution === 250) return `${id}-${resolution}`;
    return null;
}

function resolutionAvailable(id, resolution) {
    if (COARSE_RESOLUTIONS.includes(resolution)) return true;
    if (bakedFileId(id, resolution)) return true;
    if (location.protocol === "https:") return HOSTED_RESOLUTIONS.includes(resolution);
    return FINE_RESOLUTIONS.includes(resolution);
}

function chooseResolution(feature) {
    const area = basinAreaM2(feature);
    const preferred = area ? defaultResolutionM(area) : DEM_RESOLUTIONS[0];
    const id = feature && feature.properties && feature.properties.id;
    if (resolutionAvailable(id, preferred)) return preferred;
    const start = DEM_RESOLUTIONS.indexOf(preferred);
    for (let index = (start < 0 ? 0 : start) + 1; index < DEM_RESOLUTIONS.length; index += 1) {
        const resolution = DEM_RESOLUTIONS[index];
        if (resolution === 5000) break;
        if (resolutionAvailable(id, resolution)) return resolution;
    }
    return preferred;
}

async function sampleElevations(feature, signal, fileId) {
    const id = feature.properties && feature.properties.id;
    if (!id) throw new Error("no id");
    const response = await fetch(assetPath(`data/elevation/${fileId || id}.json`), { signal });
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

function mercatorY(latDeg) {
    const phi = latDeg * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

function mercatorLat(y) {
    return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
}

function warpLatitudeImageToMercator(source, south, north) {
    const width = source.width;
    const height = source.height;
    const spanLat = north - south;
    if (!(Math.abs(spanLat) > 1e-8) || height < 2) return source;
    const src = source.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height);
    const dest = document.createElement("canvas");
    dest.width = width;
    dest.height = height;
    const dstCtx = dest.getContext("2d");
    const image = dstCtx.createImageData(width, height);
    const yNorth = mercatorY(north);
    const spanY = mercatorY(south) - yNorth;
    if (!(Math.abs(spanY) > 1e-12)) return source;
    for (let row = 0; row < height; row += 1) {
        const lat = mercatorLat(yNorth + ((row + 0.5) / height) * spanY);
        const sourceRow = Math.max(0, Math.min(height - 1, ((north - lat) / spanLat) * height - 0.5));
        const row0 = Math.floor(sourceRow);
        const row1 = Math.min(height - 1, row0 + 1);
        const frac = sourceRow - row0;
        for (let col = 0; col < width; col += 1) {
            const destPx = (row * width + col) * 4;
            const low = (row0 * width + col) * 4;
            const high = (row1 * width + col) * 4;
            for (let channel = 0; channel < 4; channel += 1) {
                image.data[destPx + channel] = Math.round(
                    src.data[low + channel] * (1 - frac) + src.data[high + channel] * frac,
                );
            }
        }
    }
    dstCtx.putImageData(image, 0, 0);
    return dest;
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
            const light = 0.78 + Math.max(-0.28, Math.min(0.28, (dzdx - dzdy) * exaggeration * 2));
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
    const [west, south, east, north] = grid.box;
    // The grid rows are equally spaced in latitude. MapLibre stretches an
    // image linearly in Web Mercator, so resample before placing the corners.
    const placed = warpLatitudeImageToMercator(sample, south, north);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(placed, 0, 0, canvas.width, canvas.height);
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

function campusOrderHost() {
    return false;
}

function rotr32(value, bits) {
    return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function sha256Hex(bytes) {
    const k = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const bits = bytes.length * 8;
    const padded = new Uint8Array(((bytes.length + 9 + 63) & ~63));
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, bits, false);
    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    const word = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let index = 0; index < 16; index += 1) word[index] = view.getUint32(offset + index * 4, false);
        for (let index = 16; index < 64; index += 1) {
            const s0 = rotr32(word[index - 15], 7) ^ rotr32(word[index - 15], 18) ^ (word[index - 15] >>> 3);
            const s1 = rotr32(word[index - 2], 17) ^ rotr32(word[index - 2], 19) ^ (word[index - 2] >>> 10);
            word[index] = (word[index - 16] + s0 + word[index - 7] + s1) >>> 0;
        }
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;
        for (let index = 0; index < 64; index += 1) {
            const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
            const choose = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + choose + k[index] + word[index]) >>> 0;
            const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function elevationSha(grid) {
    const rows = grid.rows || grid.n;
    const cols = grid.cols || grid.n;
    const bytes = new Uint8Array(rows * cols * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < rows * cols; index += 1) {
        const value = grid.values[index];
        view.setInt16(index * 2, value == null ? -32768 : Math.round(value), true);
    }
    return sha256Hex(bytes);
}

function multiply4(a, b) {
    const out = new Array(16);
    for (let col = 0; col < 4; col += 1) {
        for (let row = 0; row < 4; row += 1) {
            out[col * 4 + row] = a[row] * b[col * 4]
                + a[4 + row] * b[col * 4 + 1]
                + a[8 + row] * b[col * 4 + 2]
                + a[12 + row] * b[col * 4 + 3];
        }
    }
    return out;
}

function perspective4(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return [
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
    ];
}

function lookAt4(eye, center, up) {
    let zx = eye[0] - center[0];
    let zy = eye[1] - center[1];
    let zz = eye[2] - center[2];
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl;
    zy /= zl;
    zz /= zl;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl;
    xy /= xl;
    xz /= xl;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    return [
        xx, yx, zx, 0,
        xy, yy, zy, 0,
        xz, yz, zz, 0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
        -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
        -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
        1,
    ];
}

let printFrame = 0;
let printGeneration = 0;
let printViewToken = 0;
let printViewMark = null;
let printBuildSignature = null;
const LAYER_VERTEX_BUDGET = 250000;
const PLATE_RGB = [214 / 255, 210 / 255, 202 / 255];
const WALL_RGB = [0.75, 0.73, 0.7];

function viewSignature(state) {
    const grid = state.elevGrid;
    const crs = state.printCrs;
    const feature = state.feature;
    const id = feature && feature.properties ? feature.properties.id : "";
    const applied = state.vertical && Number.isFinite(state.vertical.applied)
        ? state.vertical.applied
        : state.exaggeration;
    return [
        id || "",
        state.squares ? state.squares.size : 0,
        state.bufferIn,
        state.alignment,
        crs ? crs.label : "",
        crs && crs.zone ? crs.zone : "",
        state.resolution,
        state.color,
        state.ramp,
        state.rampScale,
        applied,
        state.baseMm,
        state.grade,
        grid ? `${grid.key}@${grid.resolution_m}` : "",
    ].join("|");
}

function layerViewStatus(layerMm, color) {
    const mm = Number(layerMm).toFixed(2);
    let text = `Drag to turn the model. Heights are the print heights, sampled every ${mm} mm.`;
    if (color === "topo") text += " USGS topo stays on the map.";
    return text;
}

function satelliteStatus(layerMm, target, layout) {
    const mm = Number(layerMm).toFixed(2);
    let text = `Drag to turn the model. Heights are the print heights, sampled every ${mm} mm.`;
    if (target) {
        text += ` The satellite image is ${target.nx} by ${target.ny} pixels, one pixel every ${mm} mm.`;
    }
    if (layout && layout.k > 1) {
        text += ` This view shows every ${(Number(layerMm) * layout.k).toFixed(2)} mm. Zoom in for every ${mm} mm.`;
    }
    text += " NAIP from The National Map.";
    return text;
}

function clearPrintPointer(canvas) {
    if (!canvas) return;
    canvas.onpointerdown = null;
    canvas.onpointermove = null;
    canvas.onpointerup = null;
    if (canvas._printWheel) {
        canvas.removeEventListener("wheel", canvas._printWheel);
        canvas._printWheel = null;
    }
}

function hidePrintView(message) {
    printGeneration += 1;
    printViewToken += 1;
    printViewMark = null;
    printBuildSignature = null;
    if (printFrame) cancelAnimationFrame(printFrame);
    printFrame = 0;
    const canvas = document.getElementById("print-view");
    if (canvas) {
        canvas.hidden = true;
        clearPrintPointer(canvas);
    }
    const note = document.getElementById("print-status");
    if (note && message) note.textContent = message;
}

function syncPrintViewBlank(signature) {
    if (printViewMark && printViewMark !== signature) {
        hidePrintView("The settings changed. Render the watershed flow model again.");
        return;
    }
    if (printBuildSignature && printBuildSignature !== signature) {
        hidePrintView("The settings changed. Render the watershed flow model again.");
    }
}

function demCellInches(grid, fit) {
    const west = grid.box[0];
    const south = grid.box[1];
    const east = grid.box[2];
    const north = grid.box[3];
    const cols = grid.cols;
    const rows = grid.rows || grid.n;
    const mid = ((south + north) / 2) * Math.PI / 180;
    const cellX = ((east - west) * 111320 * Math.cos(mid)) / cols;
    const cellY = ((north - south) * 110540) / rows;
    return Math.min(cellX, cellY) / fit.metersPerInch;
}

function sampleGridElev(grid, lng, lat) {
    const west = grid.box[0];
    const south = grid.box[1];
    const east = grid.box[2];
    const north = grid.box[3];
    const cols = grid.cols;
    const rows = grid.rows || grid.n;
    const spanX = east - west;
    const spanY = north - south;
    if (!(spanX > 0) || !(spanY > 0)) return null;
    const u = ((lng - west) / spanX) * cols - 0.5;
    const v = ((lat - south) / spanY) * rows - 0.5;
    if (u < -0.5 || v < -0.5 || u > cols - 0.5 || v > rows - 0.5) return null;
    const at = (row, col) => {
        if (row < 0 || col < 0 || row >= rows || col >= cols) return null;
        const sample = grid.values[row * cols + col];
        return sample == null ? null : sample;
    };
    const ic = Math.min(cols - 1, Math.max(0, Math.floor(u + 0.5)));
    const ir = Math.min(rows - 1, Math.max(0, Math.floor(v + 0.5)));
    const nearest = at(ir, ic);
    if (nearest == null) return null;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const v00 = at(j0, i0);
    const v10 = at(j0, i0 + 1);
    const v01 = at(j0 + 1, i0);
    const v11 = at(j0 + 1, i0 + 1);
    if (v00 == null || v10 == null || v01 == null || v11 == null) return nearest;
    const tx = u - i0;
    const ty = v - j0;
    const low = v00 * (1 - tx) + v10 * tx;
    const high = v01 * (1 - tx) + v11 * tx;
    return low * (1 - ty) + high * ty;
}

function quantizeLayer(totalIn, baseIn, layerIn) {
    const shownBase = Math.max(layerIn, Math.round(baseIn / layerIn) * layerIn);
    if (!(totalIn > baseIn + 1e-6)) return shownBase;
    return shownBase + Math.round(Math.max(0, totalIn - baseIn) / layerIn) * layerIn;
}

async function buildViewField(form, token, paint) {
    const grid = form.elevGrid;
    const fit = form.fit;
    if (!grid || !fit || !(fit.metersPerInch > 0) || !(paint.layerMm > 0)) return null;
    const widthIn = fit.outerWidthIn;
    const depthIn = fit.outerHeightIn;
    const layerIn = paint.layerMm / MM_PER_IN;
    const baseIn = (Number(form.baseMm) || 0) / MM_PER_IN;
    const reliefM = Math.max(0, grid.max - grid.min);
    const applied = form.vertical && Number.isFinite(form.vertical.applied)
        ? form.vertical.applied
        : appliedExaggeration(form.exaggeration, reliefM, fit.metersPerInch, baseIn);
    const counts = modelSampleCounts(widthIn, depthIn, demCellInches(grid, fit));
    const nx = counts.nx;
    const ny = counts.ny;
    const height = new Float32Array(nx * ny);
    const elev = new Float32Array(nx * ny);
    const cover = new Uint8Array(nx * ny);
    const halfW = widthIn / 2;
    const halfH = depthIn / 2;
    const stepX = nx === 1 ? widthIn : widthIn / (nx - 1);
    const stepY = ny === 1 ? depthIn : depthIn / (ny - 1);
    const total = nx * ny;
    for (let cursor = 0; cursor < total; cursor += 25000) {
        if (token !== printViewToken) return null;
        const end = Math.min(total, cursor + 25000);
        for (let index = cursor; index < end; index += 1) {
            const i = index % nx;
            const j = (index / nx) | 0;
            const mx = -halfW + (nx === 1 ? 0 : (i / (nx - 1)) * widthIn);
            const my = -halfH + (ny === 1 ? 0 : (j / (ny - 1)) * depthIn);
            const lnglat = modelInchesToLngLat(mx, my, fit);
            const sample = sampleGridElev(grid, lnglat[0], lnglat[1]);
            if (sample == null) {
                height[index] = 0;
                elev[index] = NaN;
            } else {
                height[index] = terrainHeight(sample, grid.min, fit.metersPerInch, applied, baseIn).totalIn;
                elev[index] = sample;
                cover[index] = 1;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (token !== printViewToken) return null;
    const border = fit.borderIn || 0;
    if (border > 0) {
        const dist = chamferDistances(cover, nx, ny, stepX, stepY);
        const limit = border + 1e-6;
        for (let index = 0; index < total; index += 1) {
            if (cover[index] || !(dist[index] <= limit)) continue;
            cover[index] = 1;
            height[index] = baseIn;
        }
    }
    if (token !== printViewToken) return null;
    return {
        widthIn,
        depthIn,
        layerIn,
        layerMm: paint.layerMm,
        baseIn,
        applied,
        metersPerInch: fit.metersPerInch,
        colorMode: paint.colorMode,
        stops: paint.stops,
        fit,
        satelliteTarget: printImagePixels(widthIn, depthIn, layerIn),
        originX: -halfW,
        originY: -halfH,
        source: {
            nx,
            ny,
            stepX,
            stepY,
            height,
            elev,
            cover,
        },
    };
}

function sourceSample(view, mx, my) {
    const src = view.source;
    const u = src.nx === 1 ? 0 : ((mx - view.originX) / view.widthIn) * (src.nx - 1);
    const v = src.ny === 1 ? 0 : ((my - view.originY) / view.depthIn) * (src.ny - 1);
    const i0 = Math.max(0, Math.min(src.nx - 1, Math.floor(u)));
    const j0 = Math.max(0, Math.min(src.ny - 1, Math.floor(v)));
    const i1 = Math.min(src.nx - 1, i0 + 1);
    const j1 = Math.min(src.ny - 1, j0 + 1);
    const tx = i0 === i1 ? 0 : Math.max(0, Math.min(1, u - i0));
    const ty = j0 === j1 ? 0 : Math.max(0, Math.min(1, v - j0));
    const ids = [
        j0 * src.nx + i0,
        j0 * src.nx + i1,
        j1 * src.nx + i0,
        j1 * src.nx + i1,
    ];
    const weights = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
    let nearest = 0;
    for (let corner = 1; corner < 4; corner += 1) {
        if (weights[corner] > weights[nearest]) nearest = corner;
    }
    let coveredCount = 0;
    for (let corner = 0; corner < 4; corner += 1) {
        if (src.cover[ids[corner]]) coveredCount += 1;
    }
    if (coveredCount < 4) {
        if (!src.cover[ids[nearest]]) return { h: 0, elev: NaN, flat: true, covered: false };
        const nearestElev = src.elev[ids[nearest]];
        return {
            h: src.height[ids[nearest]],
            elev: Number.isFinite(nearestElev) ? nearestElev : NaN,
            flat: !Number.isFinite(nearestElev),
            covered: true,
        };
    }
    let h = 0;
    let elev = 0;
    let elevOk = true;
    for (let corner = 0; corner < 4; corner += 1) {
        h += src.height[ids[corner]] * weights[corner];
        const sample = src.elev[ids[corner]];
        if (!Number.isFinite(sample)) elevOk = false;
        else elev += sample * weights[corner];
    }
    if (!elevOk) return { h, elev: NaN, flat: true, covered: true };
    return { h, elev, flat: false, covered: true };
}

function layerShade(view, mx, my, elev) {
    const east = sourceSample(view, mx + view.source.stepX, my);
    const north = sourceSample(view, mx, my + view.source.stepY);
    if (east.flat || north.flat) return 0.78;
    const dx = view.source.stepX * view.metersPerInch;
    const dy = view.source.stepY * view.metersPerInch;
    if (!(dx > 0) || !(dy > 0)) return 0.78;
    const dzdx = (east.elev - elev) / dx;
    const dzdy = (north.elev - elev) / dy;
    return 0.78 + Math.max(-0.28, Math.min(0.28, (dzdx - dzdy) * view.applied * 2));
}

function layerColor(view, sample, mx, my) {
    if (view.colorMode !== "ramp" || sample.flat || !view.stops) return PLATE_RGB;
    const light = layerShade(view, mx, my, sample.elev);
    const rgb = reliefColor(sample.elev, view.stops);
    return [
        Math.max(0, Math.min(255, Math.round(rgb[0] * light))) / 255,
        Math.max(0, Math.min(255, Math.round(rgb[1] * light))) / 255,
        Math.max(0, Math.min(255, Math.round(rgb[2] * light))) / 255,
    ];
}

function planLayerWindow(view, dolly) {
    const widthIn = view.widthIn;
    const depthIn = view.depthIn;
    const step = view.layerIn;
    const scale = Math.min(1, Math.max(0.02, dolly));
    const spanX = widthIn * scale;
    const spanY = depthIn * scale;
    let k = 1;
    const sized = (drawStep) => {
        const nx = Math.max(2, Math.round(spanX / drawStep) + 1);
        const ny = Math.max(2, Math.round(spanY / drawStep) + 1);
        return { nx, ny, n: nx * ny };
    };
    let grid = sized(step);
    while (grid.n > LAYER_VERTEX_BUDGET && k < 100000) {
        k += 1;
        grid = sized(step * k);
    }
    const drawStep = step * k;
    const minX = -widthIn / 2;
    const minY = -depthIn / 2;
    let x0 = -spanX / 2;
    let y0 = -spanY / 2;
    x0 = Math.min(Math.max(x0, minX), Math.max(minX, minX + widthIn - spanX));
    y0 = Math.min(Math.max(y0, minY), Math.max(minY, minY + depthIn - spanY));
    x0 = minX + Math.round((x0 - minX) / drawStep) * drawStep;
    y0 = minY + Math.round((y0 - minY) / drawStep) * drawStep;
    return { k, drawStep, nx: grid.nx, ny: grid.ny, x0, y0, scale };
}

function fillLayerMesh(view, win) {
    const nx = win.nx;
    const ny = win.ny;
    const samples = new Float32Array(nx * ny * 7);
    const cover = new Uint8Array(nx * ny);
    let maxH = 0;
    const halfW = view.widthIn / 2;
    const halfD = view.depthIn / 2;
    for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
            const mx = Math.min(halfW, Math.max(-halfW, win.x0 + i * win.drawStep));
            const my = Math.min(halfD, Math.max(-halfD, win.y0 + j * win.drawStep));
            const sample = sourceSample(view, mx, my);
            const on = !!sample.covered;
            const h = on ? quantizeLayer(sample.h, view.baseIn, view.layerIn) : 0;
            const color = on ? layerColor(view, sample, mx, my) : PLATE_RGB;
            const at = (j * nx + i) * 7;
            samples[at] = mx;
            samples[at + 1] = h;
            samples[at + 2] = my;
            samples[at + 3] = color[0];
            samples[at + 4] = color[1];
            samples[at + 5] = color[2];
            samples[at + 6] = on ? 1 : 0;
            cover[j * nx + i] = on ? 1 : 0;
            if (on && h > maxH) maxH = h;
        }
    }
    const fullPlate = win.scale > 0.98
        && Math.abs(win.x0 + halfW) <= win.drawStep
        && Math.abs(win.y0 + halfD) <= win.drawStep;
    const cellsX = nx - 1;
    const cellsY = ny - 1;
    const quadOn = (i, j) => {
        if (i < 0 || j < 0 || i >= cellsX || j >= cellsY) return false;
        return cover[j * nx + i]
            && cover[j * nx + i + 1]
            && cover[(j + 1) * nx + i]
            && cover[(j + 1) * nx + i + 1];
    };
    let quads = 0;
    let walls = 0;
    for (let j = 0; j < cellsY; j += 1) {
        for (let i = 0; i < cellsX; i += 1) {
            if (!quadOn(i, j)) continue;
            quads += 1;
            const edge = (ni, nj, tileEdge) => {
                if (quadOn(ni, nj)) return;
                if (ni < 0 || nj < 0 || ni >= cellsX || nj >= cellsY) {
                    if (tileEdge) walls += 1;
                    return;
                }
                walls += 1;
            };
            edge(i, j - 1, fullPlate && j === 0);
            edge(i, j + 1, fullPlate && j === cellsY - 1);
            edge(i - 1, j, fullPlate && i === 0);
            edge(i + 1, j, fullPlate && i === cellsX - 1);
        }
    }
    const data = new Float32Array((quads * 6 + walls * 6) * 7);
    let offset = 0;
    const pushAt = (i, j) => {
        const at = (j * nx + i) * 7;
        data[offset] = samples[at];
        data[offset + 1] = samples[at + 1];
        data[offset + 2] = samples[at + 2];
        data[offset + 3] = samples[at + 3];
        data[offset + 4] = samples[at + 4];
        data[offset + 5] = samples[at + 5];
        data[offset + 6] = samples[at + 6];
        offset += 7;
    };
    const pushBase = (i, j) => {
        const at = (j * nx + i) * 7;
        data[offset] = samples[at];
        data[offset + 1] = 0;
        data[offset + 2] = samples[at + 2];
        data[offset + 3] = WALL_RGB[0];
        data[offset + 4] = WALL_RGB[1];
        data[offset + 5] = WALL_RGB[2];
        data[offset + 6] = 0;
        offset += 7;
    };
    const wall = (i0, j0, i1, j1) => {
        pushBase(i0, j0);
        pushBase(i1, j1);
        pushAt(i1, j1);
        pushBase(i0, j0);
        pushAt(i1, j1);
        pushAt(i0, j0);
    };
    for (let j = 0; j < cellsY; j += 1) {
        for (let i = 0; i < cellsX; i += 1) {
            if (!quadOn(i, j)) continue;
            pushAt(i, j);
            pushAt(i + 1, j);
            pushAt(i, j + 1);
            pushAt(i + 1, j);
            pushAt(i + 1, j + 1);
            pushAt(i, j + 1);
            if (!quadOn(i, j - 1) && (j > 0 || (fullPlate && j === 0))) wall(i, j, i + 1, j);
            if (!quadOn(i, j + 1) && (j + 1 < cellsY || (fullPlate && j === cellsY - 1))) wall(i + 1, j + 1, i, j + 1);
            if (!quadOn(i - 1, j) && (i > 0 || (fullPlate && i === 0))) wall(i, j + 1, i, j);
            if (!quadOn(i + 1, j) && (i + 1 < cellsX || (fullPlate && i === cellsX - 1))) wall(i + 1, j, i + 1, j + 1);
        }
    }
    if (offset !== data.length) throw new Error("The print mesh did not match the buffer outline.");
    return { data, count: offset / 7, maxH };
}

const SATELLITE_TILE_URL = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/";
const SATELLITE_MAX_ZOOM = 16;
const SATELLITE_MAX_TILES = 64;
const SATELLITE_PIXEL_BUDGET = 40000000;
const SATELLITE_MAX_SHEETS = 4;
const SATELLITE_MERCATOR = 156543.03392804097;
const satelliteTileCache = new Map();

function printImagePixels(widthIn, depthIn, pixelIn) {
    const step = pixelIn > 0 ? pixelIn : 1;
    return {
        pixelIn: step,
        nx: Math.max(2, Math.ceil(widthIn / step - 1e-6)),
        ny: Math.max(2, Math.ceil(depthIn / step - 1e-6)),
    };
}

function satelliteLayout(view, dolly, maxDim) {
    const pixelIn = view.layerIn;
    const scale = Math.min(1, Math.max(0.02, dolly));
    const spanX = view.widthIn * scale;
    const spanY = view.depthIn * scale;
    const limit = Math.max(256, maxDim || 4096);
    let chosen = null;
    let k = 1;
    while (k < 100000) {
        const step = pixelIn * k;
        const nx = Math.max(2, Math.ceil(spanX / step - 1e-6));
        const ny = Math.max(2, Math.ceil(spanY / step - 1e-6));
        const sheets = Math.ceil(nx / limit);
        if (ny <= limit && sheets <= SATELLITE_MAX_SHEETS && nx * ny <= SATELLITE_PIXEL_BUDGET) {
            chosen = { k, step, nx, ny, sheets };
            break;
        }
        k += 1;
    }
    if (!chosen) {
        const step = Math.max(pixelIn, Math.max(spanX, spanY) / limit);
        const sized = printImagePixels(spanX, spanY, step);
        chosen = { k: Math.ceil(step / pixelIn), step, nx: sized.nx, ny: sized.ny, sheets: 1 };
    }
    const widthIn = chosen.nx * chosen.step;
    const depthIn = chosen.ny * chosen.step;
    const minX = -view.widthIn / 2;
    const minY = -view.depthIn / 2;
    let originX = Math.min(Math.max(-spanX / 2, minX), Math.max(minX, minX + view.widthIn - widthIn));
    let originY = Math.min(Math.max(-spanY / 2, minY), Math.max(minY, minY + view.depthIn - depthIn));
    const sheetList = [];
    const base = Math.floor(chosen.nx / chosen.sheets);
    let extra = chosen.nx - base * chosen.sheets;
    let col = 0;
    for (let index = 0; index < chosen.sheets; index += 1) {
        const count = base + (extra > 0 ? 1 : 0);
        if (extra > 0) extra -= 1;
        sheetList.push({
            col,
            nx: count,
            ny: chosen.ny,
            originX: originX + col * chosen.step,
            originY,
            widthIn: count * chosen.step,
            depthIn,
        });
        col += count;
    }
    return { ...chosen, originX, originY, widthIn, depthIn, sheetList };
}

function satelliteBounds(view, layout) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (let j = 0; j <= 4; j += 1) {
        for (let i = 0; i <= 4; i += 1) {
            const mx = layout.originX + (layout.widthIn * i) / 4;
            const my = layout.originY + (layout.depthIn * j) / 4;
            const lnglat = modelInchesToLngLat(mx, my, view.fit);
            west = Math.min(west, lnglat[0]);
            east = Math.max(east, lnglat[0]);
            south = Math.min(south, lnglat[1]);
            north = Math.max(north, lnglat[1]);
        }
    }
    const padX = Math.max(1e-4, (east - west) * 0.02);
    const padY = Math.max(1e-4, (north - south) * 0.02);
    return {
        west: Math.max(-179.9, west - padX),
        south: Math.max(-85, south - padY),
        east: Math.min(179.9, east + padX),
        north: Math.min(85, north + padY),
    };
}

function satelliteWorldPixel(lng, lat, zoom) {
    const size = 256 * 2 ** zoom;
    const x = (lng + 180) / 360 * size;
    const s = Math.min(1, Math.max(-1, Math.sin(lat * Math.PI / 180)));
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
    return [x, y];
}

function satelliteTileRange(bounds, zoom) {
    const nw = satelliteWorldPixel(bounds.west, bounds.north, zoom);
    const se = satelliteWorldPixel(bounds.east, bounds.south, zoom);
    const limit = 2 ** zoom;
    const x0 = Math.max(0, Math.min(limit - 1, Math.floor(nw[0] / 256)));
    const x1 = Math.max(0, Math.min(limit - 1, Math.floor(se[0] / 256)));
    const y0 = Math.max(0, Math.min(limit - 1, Math.floor(nw[1] / 256)));
    const y1 = Math.max(0, Math.min(limit - 1, Math.floor(se[1] / 256)));
    const cols = Math.abs(x1 - x0) + 1;
    const rows = Math.abs(y1 - y0) + 1;
    return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1), cols, rows, count: cols * rows };
}

function chooseSatelliteZoom(bounds, groundM) {
    const lat = (bounds.south + bounds.north) / 2;
    const cos = Math.max(0.2, Math.abs(Math.cos(lat * Math.PI / 180)));
    let zoom = SATELLITE_MAX_ZOOM;
    if (groundM > 0) zoom = Math.ceil(Math.log2((SATELLITE_MERCATOR * cos) / groundM));
    zoom = Math.max(0, Math.min(SATELLITE_MAX_ZOOM, zoom));
    let range = satelliteTileRange(bounds, zoom);
    while ((range.count > SATELLITE_MAX_TILES || range.cols > 32 || range.rows > 32) && zoom > 0) {
        zoom -= 1;
        range = satelliteTileRange(bounds, zoom);
    }
    return { zoom, ...range };
}

function loadSatelliteTile(zoom, x, y) {
    const key = `${zoom}/${y}/${x}`;
    const cached = satelliteTileCache.get(key);
    if (cached) return cached;
    const pending = new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = SATELLITE_TILE_URL + key;
    });
    satelliteTileCache.set(key, pending);
    if (satelliteTileCache.size > 240) {
        const oldest = satelliteTileCache.keys().next().value;
        satelliteTileCache.delete(oldest);
    }
    return pending;
}

async function loadSatelliteMosaic(range, token) {
    const jobs = [];
    for (let y = range.y0; y <= range.y1; y += 1) {
        for (let x = range.x0; x <= range.x1; x += 1) jobs.push({ x, y });
    }
    const images = new Array(jobs.length);
    let cursor = 0;
    const worker = async () => {
        while (cursor < jobs.length) {
            if (token !== printViewToken) return;
            const index = cursor;
            cursor += 1;
            const job = jobs[index];
            images[index] = await loadSatelliteTile(range.zoom, job.x, job.y);
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    if (token !== printViewToken) return null;
    const canvas = document.createElement("canvas");
    canvas.width = range.cols * 256;
    canvas.height = range.rows * 256;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let drawn = 0;
    jobs.forEach((job, index) => {
        const img = images[index];
        if (!img) return;
        ctx.drawImage(img, (job.x - range.x0) * 256, (job.y - range.y0) * 256);
        drawn += 1;
    });
    if (!drawn) return null;
    let image;
    try {
        image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (error) {
        return null;
    }
    return {
        zoom: range.zoom,
        data: image.data,
        width: canvas.width,
        height: canvas.height,
        originX: range.x0 * 256,
        originY: range.y0 * 256,
    };
}

function sampleMosaic(mosaic, lng, lat) {
    const [px, py] = satelliteWorldPixel(lng, lat, mosaic.zoom);
    const x = px - mosaic.originX;
    const y = py - mosaic.originY;
    if (x < 0 || y < 0 || x >= mosaic.width - 1 || y >= mosaic.height - 1) return null;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const at = (col, row) => (row * mosaic.width + col) * 4;
    const p00 = at(x0, y0);
    const p10 = at(x0 + 1, y0);
    const p01 = at(x0, y0 + 1);
    const p11 = at(x0 + 1, y0 + 1);
    if (mosaic.data[p00 + 3] < 250) return null;
    const mix = (channel) => {
        const low = mosaic.data[p00 + channel] * (1 - tx) + mosaic.data[p10 + channel] * tx;
        const high = mosaic.data[p01 + channel] * (1 - tx) + mosaic.data[p11 + channel] * tx;
        return low * (1 - ty) + high * ty;
    };
    return [mix(0), mix(1), mix(2)];
}

function coarsePixelIndexes(count, cell) {
    const indexes = [];
    for (let index = 0; index < count; index += cell) indexes.push(index);
    if (indexes[indexes.length - 1] !== count - 1) indexes.push(count - 1);
    return indexes;
}

async function fillSatelliteSheet(view, sheet, step, mosaic, token) {
    const nx = sheet.nx;
    const ny = sheet.ny;
    const pixels = new Uint8Array(nx * ny * 4);
    const cell = 16;
    const xs = coarsePixelIndexes(nx, cell);
    const ys = coarsePixelIndexes(ny, cell);
    const gxN = xs.length;
    const gyN = ys.length;
    const lngs = new Float64Array(gxN * gyN);
    const lats = new Float64Array(gxN * gyN);
    const cover = new Uint8Array(gxN * gyN);
    const flat = new Uint8Array(gxN * gyN);
    const shade = new Float32Array(gxN * gyN);
    for (let j = 0; j < gyN; j += 1) {
        for (let i = 0; i < gxN; i += 1) {
            const mx = sheet.originX + xs[i] * step;
            const my = sheet.originY + ys[j] * step;
            const lnglat = modelInchesToLngLat(mx, my, view.fit);
            const at = j * gxN + i;
            lngs[at] = lnglat[0];
            lats[at] = lnglat[1];
            const sample = sourceSample(view, mx, my);
            cover[at] = sample.covered ? 1 : 0;
            flat[at] = sample.flat ? 1 : 0;
            shade[at] = sample.covered && !sample.flat && Number.isFinite(sample.elev)
                ? layerShade(view, mx, my, sample.elev)
                : 1;
        }
        if ((j & 3) === 3) {
            if (token !== printViewToken) return null;
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    let hit = 0;
    let coveredCount = 0;
    const paint = (x, y, rgb) => {
        const dest = (y * nx + x) * 4;
        pixels[dest] = rgb[0];
        pixels[dest + 1] = rgb[1];
        pixels[dest + 2] = rgb[2];
        pixels[dest + 3] = 255;
    };
    const plate = [214, 210, 202];
    for (let gy = 0; gy < gyN - 1; gy += 1) {
        if (token !== printViewToken) return null;
        const y0 = ys[gy];
        const y1 = ys[gy + 1];
        const yStop = gy === gyN - 2 ? y1 + 1 : y1;
        for (let gx = 0; gx < gxN - 1; gx += 1) {
            const x0 = xs[gx];
            const x1 = xs[gx + 1];
            const xStop = gx === gxN - 2 ? x1 + 1 : x1;
            const i00 = gy * gxN + gx;
            const i10 = i00 + 1;
            const i01 = i00 + gxN;
            const i11 = i01 + 1;
            const blockCover = cover[i00] + cover[i10] + cover[i01] + cover[i11];
            const blockFlat = flat[i00] + flat[i10] + flat[i01] + flat[i11];
            if (blockCover === 0) {
                for (let y = y0; y < yStop; y += 1) {
                    for (let x = x0; x < xStop; x += 1) paint(x, y, plate);
                }
                continue;
            }
            const uniform = blockCover === 4 && (blockFlat === 0 || blockFlat === 4);
            for (let y = y0; y < yStop; y += 1) {
                const ty = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
                for (let x = x0; x < xStop; x += 1) {
                    const tx = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
                    if (!uniform) {
                        const sample = sourceSample(view, sheet.originX + x * step, sheet.originY + y * step);
                        if (!sample.covered) {
                            paint(x, y, plate);
                            continue;
                        }
                    }
                    coveredCount += 1;
                    const lng = (lngs[i00] * (1 - tx) + lngs[i10] * tx) * (1 - ty)
                        + (lngs[i01] * (1 - tx) + lngs[i11] * tx) * ty;
                    const lat = (lats[i00] * (1 - tx) + lats[i10] * tx) * (1 - ty)
                        + (lats[i01] * (1 - tx) + lats[i11] * tx) * ty;
                    const photo = sampleMosaic(mosaic, lng, lat);
                    if (!photo) {
                        paint(x, y, plate);
                        continue;
                    }
                    hit += 1;
                    let light = 1;
                    if (uniform && blockFlat === 0) {
                        light = (shade[i00] * (1 - tx) + shade[i10] * tx) * (1 - ty)
                            + (shade[i01] * (1 - tx) + shade[i11] * tx) * ty;
                    } else if (!uniform) {
                        const sample = sourceSample(view, sheet.originX + x * step, sheet.originY + y * step);
                        if (!sample.flat && Number.isFinite(sample.elev)) light = layerShade(view, sheet.originX + x * step, sheet.originY + y * step, sample.elev);
                    }
                    paint(x, y, [
                        Math.max(0, Math.min(255, photo[0] * light)),
                        Math.max(0, Math.min(255, photo[1] * light)),
                        Math.max(0, Math.min(255, photo[2] * light)),
                    ]);
                }
            }
        }
        if ((gy & 3) === 3) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { pixels, hit, covered: coveredCount };
}

async function buildSatelliteSheets(view, layout, token) {
    if (!view.fit) return null;
    const bounds = satelliteBounds(view, layout);
    const range = chooseSatelliteZoom(bounds, layout.step * view.metersPerInch);
    const mosaic = await loadSatelliteMosaic(range, token);
    if (!mosaic || token !== printViewToken) return null;
    const built = [];
    let hit = 0;
    let covered = 0;
    for (let index = 0; index < layout.sheetList.length; index += 1) {
        const sheet = layout.sheetList[index];
        const filled = await fillSatelliteSheet(view, sheet, layout.step, mosaic, token);
        if (!filled || token !== printViewToken) return null;
        hit += filled.hit;
        covered += filled.covered;
        built.push({ ...sheet, pixels: filled.pixels });
    }
    if (!(hit > 0) || hit < covered * 0.5) return { failed: true };
    return { sheets: built, zoom: range.zoom, k: layout.k, step: layout.step, originX: layout.originX, originY: layout.originY, widthIn: layout.widthIn, depthIn: layout.depthIn };
}

function showLayerModel(view) {
    const generation = ++printGeneration;
    const canvas = document.getElementById("print-view");
    const note = document.getElementById("print-status");
    if (!canvas) return;
    canvas.hidden = false;
    if (printFrame) cancelAnimationFrame(printFrame);
    clearPrintPointer(canvas);
    const gl = canvas.getContext("webgl", { antialias: true, preserveDrawingBuffer: true });
    if (!gl) {
        if (note) note.textContent = "This browser has no WebGL view of the print model.";
        return;
    }
    const vertexSrc = `
        attribute vec3 aPos;
        attribute vec3 aColor;
        attribute float aImage;
        uniform mat4 uMvp;
        varying vec3 vColor;
        varying vec2 vInch;
        varying float vImage;
        void main() {
            vColor = aColor;
            vInch = aPos.xz;
            vImage = aImage;
            gl_Position = uMvp * vec4(aPos, 1.0);
        }`;
    const fragmentSrc = `
        precision mediump float;
        varying vec3 vColor;
        varying vec2 vInch;
        varying float vImage;
        uniform sampler2D uSat0;
        uniform sampler2D uSat1;
        uniform sampler2D uSat2;
        uniform sampler2D uSat3;
        uniform vec4 uStrip0;
        uniform vec4 uStrip1;
        uniform vec4 uStrip2;
        uniform vec4 uStrip3;
        uniform float uSheets;
        uniform float uHasImage;
        void main() {
            vec4 c0 = texture2D(uSat0, (vInch - uStrip0.xy) / max(uStrip0.zw, vec2(0.0001)));
            vec4 c1 = texture2D(uSat1, (vInch - uStrip1.xy) / max(uStrip1.zw, vec2(0.0001)));
            vec4 c2 = texture2D(uSat2, (vInch - uStrip2.xy) / max(uStrip2.zw, vec2(0.0001)));
            vec4 c3 = texture2D(uSat3, (vInch - uStrip3.xy) / max(uStrip3.zw, vec2(0.0001)));
            vec4 color = c0;
            if (uSheets > 1.5 && vInch.x >= uStrip1.x) color = c1;
            if (uSheets > 2.5 && vInch.x >= uStrip2.x) color = c2;
            if (uSheets > 3.5 && vInch.x >= uStrip3.x) color = c3;
            if (!(uHasImage > 0.5 && vImage > 0.5)) color = vec4(vColor, 1.0);
            gl_FragColor = color;
        }`;
    const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
        return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSrc));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        if (note) note.textContent = "This browser has no WebGL view of the print model.";
        return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = 28;
    const posLoc = gl.getAttribLocation(program, "aPos");
    const colorLoc = gl.getAttribLocation(program, "aColor");
    const imageLoc = gl.getAttribLocation(program, "aImage");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(imageLoc);
    gl.vertexAttribPointer(imageLoc, 1, gl.FLOAT, false, stride, 24);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.957, 0.957, 0.957, 1);
    const mvpLoc = gl.getUniformLocation(program, "uMvp");
    let dolly = 1;
    let yaw = 0.7;
    let polar = 1.05;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let meshKey = "";
    let count = 0;
    let maxH = view.baseIn;
    const rebuild = () => {
        const win = planLayerWindow(view, dolly);
        const key = [win.k, win.nx, win.ny, win.x0.toFixed(3), win.y0.toFixed(3)].join(":");
        if (key === meshKey) return;
        meshKey = key;
        const built = fillLayerMesh(view, win);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, built.data, gl.STATIC_DRAW);
        gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, stride, 0);
        gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, stride, 12);
        gl.vertexAttribPointer(imageLoc, 1, gl.FLOAT, false, stride, 24);
        count = built.count;
        maxH = built.maxH;
    };
    const maxDim = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096);
    const textures = [gl.createTexture(), gl.createTexture(), gl.createTexture(), gl.createTexture()];
    const blankSatelliteTexture = (tex) => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array([214, 210, 202, 255, 214, 210, 202, 255, 214, 210, 202, 255, 214, 210, 202, 255]),
        );
    };
    const samplerLocs = [0, 1, 2, 3].map((index) => gl.getUniformLocation(program, `uSat${index}`));
    const stripLocs = [0, 1, 2, 3].map((index) => gl.getUniformLocation(program, `uStrip${index}`));
    const sheetsLoc = gl.getUniformLocation(program, "uSheets");
    const hasLoc = gl.getUniformLocation(program, "uHasImage");
    textures.forEach((tex, index) => {
        gl.activeTexture(gl.TEXTURE0 + index);
        blankSatelliteTexture(tex);
        gl.uniform1i(samplerLocs[index], index);
        gl.uniform4f(stripLocs[index], 0, 0, 1, 1);
    });
    gl.uniform1f(sheetsLoc, 0);
    gl.uniform1f(hasLoc, 0);
    let held = null;
    let imageSerial = 0;
    let imageTimer = 0;
    const applySatellite = (built, layout) => {
        if (generation !== printGeneration || !built || !built.sheets) return;
        gl.getError();
        built.sheets.forEach((sheet, index) => {
            gl.activeTexture(gl.TEXTURE0 + index);
            gl.bindTexture(gl.TEXTURE_2D, textures[index]);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sheet.nx, sheet.ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, sheet.pixels);
            gl.uniform4f(stripLocs[index], sheet.originX, sheet.originY, sheet.widthIn, sheet.depthIn);
        });
        for (let index = built.sheets.length; index < 4; index += 1) {
            gl.activeTexture(gl.TEXTURE0 + index);
            blankSatelliteTexture(textures[index]);
            gl.uniform4f(stripLocs[index], 0, 0, 1, 1);
        }
        if (gl.getError() !== gl.NO_ERROR) {
            gl.uniform1f(hasLoc, 0);
            if (note) note.textContent = "The satellite image is too large for this browser.";
            return;
        }
        gl.uniform1f(sheetsLoc, built.sheets.length);
        gl.uniform1f(hasLoc, 1);
        held = layout;
        if (note) note.textContent = satelliteStatus(view.layerMm, view.satelliteTarget, layout);
    };
    const refreshSatellite = () => {
        if (view.colorMode !== "satellite" || !view.satelliteTarget) return;
        const layout = satelliteLayout(view, dolly, maxDim);
        if (held && held.step <= layout.step + 1e-9
            && layout.originX >= held.originX - held.step
            && layout.originY >= held.originY - held.step
            && layout.originX + layout.widthIn <= held.originX + held.widthIn + held.step
            && layout.originY + layout.depthIn <= held.originY + held.depthIn + held.step) return;
        const serial = ++imageSerial;
        const token = printViewToken;
        buildSatelliteSheets(view, layout, token).then((built) => {
            if (serial !== imageSerial || generation !== printGeneration || token !== printViewToken) return;
            if (!built || built.failed) {
                if (note) note.textContent = "The satellite image did not load. The model is shown without it.";
                return;
            }
            applySatellite(built, layout);
        }).catch(() => {
            if (serial === imageSerial && note) note.textContent = "The satellite image did not load. The model is shown without it.";
        });
    };
    const scheduleSatellite = () => {
        if (view.colorMode !== "satellite") return;
        clearTimeout(imageTimer);
        imageTimer = setTimeout(() => {
            if (generation === printGeneration) refreshSatellite();
        }, 80);
    };
    canvas.onpointerdown = (event) => {
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
    };
    canvas.onpointermove = (event) => {
        if (!dragging) return;
        yaw += (event.clientX - lastX) * 0.01;
        polar = Math.min(1.4, Math.max(0.2, polar + (event.clientY - lastY) * 0.01));
        lastX = event.clientX;
        lastY = event.clientY;
    };
    canvas.onpointerup = () => {
        dragging = false;
    };
    const onWheel = (event) => {
        event.preventDefault();
        dolly = Math.min(1, Math.max(0.02, dolly * (event.deltaY > 0 ? 1.12 : 0.89)));
        rebuild();
        scheduleSatellite();
    };
    canvas._printWheel = onWheel;
    canvas.addEventListener("wheel", onWheel, { passive: false });
    rebuild();
    if (view.colorMode === "satellite" && note && view.satelliteTarget) {
        note.textContent = `Rendering the satellite image, ${view.satelliteTarget.nx} by ${view.satelliteTarget.ny} pixels.`;
        scheduleSatellite();
    }
    const draw = () => {
        if (generation !== printGeneration) return;
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        gl.viewport(0, 0, canvas.width, canvas.height);
        const radius = Math.max(view.widthIn, view.depthIn) * 0.95 * dolly;
        const eye = [
            radius * Math.sin(polar) * Math.sin(yaw),
            Math.cos(polar) * radius * 0.55 + maxH,
            radius * Math.sin(polar) * Math.cos(yaw),
        ];
        const viewMatrix = lookAt4(eye, [0, maxH * 0.5, 0], [0, 1, 0]);
        const projection = perspective4(0.65, canvas.width / canvas.height, Math.max(0.05, radius * 0.01), radius * 8 + view.widthIn);
        gl.uniformMatrix4fv(mvpLoc, false, new Float32Array(multiply4(projection, viewMatrix)));
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, count);
        printFrame = requestAnimationFrame(draw);
    };
    draw();
}

function showPrintModel(field) {
    const generation = ++printGeneration;
    const panel = document.getElementById("print-model");
    const canvas = document.getElementById("print-view");
    const note = document.getElementById("print-status");
    if (!panel || !canvas) return;
    panel.hidden = false;
    canvas.hidden = false;
    clearPrintPointer(canvas);
    if (printFrame) cancelAnimationFrame(printFrame);
    const gl = canvas.getContext("webgl", { antialias: true, preserveDrawingBuffer: true });
    if (!gl) {
        if (note) note.textContent = "This browser has no WebGL view of the print model.";
        return;
    }
    const nx = field.samples_x;
    const ny = field.samples_y;
    const heights = field.heights_in;
    if (!nx || !ny || !heights || heights.length < 2) return;
    const widthIn = field.cols * field.square_in;
    const depthIn = field.rows * field.square_in;
    let minH = Infinity;
    let maxH = -Infinity;
    const present = (i, j) => {
        const h = heights[j] && heights[j][i];
        return Number.isFinite(h) && h > 1e-4;
    };
    heights.forEach((row) => row.forEach((value) => {
        if (!Number.isFinite(value) || value <= 1e-4) return;
        minH = Math.min(minH, value);
        maxH = Math.max(maxH, value);
    }));
    if (!Number.isFinite(minH)) return;
    const span = Math.max(1e-6, maxH - minH);
    const positions = [];
    const colors = [];
    const at = (i, j) => {
        const h = heights[j][i];
        const baseCut = Number(field.base_in);
        const flatAt = (Number.isFinite(baseCut) ? baseCut : 2.6 / MM_PER_IN) + 0.01;
        const tone = h <= flatAt ? 0 : (h - minH) / span;
        const painted = field.colors && field.colors[j] && field.colors[j][i];
        return [
            (i / (nx - 1) - 0.5) * widthIn,
            h,
            (j / (ny - 1) - 0.5) * depthIn,
            painted ? painted[0] : (h <= flatAt ? 0.78 : 0.42 + 0.34 * tone),
            painted ? painted[1] : (h <= flatAt ? 0.76 : 0.36 + 0.08 * (1 - tone)),
            painted ? painted[2] : (h <= flatAt ? 0.72 : 0.22),
        ];
    };
    const tri = (a, b, c) => {
        [a, b, c].forEach((vert) => {
            positions.push(vert[0], vert[1], vert[2]);
            colors.push(vert[3], vert[4], vert[5]);
        });
    };
    const cellsX = nx - 1;
    const cellsY = ny - 1;
    const quadOn = (i, j) => i >= 0 && j >= 0 && i < cellsX && j < cellsY
        && present(i, j) && present(i + 1, j) && present(i, j + 1) && present(i + 1, j + 1);
    const baseOf = (vert) => [vert[0], 0, vert[2], 0.75, 0.73, 0.7];
    const wall = (p, q) => {
        const pb = baseOf(p);
        const qb = baseOf(q);
        tri(pb, qb, q);
        tri(pb, q, p);
    };
    for (let j = 0; j < cellsY; j += 1) {
        for (let i = 0; i < cellsX; i += 1) {
            if (!quadOn(i, j)) continue;
            const sw = at(i, j);
            const se = at(i + 1, j);
            const nw = at(i, j + 1);
            const ne = at(i + 1, j + 1);
            tri(sw, se, nw);
            tri(se, ne, nw);
            if (!quadOn(i, j - 1)) wall(sw, se);
            if (!quadOn(i, j + 1)) wall(ne, nw);
            if (!quadOn(i - 1, j)) wall(nw, sw);
            if (!quadOn(i + 1, j)) wall(se, ne);
        }
    }
    const vertexSrc = `
        attribute vec3 aPos;
        attribute vec3 aColor;
        uniform mat4 uMvp;
        varying vec3 vColor;
        void main() {
            vColor = aColor;
            gl_Position = uMvp * vec4(aPos, 1.0);
        }`;
    const fragmentSrc = `
        precision mediump float;
        varying vec3 vColor;
        void main() {
            gl_FragColor = vec4(vColor, 1.0);
        }`;
    const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(shader));
        return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSrc));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSrc));
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    const interleaved = new Float32Array(positions.length / 3 * 6);
    for (let index = 0; index < positions.length / 3; index += 1) {
        interleaved[index * 6] = positions[index * 3];
        interleaved[index * 6 + 1] = positions[index * 3 + 1];
        interleaved[index * 6 + 2] = positions[index * 3 + 2];
        interleaved[index * 6 + 3] = colors[index * 3];
        interleaved[index * 6 + 4] = colors[index * 3 + 1];
        interleaved[index * 6 + 5] = colors[index * 3 + 2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
    const stride = 24;
    const posLoc = gl.getAttribLocation(program, "aPos");
    const colorLoc = gl.getAttribLocation(program, "aColor");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, stride, 12);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.957, 0.957, 0.957, 1);
    const mvpLoc = gl.getUniformLocation(program, "uMvp");
    const count = positions.length / 3;
    let yaw = 0.7;
    let polar = 1.05;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    canvas.onpointerdown = (event) => {
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
    };
    canvas.onpointermove = (event) => {
        if (!dragging) return;
        yaw += (event.clientX - lastX) * 0.01;
        polar = Math.min(1.4, Math.max(0.2, polar + (event.clientY - lastY) * 0.01));
        lastX = event.clientX;
        lastY = event.clientY;
    };
    canvas.onpointerup = () => {
        dragging = false;
    };
    const draw = () => {
        if (generation !== printGeneration) return;
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        gl.viewport(0, 0, canvas.width, canvas.height);
        const radius = Math.max(widthIn, depthIn) * 0.95;
        const eye = [
            radius * Math.sin(polar) * Math.sin(yaw),
            Math.cos(polar) * radius * 0.55 + maxH,
            radius * Math.sin(polar) * Math.cos(yaw),
        ];
        const view = lookAt4(eye, [0, maxH * 0.5, 0], [0, 1, 0]);
        const projection = perspective4(0.65, canvas.width / canvas.height, 0.5, radius * 6);
        gl.uniformMatrix4fv(mvpLoc, false, new Float32Array(multiply4(projection, view)));
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, count);
        printFrame = requestAnimationFrame(draw);
    };
    draw();
    if (note) note.textContent = "This is the print model. Drag to turn it.";
}

function bootWatershedPage() {
    loadFineBook().catch(() => {});
    const state = {
        rates: null,
        boundaries: [],
        catalog: null,
        geomCache: new Map(),
        chooseToken: 0,
        feature: null,
        method: "catalog",
        pourPoint: null,
        squareCount: 4,
        bufferIn: 0.5,
        baseMm: 2.6,
        baseManual: false,
        isuAffiliated: false,
        alignment: "north",
        fit: null,
        squares: new Set(),
        scale: null,
        color: "topo",
        resolution: DEM_RESOLUTIONS[0],
        resolutionManual: false,
        ramp: "cd-a",
        rampScale: "conus",
        rampBook: null,
        projection: "utm",
        utmZoneManual: false,
        printCrs: null,
        exaggeration: 1,
        elevGrid: null,
        reliefImage: null,
        elevLoading: null,
        elevMiss: null,
        elevMissText: null,
        elevMissResolution: null,
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
        orderBusy: false,
    };

    let map = null;
    try {
        map = new maplibregl.Map({
            container: "map",
            style: mapStyle("topo", "cd-a"),
            center: [-92.50444, 41.83999],
            zoom: 10,
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
    }

    loadMenu().catch((error) => console.error(error));
    Promise.all([
        loadJSON("../data/watershed-model.json"),
        loadJSON(assetPath("data/ramps.json")),
        loadJSON(assetPath("data/zip-centroids.json")).catch(() => null),
        loadJSON(assetPath("data/boundaries/index.json?v=20261013b")).catch(() => null),
    ]).then(async ([rates, rampBook, zips, catalog]) => {
        state.rates = rates;
        state.zips = zips;
        state.catalog = catalog && catalog.rows ? catalog : null;
        const catalogNote = document.getElementById("catalog-note");
        if (catalogNote) catalogNote.textContent = (catalog && catalog.about) || "";
        state.rampBook = rampBook;
        state.ramp = rampBook.default || "cd-a";
        document.getElementById("intro").textContent = rates.intro;
        document.getElementById("kit-note").textContent = rates.kits_intro || "";
        buildColorButtons();
        buildResolutionSelect();
        buildRampSelect();
        buildPrintControls();
        buildKitControls();
        const response = await fetch(assetPath(rates.boundaries_url));
        const collection = response.ok ? await response.json() : { features: [] };
        state.boundaries = (collection.features || []).filter((feature) => feature.geometry
            && (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon"));
        renderResults("");
        const preferred = state.boundaries.find((feature) => {
            const props = feature.properties || {};
            return String(props.code || props.id || "") === DEFAULT_HUC;
        });
        if (preferred) adoptFeature(preferred);
        else if (state.catalog && state.catalog.rows) {
            const row = state.catalog.rows.find((item) => String(item[1]) === DEFAULT_HUC);
            if (row) chooseCatalog(row);
            else if (state.boundaries[0]) adoptFeature(state.boundaries[0]);
            else render();
        } else if (state.boundaries[0]) adoptFeature(state.boundaries[0]);
        else render();
    }).catch((error) => {
        document.getElementById("map-note").textContent = "The model rates did not load.";
        console.error(error);
    });

    document.getElementById("basin-search").addEventListener("input", (event) => renderResults(event.target.value));
    document.getElementById("square-count").addEventListener("input", (event) => {
        const next = Math.floor(finite(event.target.value) || 1);
        state.squareCount = Math.max(1, Math.min(state.rates ? state.rates.max_squares || 100 : 100, next));
        if (!state.baseManual) {
            state.baseMm = defaultBaseMm(state.squareCount);
            const base = document.getElementById("base-mm");
            if (base && document.activeElement !== base) base.value = String(state.baseMm);
        }
        render();
    });
    document.getElementById("buffer-in").addEventListener("input", (event) => {
        const raw = event.target.value.trim();
        if (!raw || raw === "." || raw.endsWith(".")) return;
        const next = Number(raw);
        if (!Number.isFinite(next)) return;
        state.bufferIn = Math.min(3, Math.max(0, next));
        render();
    });
    document.getElementById("buffer-in").addEventListener("change", (event) => {
        state.bufferIn = clampBufferIn(event.target.value);
        event.target.value = String(state.bufferIn);
        render();
    });
    document.getElementById("base-mm").addEventListener("input", (event) => {
        const raw = event.target.value.trim();
        if (!raw || raw === "." || raw.endsWith(".")) return;
        const next = Number(raw);
        if (!Number.isFinite(next)) return;
        state.baseManual = true;
        state.baseMm = Math.min(40, Math.max(2, next));
        render();
    });
    document.getElementById("base-mm").addEventListener("change", (event) => {
        const raw = event.target.value.trim();
        if (!raw) {
            state.baseManual = false;
            state.baseMm = defaultBaseMm(state.squareCount);
        } else {
            state.baseManual = true;
            state.baseMm = clampBaseMm(raw, state.squareCount);
        }
        event.target.value = String(state.baseMm);
        render();
    });
    document.getElementById("isu-affiliated").addEventListener("change", (event) => {
        state.isuAffiliated = event.target.checked;
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
    document.getElementById("dem-resolution").addEventListener("change", (event) => {
        const next = Number(event.target.value);
        if (!DEM_RESOLUTIONS.includes(next)) return;
        state.resolutionManual = true;
        state.resolution = next;
        render();
    });
    document.getElementById("dem-ramp").addEventListener("change", (event) => {
        state.ramp = event.target.value;
        state.reliefImage = null;
        render();
    });
    document.getElementById("ramp-conus").addEventListener("click", () => {
        state.rampScale = "conus";
        state.reliefImage = null;
        render();
    });
    document.getElementById("ramp-watershed").addEventListener("click", () => {
        state.rampScale = "watershed";
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
    document.getElementById("order-btn").addEventListener("click", () => {
        recordOrder().catch((error) => {
            console.error(error);
            const status = document.getElementById("print-status");
            if (status) status.textContent = "The order was not recorded.";
            state.orderBusy = false;
            syncOrderButton();
        });
    });
    document.getElementById("render-model").addEventListener("click", () => {
        renderWatershed().catch((error) => {
            console.error(error);
            const status = document.getElementById("print-status");
            if (status) status.textContent = "The watershed view could not be rendered.";
            const button = document.getElementById("render-model");
            if (button) button.disabled = false;
        });
    });

    async function renderWatershed() {
        const button = document.getElementById("render-model");
        const note = document.getElementById("print-status");
        const form = readForm();
        if (!form.elevGrid || !form.fit) {
            const canvas = document.getElementById("print-view");
            if (canvas) canvas.hidden = true;
            if (note) note.textContent = "The elevation has not loaded, so there is nothing to render.";
            return;
        }
        const grade = form.rates && form.rates.print && form.rates.print.grades
            ? form.rates.print.grades[form.grade]
            : null;
        const layerMm = grade ? Number(grade.layer_mm) : NaN;
        if (!(layerMm > 0)) {
            if (note) note.textContent = "Choose a print quality before rendering.";
            return;
        }
        const signature = viewSignature(state);
        const token = ++printViewToken;
        printBuildSignature = signature;
        if (button) button.disabled = true;
        if (note) note.textContent = `Rendering the ${layerMm.toFixed(2)} mm surface.`;
        try {
            const ramp = activeRamp();
            const colored = state.color === "dem" || state.color === "white";
            const field = await buildViewField(form, token, {
                layerMm,
                colorMode: state.color === "satellite" ? "satellite" : (colored ? "ramp" : "plain"),
                stops: colored && ramp ? stopsForPaint(ramp) : null,
            });
            if (token !== printViewToken || !field) return;
            if (viewSignature(state) !== signature) {
                hidePrintView("The settings changed. Render the watershed flow model again.");
                return;
            }
            printBuildSignature = null;
            printViewMark = signature;
            showLayerModel(field);
            if (note && state.color !== "satellite") note.textContent = layerViewStatus(layerMm, state.color);
        } catch (error) {
            console.error(error);
            if (token === printViewToken && note) note.textContent = "The watershed view could not be rendered.";
        } finally {
            if (button) button.disabled = false;
        }
    }

    function buildPrintControls() {
        const spec = (state.rates && state.rates.print) || {};
        const materialSelect = document.getElementById("print-material");
        const gradeSelect = document.getElementById("print-grade");
        const materials = spec.materials || {};
        const grades = spec.grades || {};
        materialSelect.innerHTML = Object.entries(materials).map(([id, item]) => (
            `<option value="${escapeHtml(id)}">${escapeHtml(item.label)}</option>`
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
                `<li>${escapeHtml(item.name)}</li>`
            )).join("");
            return `<div class="kit-block">
                <h3>${escapeHtml(kit.label)}</h3>
                <ul class="kit-lines">${lines}</ul>
                <label for="kit-${escapeHtml(kit.id)}">Quantity</label>
                <input id="kit-${escapeHtml(kit.id)}" data-kit="${escapeHtml(kit.id)}" type="number" min="0" max="20" step="1" value="0">
            </div>`;
        }).join("");
        host.querySelectorAll("input[data-kit]").forEach((input) => {
            state.kitQty[input.dataset.kit] = 0;
            const apply = () => {
                const next = Math.floor(finite(input.value) || 0);
                state.kitQty[input.dataset.kit] = Math.max(0, Math.min(20, next));
                render();
            };
            input.addEventListener("input", apply);
            input.addEventListener("change", () => {
                apply();
                input.value = String(state.kitQty[input.dataset.kit]);
            });
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
        state.resolutionManual = false;
        if (state.color === "topo" && !centroidInUS(feature)) state.color = "dem";
        const rows = state.zips && state.zips.rows;
        const zip = rows ? nearestZip(rows, featureCenter(feature)[0], featureCenter(feature)[1]) : "";
        if (zip) {
            state.postal = zip;
            document.getElementById("postal").value = zip;
        }
        render();
    }

    function geomUrl(row) {
        const spec = state.catalog && state.catalog.geom && state.catalog.geom[String(row[0])];
        if (!spec) return "";
        if (spec.endsWith("/")) {
            const digits = Number(state.catalog.prefix && state.catalog.prefix[String(row[0])]) || 2;
            return `data/boundaries/${spec}${String(row[1]).slice(0, digits)}.json`;
        }
        return `data/boundaries/${spec}`;
    }

    function geometryFor(row) {
        const url = geomUrl(row);
        if (!url) return Promise.reject(new Error("no geometry file"));
        let pending = state.geomCache.get(url);
        if (!pending) {
            pending = loadJSON(assetPath(url)).then((collection) => {
                const found = new Map();
                (collection.features || []).forEach((feature) => {
                    const code = feature.properties && feature.properties.code;
                    if (code && feature.geometry) found.set(String(code), feature.geometry);
                });
                return found;
            }).catch((error) => {
                state.geomCache.delete(url);
                throw error;
            });
            state.geomCache.set(url, pending);
        }
        return pending.then((found) => {
            const geometry = found.get(String(row[1]));
            if (!geometry) throw new Error("missing geometry");
            return geometry;
        });
    }

    function featureFromRow(row, geometry) {
        return {
            type: "Feature",
            properties: {
                id: String(row[1]),
                name: row[2],
                level: HUC_LABEL[row[0]] || String(row[0]),
                code: String(row[1]),
                states: row[3] || "",
                area_km2: row[4],
                dataset: "us-wbd",
            },
            geometry,
        };
    }

    function chooseCatalog(row) {
        const token = state.chooseToken + 1;
        state.chooseToken = token;
        const note = document.getElementById("catalog-note");
        if (note) note.textContent = `Loading ${row[2]}…`;
        geometryFor(row).then((geometry) => {
            if (state.chooseToken !== token) return;
            state.method = "catalog";
            adoptFeature(featureFromRow(row, geometry));
            if (note) note.textContent = (state.catalog && state.catalog.about) || "";
        }).catch(() => {
            if (state.chooseToken !== token) return;
            if (note) note.textContent = "That watershed outline did not load.";
        });
    }

    function renderExampleResults(query) {
        const list = document.getElementById("basin-results");
        const text = query.trim().toLowerCase();
        const matches = state.boundaries.filter((feature, index) => featureName(feature, index).toLowerCase().includes(text)).slice(0, 20);
        if (!state.boundaries.length) {
            list.innerHTML = "<li class='field-note'>The boundary dataset is empty.</li>";
            return;
        }
        list.innerHTML = matches.map((feature) => {
            const name = featureName(feature, state.boundaries.indexOf(feature));
            return `<li><button type="button" data-index="${state.boundaries.indexOf(feature)}">${escapeHtml(name)}</button></li>`;
        }).join("") || "<li class='field-note'>No basin matches that name.</li>";
        list.querySelectorAll("button").forEach((button) => {
            button.addEventListener("click", () => {
                state.method = "catalog";
                adoptFeature(state.boundaries[Number(button.dataset.index)]);
            });
        });
    }

    function renderResults(query) {
        const list = document.getElementById("basin-results");
        if (!state.catalog) {
            renderExampleResults(query);
            return;
        }
        const text = query.trim();
        if (text.length < 2) {
            list.innerHTML = "<li class='field-note'>Type a watershed name or a HUC code.</li>";
            return;
        }
        const matches = catalogMatches(state.catalog.rows, text);
        if (!matches.length) {
            list.innerHTML = "<li class='field-note'>No watershed matches that name or code.</li>";
            return;
        }
        list.innerHTML = matches.map((row, index) => {
            const level = HUC_LABEL[row[0]] || row[0];
            const where = row[3] ? ` · ${row[3]}` : "";
            const area = Number.isFinite(row[4]) ? ` · ${Number(row[4]).toLocaleString("en-US")} km²` : "";
            const label = `${row[2]} · ${level} ${row[1]}${where}${area}`;
            return `<li><button type="button" data-index="${index}">${escapeHtml(label)}</button></li>`;
        }).join("");
        list.querySelectorAll("button").forEach((button) => {
            button.addEventListener("click", () => chooseCatalog(matches[Number(button.dataset.index)]));
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
            state.bufferIn,
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
            note.textContent = "Choose a basin to set the 3D print projection. The map stays Web Mercator.";
            return;
        }
        const grid = state.elevGrid;
        const matched = grid && grid.crs && sameCrs(crs, grid.crs);
        if (matched && grid.resolution_m) {
            note.textContent = `3D print projection: ${crs.label}. The map is Web Mercator.`;
            return;
        }
        const sample = grid && grid.resolution_m ? ` Elevation sample: ${grid.resolution_m} m.` : "";
        note.textContent = `3D print projection: ${crs.label}.${sample} The map is Web Mercator. The squares are this model's footprint.`;
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

    function rampLimits() {
        return rampRange(state.rampBook, state.rampScale, state.elevGrid);
    }

    function stopsForPaint(ramp) {
        const limits = rampLimits();
        if (!ramp || limits.mode !== "watershed") return ramp ? ramp.stops : null;
        return scaleRampStops(ramp.stops, limits.conusLow, limits.conusHigh, limits.low, limits.high);
    }

    function buildResolutionSelect() {
        const select = document.getElementById("dem-resolution");
        select.innerHTML = DEM_RESOLUTIONS.map((resolution) => (
            `<option value="${resolution}">${escapeHtml(resolutionLabel(resolution))}</option>`
        )).join("");
        select.value = String(state.resolution);
    }

    function missingGridText() {
        return `The ${resolutionLabel(state.resolution)} print grid for this basin is not on the site yet. The map still shows the 5 km DEM overview.`;
    }

    function gridLimitText(error, resolution) {
        const label = resolutionLabel(resolution);
        if (error && error.message === "grid size") {
            const counted = error.basinCells > 0
                ? `about ${cellCountText(error.basinCells)} cells at ${label}, above the 4,000,000 cell limit, `
                : `above 4,000,000 cells at ${label}, `;
            return `This basin is ${counted}so that print grid stays unloaded. The map still shows the 5 km DEM overview.`;
        }
        if (error && error.message === "grid box") {
            const box = error.boxCells > 0 ? cellCountText(error.boxCells) : "too many";
            const basin = error.basinCells > 0
                ? `about ${cellCountText(error.basinCells)} cells`
                : "under the 4,000,000 cell limit";
            return `This basin is ${basin} at ${label}. Its bounding box is ${box} cells, which is too large to sample, so that print grid stays unloaded. The map still shows the 5 km DEM overview.`;
        }
        return null;
    }

    function syncResolution() {
        if (!state.resolutionManual && state.feature) {
            state.resolution = chooseResolution(state.feature);
        }
        const select = document.getElementById("dem-resolution");
        const basinId = state.feature && state.feature.properties && state.feature.properties.id;
        if (select) {
            select.querySelectorAll("option").forEach((option) => {
                const resolution = Number(option.value);
                const onSite = resolution === 5000 || resolutionAvailable(basinId, resolution);
                option.disabled = !onSite;
                const label = resolutionLabel(resolution);
                if (option.textContent !== label) option.textContent = label;
            });
            if (select.value !== String(state.resolution)) select.value = String(state.resolution);
        }
        const note = document.getElementById("resolution-note");
        if (!note) return;
        const area = basinAreaM2(state.feature);
        if (!area) {
            note.textContent = "The default is the resolution that keeps the grid near 100,000 to 1,000,000 cells.";
            return;
        }
        const cells = Math.round(area / (state.resolution * state.resolution));
        const fallback = defaultResolutionM(area);
        let text = `${resolutionLabel(state.resolution)} is about ${cells.toLocaleString("en-US")} cells.`;
        if (state.resolution === fallback) {
            text += " This default keeps the grid near 100,000 to 1,000,000 cells.";
        } else if (!resolutionAvailable(basinId, fallback)) {
            const held = [30, 90].filter((resolution) => !resolutionAvailable(basinId, resolution));
            const names = held.map(resolutionLabel).join(" and ");
            const noun = held.length === 1 ? "grid" : "grids";
            const verb = held.length === 1 ? "is" : "are";
            text += ` The ${names} ${noun} for this basin ${verb} not on this site.`;
            if (resolutionAvailable(basinId, state.resolution)) {
                text += ` This page uses ${resolutionLabel(state.resolution)}.`;
            }
        } else {
            text += ` The default for this basin is ${resolutionLabel(fallback)}.`;
        }
        const published = state.elevGrid && state.elevGrid.key === basinId ? state.elevGrid.resolution_m : null;
        if (published && published !== state.resolution) {
            text += ` The preview uses the published ${resolutionLabel(published)} sample.`;
        }
        if (cells > BASIN_CELL_CAP) {
            text += " A bake above 4,000,000 cells uses a coarser grid.";
        }
        if (state.elevMiss === basinId && state.elevMissResolution === state.resolution && state.elevMissText) {
            text += ` ${state.elevMissText}`;
        }
        const bakedHere = Boolean(bakedFileId(
            state.feature && state.feature.properties && state.feature.properties.id,
            state.resolution,
        ));
        const onPublic = location.protocol === "https:";
        const fineGrids = fineBook && fineBook.grids;
        const fineOn = !onPublic && Boolean(fineGrids && fineGrids["30"] && fineGrids["90"] && fineGrids["250"]);
        const hostedHere = onPublic && HOSTED_RESOLUTIONS.includes(state.resolution);
        const available = onPublic
            ? [...HOSTED_RESOLUTIONS, ...COARSE_RESOLUTIONS]
            : [...FINE_RESOLUTIONS, ...COARSE_RESOLUTIONS];
        const availableText = ` The ${available.map(resolutionLabel).join(", ")} grids are on this site.`;
        if (state.resolution === 5000) {
            text += availableText;
        } else if (!COARSE_RESOLUTIONS.includes(state.resolution) && !bakedHere && !hostedHere && !(fineOn && FINE_RESOLUTIONS.includes(state.resolution))) {
            text += availableText;
        }
        note.textContent = text;
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
        if (state.elevGrid && (state.elevGrid.key !== id || state.elevGrid.resolution_m !== state.resolution)) {
            state.elevGrid = null;
            state.reliefImage = null;
        }
        syncResolution();
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
        document.getElementById("ramp-conus").disabled = !rampOn;
        document.getElementById("ramp-watershed").disabled = !rampOn;
        document.getElementById("ramp-conus").setAttribute("aria-pressed", state.rampScale === "conus" ? "true" : "false");
        document.getElementById("ramp-watershed").setAttribute("aria-pressed", state.rampScale === "watershed" ? "true" : "false");
        const ramp = activeRamp();
        const rampNote = document.getElementById("ramp-note");
        if (!rampOn) {
            rampNote.textContent = "The color ramp colors the DEM overview and the basin. Satellite and USGS Topo replace that overview.";
        } else if (ramp && state.rampBook) {
            const limits = rampLimits();
            const conus = `${Math.round(limits.conusLow).toLocaleString("en-US")} to ${Math.round(limits.conusHigh).toLocaleString("en-US")} m`;
            const credit = state.rampBook.attribution;
            if (state.rampScale === "watershed" && limits.mode === "watershed") {
                const low = Math.round(limits.low).toLocaleString("en-US");
                const high = Math.round(limits.high).toLocaleString("en-US");
                rampNote.textContent = `${ramp.label} colors this watershed from ${low} to ${high} m. The overview stays on the CONUS limits, ${conus}. ${credit}`;
            } else if (state.rampScale === "watershed") {
                rampNote.textContent = `${ramp.label} colors this watershed from its lowest elevation to its highest after the grid loads. The overview stays on the CONUS limits, ${conus}. ${credit}`;
            } else {
                rampNote.textContent = `${ramp.label} colors the overview and this watershed on the CONUS limits, ${conus}. ${credit}`;
            }
        }
        const fit = state.fit;
        if (!fit) {
            document.getElementById("size-readout").textContent = "Choose a basin to size the squares.";
        } else {
            const ground = fit.metersPerInch >= 1000
                ? `${(fit.metersPerInch / 1000).toFixed(2)} km`
                : `${Math.round(fit.metersPerInch).toLocaleString("en-US")} m`;
            const border = fit.borderIn > 0
                ? `A ${fit.borderIn} in buffer is left around the watershed.`
                : "No buffer is left around the watershed.";
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
        syncPrintViewBlank(viewSignature(state));
    }

    function renderVertical() {
        const note = document.getElementById("vert-readout");
        const fit = state.fit;
        const grid = state.elevGrid;
        if (!fit || !grid) {
            state.vertical = null;
            const basinId = state.feature && state.feature.properties && state.feature.properties.id;
            if (state.feature && state.elevMiss === basinId && state.elevMissResolution === state.resolution) {
                note.textContent = state.elevMissText || missingGridText();
            } else {
                note.textContent = grid ? "Choose a basin to scale the height." : "Elevation for this basin is loading.";
            }
            return;
        }
        const reliefM = Math.max(0, grid.max - grid.min);
        const tileCount = state.squares && state.squares.size ? state.squares.size : state.squareCount;
        const baseMm = clampBaseMm(state.baseMm, tileCount);
        const baseIn = baseMm / MM_PER_IN;
        const limit = maxExaggeration(reliefM, fit.metersPerInch, baseIn);
        const applied = appliedExaggeration(state.exaggeration, reliefM, fit.metersPerInch, baseIn);
        const peak = terrainHeight(grid.max, grid.min, fit.metersPerInch, applied, baseIn);
        state.vertical = {
            requested: state.exaggeration,
            applied,
            limit,
            elev_min_m: grid.min,
            elev_max_m: grid.max,
            base_mm: baseMm,
            base_in: baseIn,
            max_height_in: peak.totalIn,
        };
        const limited = applied + 0.001 < state.exaggeration
            ? ` The requested ${state.exaggeration} is above the cap, so ${applied.toFixed(1)} is used.`
            : "";
        let print = "";
        if (state.printCrs && grid.resolution_m) {
            print = ` Print grid: ${state.printCrs.label}, ${resolutionLabel(grid.resolution_m)}.`;
        }
        note.textContent = `Elevation spans ${Math.round(grid.min).toLocaleString("en-US")}–${Math.round(grid.max).toLocaleString("en-US")} m. Applied exaggeration is ${applied.toFixed(1)} (maximum ${limit.toFixed(1)}). The base is ${baseMm.toFixed(1)} mm (${baseIn.toFixed(3)} in) and the highest point is ${peak.totalIn.toFixed(2)} in.${limited}${print}`;
    }

    function ensureElevation() {
        if (!state.feature) return;
        const id = state.feature.properties && state.feature.properties.id;
        const note = document.getElementById("vert-readout");
        if (!id) {
            state.elevGrid = null;
            state.reliefImage = null;
            if (note) note.textContent = missingGridText();
            return;
        }
        const ramp = activeRamp();
        const resolution = state.resolution;
        const loadKey = `${id}@${resolution}`;
        if (state.elevGrid && state.elevGrid.key === id && state.elevGrid.resolution_m === resolution) {
            const applied = state.vertical ? state.vertical.applied : state.exaggeration;
            const limits = rampLimits();
            const zKey = `${limits.mode}:${limits.low}:${limits.high}`;
            const stale = !ramp
                || !state.reliefImage
                || state.reliefImage.ramp !== ramp.id
                || state.reliefImage.exaggeration !== applied
                || state.reliefImage.zKey !== zKey;
            if (!ramp) state.reliefImage = null;
            else if (stale) {
                try {
                    state.reliefImage = paintRelief(state.elevGrid, applied, stopsForPaint(ramp), ramp.id);
                    state.reliefImage.zKey = zKey;
                    state.reliefImage.scale = limits.mode;
                } catch (paintError) {
                    state.reliefImage = null;
                }
            }
            return;
        }
        if (state.elevMiss === id && state.elevMissResolution === resolution) return;
        if (state.elevLoading === loadKey) return;
        if (state.elevAbort) state.elevAbort.abort();
        const controller = new AbortController();
        state.elevAbort = controller;
        state.elevLoading = loadKey;
        state.elevMiss = null;
        state.elevMissText = null;
        state.elevMissResolution = null;
        const bakedId = bakedFileId(id, resolution);
        let loader;
        if (COARSE_RESOLUTIONS.includes(resolution)) {
            loader = sampleCoarse(state.feature, resolution, controller.signal);
        } else if (bakedId) {
            loader = sampleElevations(state.feature, controller.signal, bakedId);
        } else if (location.protocol === "https:" && HOSTED_RESOLUTIONS.includes(resolution)) {
            loader = sampleHosted(state.feature, resolution, controller.signal);
        } else if (FINE_RESOLUTIONS.includes(resolution)) {
            loader = location.protocol === "https:"
                ? Promise.reject(new Error("https-fine"))
                : sampleFine(state.feature, resolution, controller.signal);
        } else {
            loader = sampleElevations(state.feature, controller.signal);
        }
        loader.then((grid) => {
            if (controller.signal.aborted) return;
            if (!state.feature || !(state.feature.properties && state.feature.properties.id === id)) return;
            if (state.resolution !== resolution) return;
            state.elevGrid = grid;
            state.elevLoading = null;
            state.elevMiss = null;
            state.elevMissText = null;
            state.elevMissResolution = null;
            state.reliefImage = null;
            render();
        }).catch((error) => {
            if (error && error.name === "AbortError") return;
            if (state.elevAbort !== controller) return;
            state.elevLoading = null;
            state.elevGrid = null;
            state.reliefImage = null;
            state.elevMiss = id;
            state.elevMissResolution = resolution;
            const limited = gridLimitText(error, resolution);
            if (limited) state.elevMissText = limited;
            else if (error && error.message === "https-fine") {
                state.elevMissText = `The ${resolutionLabel(resolution)} grid for this basin is not on the public site. The map still shows the 5 km DEM overview.`;
            } else {
                state.elevMissText = missingGridText();
            }
            if (note) note.textContent = state.elevMissText;
            render();
        });
    }

    function renderQuote() {
        const form = readForm();
        const estimate = printEstimate(form);
        const payload = orderPayload(form);
        const money = (amount) => amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
        const rows = (payload.customer_lines || []).map((line) => `<div><span>${escapeHtml(line.label)}</span><span class="${line.amount == null ? "missing" : ""}">${line.amount == null ? "Rate not set" : money(line.amount)}</span></div>`).join("");
        const waiting = payload.total == null
            ? (estimate.ready
                ? `Needs ${payload.missing.join(", ")}`
                : "Loading the estimate")
            : "";
        const total = payload.total == null
            ? `<div class="total"><span>Total</span><span class="missing">${escapeHtml(waiting)}</span></div>`
            : `<div class="total"><span>Total</span><span>${money(payload.total)}</span></div>`;
        document.getElementById("quote").innerHTML = rows + total;
        syncOrderButton();
        const ship = estimate.ship;
        const basinId = state.feature && state.feature.properties && state.feature.properties.id;
        let eta = "The estimate appears after the elevation loads.";
        if (estimate.ready) {
            const hours = `Print time is about ${estimate.hours.toFixed(1)} hours.`;
            eta = !ship || ship.amount == null
                ? `${hours} Shipping needs a US ZIP Code.`
                : `${hours} Ships from Ames to ${ship.zip}, about ${ship.days} business days.`;
        } else if (state.elevMissText && state.elevMiss === basinId && state.elevMissResolution === state.resolution) {
            eta = state.elevMissText;
        }
        document.getElementById("eta").textContent = eta;
        if (map) document.getElementById("map-note").textContent = mapCaption();
    }

    function mapCaption() {
        if (!state.feature) return "Choose a basin.";
        const props = state.feature.properties || {};
        const name = featureName(state.feature, 0);
        let text;
        if (props.dataset === "us-wbd") {
            const where = props.states ? ` ${props.states}.` : "";
            const outline = props.outline === "source"
                ? "The red line is the USGS boundary."
                : `The red line is the basin. ${catalogOutlineSentence(props.level)}`;
            text = `${name}, ${props.level} ${props.code}.${where} USGS Watershed Boundary Dataset. ${outline} The black squares are the model. The surface inside the squares is a preview, not the print file.`;
        } else {
            text = `${name}. The red line is the basin. The black squares are the model. The surface inside them is a preview, not the print file.`;
        }
        const id = state.feature.properties && state.feature.properties.id;
        const grid = state.elevGrid;
        if (grid && grid.key === id) {
            if (grid.attribution) text += ` ${grid.attribution}.`;
            if (state.printCrs && grid.resolution_m) {
                text += ` Print grid: ${state.printCrs.label}, ${resolutionLabel(grid.resolution_m)}.`;
            }
        }
        if (state.color === "white" || state.color === "dem") {
            const ramp = activeRamp();
            const rampName = ramp ? ` Colored with ${ramp.label}.` : "";
            const range = state.rampScale === "watershed"
                ? " Basin colors use this watershed's elevation range."
                : " Basin colors use the CONUS elevation range.";
            text += ` The base map is a Copernicus DEM overview at about 5 km, for finding the basin.${rampName}${range}`;
        }
        if (state.elevMiss === id && state.elevMissResolution === state.resolution && state.elevMissText) {
            text += ` ${state.elevMissText}`;
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
            rampScale: state.rampScale,
            rampBook: state.rampBook,
            exaggeration: state.exaggeration,
            vertical: state.vertical,
            baseMm: state.baseMm,
            bufferIn: state.bufferIn,
            isuAffiliated: state.isuAffiliated,
            elevGrid: state.elevGrid,
            resolution: state.resolution,
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
        const fitKey = fit ? `${fit.cols}x${fit.rows}@${fit.rotationDeg} b${fit.borderIn} s${Number(fit.inchesPerMeter).toFixed(8)}` : "";
        const signature = `${styleColor}|${rampKey}|${state.rampScale}|${state.reliefImage ? state.reliefImage.zKey : ""}|${printKey}|${state.feature ? featureName(state.feature, 0) : ""}|${fitKey}|${state.pourPoint}|${state.exaggeration}|${state.reliefImage ? state.reliefImage.exaggeration : ""}|${state.reliefImage ? state.reliefImage.ramp : ""}|${state.elevGrid ? state.elevGrid.key : ""}`;
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

    function syncOrderButton() {
        const button = document.getElementById("order-btn");
        if (!button) return;
        const ready = campusOrderHost() && !state.orderBusy && orderPayload(readForm()).quote_complete;
        button.disabled = !ready;
        if (!state.orderBusy) button.textContent = ready ? "Record order" : "Order";
    }

    async function recordOrder() {
        return;
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
            tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"],
            maxzoom: 16,
            attribution: "USGS National Map",
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
