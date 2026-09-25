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

function fitSquares(feature, count, alignment) {
    const n = Math.max(1, Math.min(100, Math.floor(count) || 1));
    const { lng0, lat0, points } = featurePointsMeters(feature);
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

function quoteLines(state) {
    const color = state.rates.colors[state.color] || {};
    const n = state.squares.size;
    const kits = state.kits;
    const wage = finite(state.rates.wage_per_hour);
    const machine = finite(state.rates.machine_rate_per_hour);
    const lines = [
        ["Squares, material", product([n, finite(color.material_rate)])],
        ["Squares, machine", product([n, finite(color.hours_per_square), machine])],
        ["Squares, labor", product([n, finite(color.labor_hours_per_square), wage])],
        ["Assembly labor", product([finite(state.rates.assembly_hours), wage])],
    ];
    if (kits === 0) lines.push(["Accessory kits", 0]);
    else lines.push(["Accessory kits", product([kits, finite(state.rates.kit && state.rates.kit.price)])]);
    const grams = shipmentGrams(state);
    lines.push(["Shipping", shippingCost(state, grams)]);
    return lines.map(([label, amount]) => ({ label, amount }));
}

function shipmentGrams(state) {
    const color = state.rates.colors[state.color] || {};
    const perSquare = finite(color.grams_per_square);
    if (perSquare == null) return null;
    let grams = state.squares.size * perSquare + (finite(state.rates.packaging_grams) || 0);
    if (state.kits > 0) {
        const kitGrams = finite(state.rates.kit && state.rates.kit.grams);
        if (kitGrams == null) return null;
        grams += state.kits * kitGrams;
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
    const color = state.rates.colors[state.color] || {};
    const printers = finite(state.rates.printers);
    const daysEach = finite(color.days_per_square);
    const assembly = finite(state.rates.assembly_days);
    const printDays = printers && daysEach != null ? Math.ceil(state.squares.size / printers) * daysEach : null;
    const row = shippingRow(state);
    return {
        printDays,
        assemblyDays: assembly,
        transitMin: row ? finite(row.transit_days_min) : null,
        transitMax: row ? finite(row.transit_days_max) : null,
    };
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
        kits: state.kits,
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
        quote_complete: missing.length === 0 && Boolean(state.feature) && state.squares.size > 0,
    };
}

if (typeof document !== "undefined" && document.getElementById("map")) {
    bootWatershedPage();
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
        color: "white",
        kits: 0,
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
            style: mapStyle("white"),
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
    loadJSON("../data/watershed-model.json").then(async (rates) => {
        state.rates = rates;
        document.getElementById("intro").textContent = rates.intro;
        document.getElementById("kit-note").textContent = (rates.kit && rates.kit.description) || "";
        buildColorButtons();
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
    document.getElementById("kits").addEventListener("input", (event) => {
        state.kits = Math.max(0, Math.floor(finite(event.target.value) || 0));
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

    function applyFit() {
        if (!state.feature) {
            state.fit = null;
            state.squares = new Set();
            state.scale = null;
            return;
        }
        state.fit = fitSquares(state.feature, state.squareCount, state.alignment);
        state.squares = state.fit.squares;
        state.scale = state.fit.metersPerInch * 24;
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
        applyFit();
        const topoOk = !state.feature || centroidInUS(state.feature);
        document.querySelectorAll("#color-choices button").forEach((button) => {
            const blocked = button.dataset.color === "topo" && state.feature && !topoOk;
            button.disabled = blocked;
            button.setAttribute("aria-pressed", button.dataset.color === state.color ? "true" : "false");
        });
        document.getElementById("color-note").textContent = state.feature && !topoOk
            ? "USGS topo is available when the basin is in the United States."
            : "Solid white, DEM, and satellite can be used for any basin. USGS topo is a United States surface.";
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
        renderQuote();
        drawMap();
    }

    function renderQuote() {
        const payload = orderPayload(readForm());
        const money = (amount) => amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
        const rows = payload.lines.map((line) => `<div><span>${escapeHtml(line.label)}</span><span class="${line.amount == null ? "missing" : ""}">${line.amount == null ? "Rate not set" : money(line.amount)}</span></div>`).join("");
        const total = payload.total == null
            ? `<div class="total"><span>Total</span><span class="missing">Needs ${escapeHtml(payload.missing.join(", "))}</span></div>`
            : `<div class="total"><span>Total</span><span>${money(payload.total)}</span></div>`;
        document.getElementById("quote").innerHTML = rows + total;
        const days = payload.delivery;
        const parts = [];
        parts.push(days.printDays == null ? "Print time needs printers and days per square." : `Print time about ${days.printDays} day${days.printDays === 1 ? "" : "s"}, before the shop queue.`);
        parts.push(days.assemblyDays == null ? "Assembly time is not set." : `Assembly is ${days.assemblyDays} day${days.assemblyDays === 1 ? "" : "s"}.`);
        if (days.transitMin == null) parts.push("Transit for this country is not set.");
        else if (days.transitMax != null && days.transitMax !== days.transitMin) parts.push(`Transit about ${days.transitMin}–${days.transitMax} days after the model leaves Ames.`);
        else parts.push(`Transit about ${days.transitMin} days after the model leaves Ames.`);
        document.getElementById("eta").textContent = parts.join(" ");
        const exampleOnly = state.boundaries.length === 1 && state.boundaries[0].properties && state.boundaries[0].properties.example;
        document.getElementById("map-note").textContent = state.feature
            ? `${featureName(state.feature, 0)}${exampleOnly ? " is an example, standing in until the club boundary dataset is loaded" : ""}. The red line is the basin. The black squares are the model. The surface inside them is a preview, not the print file.`
            : "Choose a basin, or save a pour point.";
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
            kits: state.kits,
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
        const signature = `${styleColor}|${state.feature ? featureName(state.feature, 0) : ""}|${fit ? `${fit.cols}x${fit.rows}@${fit.rotationDeg}` : ""}|${state.pourPoint}`;
        if (map._swccSignature === signature) return;
        map._swccSignature = signature;
        const token = (map._swccToken || 0) + 1;
        map._swccToken = token;
        map.setStyle(mapStyle(styleColor));
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
            if (state.feature) {
                map.addSource("basin", { type: "geojson", data: state.feature });
                map.addLayer({
                    id: "basin-fill",
                    type: "fill",
                    source: "basin",
                    paint: { "fill-color": "#C8102E", "fill-opacity": 0.28 },
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

    window.SWCCWatershed = { orderPayload: () => orderPayload(readForm()) };
}

function mapStyle(color) {
    const bases = {
        dem: {
            tiles: ["https://maps-for-free.com/layer/relief/z{z}/row{y}/{z}_{x}-{y}.jpg"],
            maxzoom: 8,
            attribution: "Colored relief © maps-for-free.com",
        },
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
        return { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#f7f7f5" } }] };
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
