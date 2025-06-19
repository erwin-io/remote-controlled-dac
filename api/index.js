import express from "express";
import https from "https";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import Pusher from "pusher";
import dotenv from "dotenv";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, update, get, push, remove } from "firebase/database";
import { v4 as uuidv4 } from "uuid";
import cors from "cors";
import admin from "firebase-admin";
import dayjs from "dayjs";
import axios from "axios";

const REVERSE_GEOCODE_URL = "https://nominatim.openstreetmap.org/reverse";

// ✅ Load Environment Variables
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 🔹 **Check if SSL Certificates Exist for Development**
const SSL_KEY = path.join(__dirname, "server.key");
const SSL_CERT = path.join(__dirname, "server.cert");

const ENV = process.env.NODE_ENV || "development";
const FORCE_HTTPS = ENV === "development";

let server;
if (FORCE_HTTPS) {
  if (!fs.existsSync(SSL_KEY) || !fs.existsSync(SSL_CERT)) {
    console.error("❌ SSL certificate or key file is missing.");
    process.exit(1);
  }

  server = https.createServer(
    {
      key: fs.readFileSync(SSL_KEY),
      cert: fs.readFileSync(SSL_CERT),
    },
    app
  );

  console.log("✅ Running with HTTPS in development mode.");
} else {
  server = http.createServer(app);
  console.log("✅ Running with HTTP in production mode.");
}

// ✅ **Initialize Firebase**
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID,
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// Helper: Get server timestamp in ISO format
function getNow() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ✅ Initialize Firebase Admin SDK
if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    databaseURL: process.env.FIREBASE_DATABASE_URL, // Ensure this is set in .env
  });
}
// ✅ **Initialize Pusher**
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});

app.use(cors());
app.use(express.json());

// ✅ **Serve static files**
// app.use(express.static('public'));
app.use(express.static(path.join(__dirname, "public")));

// ✅ **Routes for HTML pages**
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.get("/api/range", async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: "Missing 'from' or 'to' query parameter" });
  }

  try {
    const fromDate = dayjs(from).startOf("day"); // 2025-01-01 00:00:00
    const toDate = dayjs(to).add(1, "day").startOf("day"); // 2025-01-02 00:00:00

    const snapshot = await get(ref(db, "log-readings"));
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "No readings found" });
    }

    const allReadings = snapshot.val();
    const filtered = [];

    for (const key in allReadings) {
      const entry = allReadings[key];
      if (!entry.timestamp) continue;

      const entryTime = dayjs(entry.timestamp);
      if (entryTime.isSame(fromDate) || (entryTime.isAfter(fromDate) && entryTime.isBefore(toDate))) {
        filtered.push({ id: key, ...entry });
      }
    }

    return res.json({
      from: fromDate.format("YYYY-MM-DD HH:mm:ss"),
      to: toDate.format("YYYY-MM-DD HH:mm:ss"),
      count: filtered.length,
      readings: filtered,
    });
  } catch (err) {
    console.error("❌ Failed to fetch range:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


app.post("/api/log-readings", async (req, res) => {
  const { readings, timestamp } = req.body;

  if (!Array.isArray(readings) || timestamp instanceof Date) {
    return res.status(400).json({
      error: "Invalid payload. Expected: { timestamp, readings: [ { co2, timestamp } ] }",
    });
  }

  try {
    const updates = {};

    const coordinates = [
      { lng: "123.8854", lat: "10.3157" },
      { lng: "123.9687", lat: "10.2970" },
      { lng: "123.8426", lat: "10.3882" },
      { lng: "123.6258", lat: "10.7760" },
      { lng: "123.9944", lat: "10.2955" },
      { lng: "123.9053", lat: "10.3280" },
      { lng: "123.7844", lat: "9.6057" },
      { lng: "123.5747", lat: "9.9843" },
      { lng: "123.9645", lat: "10.2793" },
      { lng: "123.8476", lat: "10.3431" },
      { lng: "123.6256", lat: "11.2623" },
      { lng: "123.9689", lat: "10.3353" },
      { lng: "123.4500", lat: "10.0516" },
      { lng: "123.9754", lat: "10.2942" },
      { lng: "123.6102", lat: "10.3853" },
      { lng: "123.9813", lat: "10.3526" },
      { lng: "124.0300", lat: "10.6089" },
      { lng: "123.5110", lat: "10.1321" },
      { lng: "124.0347", lat: "11.0710" },
      { lng: "123.9769", lat: "10.4021" },
    ];

    for (const r of readings) {
      const sensorTimestamp = r.timestamp;
      const random = coordinates[Math.floor(Math.random() * coordinates.length)];
      updates[`log-readings/${sensorTimestamp}`] = {
        co2: r.co2,
        timestamp: sensorTimestamp,
        lat: random.lat,
        lng: random.lng,
        uploadtimestamp: timestamp || getNow()
      };
    }

    await update(ref(db), updates);

    console.log(`✅ Stored ${readings.length} readings using sensor timestamp as keys`);
    res.json({ message: "Readings successfully logged." });
  } catch (error) {
    console.error("❌ Firebase error:", error);
    res.status(500).json({ error: "Failed to store readings" });
  }
});

// --- Utility Functions ---
function groupByDate(readings) {
  const grouped = {};
  readings.forEach(r => {
    const date = dayjs(r.timestamp).format("YYYY-MM-DD");
    grouped[date] = grouped[date] || [];
    grouped[date].push(r.co2);
  });
  return grouped;
}

function average(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

async function reverseGeocode(lat, lng) {
  try {
    const resp = await axios.get(REVERSE_GEOCODE_URL, {
      params: { lat, lon: lng, format: "json" },
      headers: { "User-Agent": "CO2-Dashboard/1.0" }
    });
    return resp.data.address.city || resp.data.address.town ||
           resp.data.address.village || resp.data.address.state || null;
  } catch (err) {
    console.error("Geocode failed:", err.message);
    return null;
  }
}

// --- Endpoint ---
app.get("/api/dashboard/summary", async (req, res) => {
  try {
    const now = dayjs();
    const snapshot = await get(ref(db, "log-readings"));
    if (!snapshot.exists()) return res.status(404).json({ error: "No data" });

    const data = Object.values(snapshot.val()).map(r => ({
      co2: r.co2,
      timestamp: r.timestamp,
      lat: r.lat,
      lng: r.lng
    }));

    // --- Current vs Last Month Same Day ---
    const today = now.format("YYYY-MM-DD");
    const lastMonthDay = now.subtract(1, "month").format("YYYY-MM-DD");

    const todayAvg = average(data.filter(r => r.timestamp.startsWith(today)).map(r => r.co2));
    const lastMonthAvg = average(data.filter(r => r.timestamp.startsWith(lastMonthDay)).map(r => r.co2));
    const currentChange = lastMonthAvg ? ((todayAvg - lastMonthAvg) / lastMonthAvg) * 100 : 0;

    // --- Monthly Average ---
    const currentMonth = now.format("YYYY-MM");
    const monthData = data.filter(r => r.timestamp.startsWith(currentMonth));
    const dailyAvg = Object.values(groupByDate(monthData)).map(average);
    const monthlyAvg = average(dailyAvg);

    // --- Spikes (+50ppm increases only) ---
    const spikeEntries = [];
    let prev = null;
    const thisYear = now.format("YYYY");
    const yearData = data
      .filter(r => r.timestamp.startsWith(thisYear))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    for (const r of yearData) {
      if (prev) {
        const diff = r.co2 - prev.co2;
        if (diff > 50) spikeEntries.push({ spike: diff, from: prev, to: r });
      }
      prev = r;
    }

    const topSpikes = spikeEntries.sort((a, b) => b.spike - a.spike).slice(0, 5);
    const criticalSpike = topSpikes[0] || null;
    const critical = criticalSpike ? criticalSpike.to : null;

    let city = null;
    if (critical && critical.lat && critical.lng) {
      city = await reverseGeocode(critical.lat, critical.lng);
    }

    res.json({
      current: {
        value: Number(todayAvg.toFixed(1)),
        change: Number(currentChange.toFixed(1))
      },
      monthlyAverage: {
        value: Number(monthlyAvg.toFixed(1))
      },
      alerts: {
        totalWarnings: spikeEntries.length,
        top5: topSpikes.map(s => ({
          spike: Number(s.spike.toFixed(1)),
          from: s.from.timestamp,
          to: s.to.timestamp,
          lat: s.to.lat,
          lng: s.to.lng
        })),
        criticalRegion: {
          spike: criticalSpike ? Number(criticalSpike.spike.toFixed(1)) : 0,
          lat: critical?.lat || null,
          lng: critical?.lng || null,
          city
        }
      }
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});


app.get("/api/dashboard/spikes", async (req, res) => {
  try {
    const mode = req.query.mode || "day"; // "day" | "week" | "month"
    const now = dayjs();

    const snapshot = await get(ref(db, "log-readings"));
    if (!snapshot.exists()) return res.status(404).json({ error: "No data" });

    const data = Object.values(snapshot.val()).filter(r => r.timestamp);

    const xLabels = [];
    const yValues = [];
    const groups = {}; // key => list of co2 values

    if (mode === "day") {
      for (let hour = 0; hour < 24; hour++) {
        const label = dayjs().hour(hour).format("h A");
        xLabels.push(label);
        groups[label] = [];
      }

      data.forEach(r => {
        const t = dayjs(r.timestamp);
        if (t.isSame(now, "day")) {
          const label = t.format("h A");
          groups[label]?.push(r.co2);
        }
      });
    }

    else if (mode === "week") {
      const weekStart = now.startOf("week");
      const weekDays = ["Sun", "Mon", "Tues", "Wed", "Thu", "Fri", "Sat"];

      for (let i = 0; i < 7; i++) {
        const label = weekDays[i];
        xLabels.push(label);
        groups[label] = [];
      }

      data.forEach(r => {
        const t = dayjs(r.timestamp);
        if (t.isSame(now, "week")) {
          const label = weekDays[t.day()];
          groups[label]?.push(r.co2);
        }
      });
    }

    else if (mode === "month") {
      const daysInMonth = now.daysInMonth();
      for (let i = 1; i <= daysInMonth; i++) {
        const label = now.date(i).format("MMM D");
        xLabels.push(label);
        groups[label] = [];
      }

      data.forEach(r => {
        const t = dayjs(r.timestamp);
        if (t.isSame(now, "month")) {
          const label = t.format("MMM D");
          groups[label]?.push(r.co2);
        }
      });
    }

    xLabels.forEach(label => {
      yValues.push(Math.round(average(groups[label]) || 0));
    });

    res.json({ x: xLabels, y: yValues });
  } catch (err) {
    console.error("/api/co2-spikes error:", err);
    res.status(500).json({ error: "Failed to generate spike graph data" });
  }
});


app.get("/api/dashboard/location-data", async (req, res) => {
  try {
    const mode = req.query.mode || "current"; // current | avg | peak
    const now = dayjs();

    const snapshot = await get(ref(db, "log-readings"));
    if (!snapshot.exists()) return res.status(404).json({ error: "No data" });

    const allData = Object.values(snapshot.val()).filter(r => r.timestamp && r.lat && r.lng);

    const groups = {}; // key: "lat,lng" => list of co2 values

    for (const r of allData) {
      const key = `${r.lat},${r.lng}`;
      const t = dayjs(r.timestamp);

      if (mode === "current") {
        if (t.isAfter(now.subtract(1, "hour"))) {
          if (!groups[key]) groups[key] = [];
          groups[key].push(r.co2);
        }
      } else if (mode === "avg") {
        if (t.isSame(now, "day")) {
          if (!groups[key]) groups[key] = [];
          groups[key].push(r.co2);
        }
      } else if (mode === "peak") {
        if (t.isSame(now, "month")) {
          if (!groups[key]) groups[key] = [];
          groups[key].push(r.co2);
        }
      }
    }

    // Convert group data to array of objects with lat, lng, and value
    let groupValues = Object.entries(groups).map(([key, values]) => {
      const [lat, lng] = key.split(",");
      const co2Value = mode === "peak" ? Math.max(...values) : average(values);
      return {
        lat,
        lng,
        value: Math.round(co2Value)
      };
    });

    // Sort and keep only top 5
    groupValues = groupValues.sort((a, b) => b.value - a.value).slice(0, 5);

    // Map lat/lng to location names in parallel
    const results = await Promise.all(groupValues.map(async (item) => {
      const location = await reverseGeocode(item.lat, item.lng);
      return {
        location,
        value: item.value
      };
    }));

    res.json(results);
  } catch (err) {
    console.error("/api/levels-by-location error:", err);
    res.status(500).json({ error: "Failed to compute levels by location" });
  }
});


app.get("/api/dashboard/historical", async (req, res) => {
  try {
    const years = parseInt(req.query.years || "1"); // Default to 1 year
    const now = dayjs();
    const startYear = now.year() - years + 1;

    const snapshot = await get(ref(db, "log-readings"));
    if (!snapshot.exists()) return res.status(404).json({ error: "No data found" });

    const rawData = Object.values(snapshot.val()).filter(r => r.timestamp);

    // Structure: { 'YYYY-MM': { year: 2024, month: '2024-01', values: [] } }
    const monthlyGroups = {};

    rawData.forEach(entry => {
      const time = dayjs(entry.timestamp);
      const year = time.year();
      if (year >= startYear && year <= now.year()) {
        const key = time.format("YYYY-MM");
        if (!monthlyGroups[key]) monthlyGroups[key] = [];
        monthlyGroups[key].push(entry.co2);
      }
    });

    // Build result grouped by year, each with months
    const result = {};
    Object.keys(monthlyGroups).forEach(key => {
      const year = key.split("-")[0];
      result[key] = average(monthlyGroups[key]);
    });

    res.json(result);

  } catch (err) {
    console.error("❌ Historical trends error:", err);
    res.status(500).json({ error: "Failed to fetch historical trends" });
  }
});


app.post("/api/patch-all-readings", async (req, res) => {
  try {
    const snapshot = await get(ref(db, "log-readings"));

    if (!snapshot.exists()) {
      console.log("No readings found.");
      return res.status(404).send("No readings found.");
    }

    const allReadings = snapshot.val();
    const keys = Object.keys(allReadings);

    const coordinates = [
      { lng: "123.8854", lat: "10.3157" },
      { lng: "123.9687", lat: "10.2970" },
      { lng: "123.8426", lat: "10.3882" },
      { lng: "123.6258", lat: "10.7760" },
      { lng: "123.9944", lat: "10.2955" },
      { lng: "123.9053", lat: "10.3280" },
      { lng: "123.7844", lat: "9.6057" },
      { lng: "123.5747", lat: "9.9843" },
      { lng: "123.9645", lat: "10.2793" },
      { lng: "123.8476", lat: "10.3431" },
      { lng: "123.6256", lat: "11.2623" },
      { lng: "123.9689", lat: "10.3353" },
      { lng: "123.4500", lat: "10.0516" },
      { lng: "123.9754", lat: "10.2942" },
      { lng: "123.6102", lat: "10.3853" },
      { lng: "123.9813", lat: "10.3526" },
      { lng: "124.0300", lat: "10.6089" },
      { lng: "123.5110", lat: "10.1321" },
      { lng: "124.0347", lat: "11.0710" },
      { lng: "123.9769", lat: "10.4021" },
    ];

    const batchSize = 1000;
    let totalUpdated = 0;

    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      const updates = {};

      for (const key of batch) {
        const random = coordinates[Math.floor(Math.random() * coordinates.length)];
        updates[`log-readings/${key}/lat`] = random.lat;
        updates[`log-readings/${key}/lng`] = random.lng;
      }

      await update(ref(db), updates);
      totalUpdated += batch.length;
      console.log(`✅ Updated batch ${i / batchSize + 1}: ${batch.length} items`);
    }

    res.status(200).json({
      success: true,
      updatedCount: totalUpdated,
      message: `Successfully added lat/lng to ${totalUpdated} readings`,
    });
  } catch (err) {
    console.error("❌ Failed to patch readings:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================
// List endpoints after server starts
// ==============================
function listEndpoints(app) {
  console.log("\n📌 Available Endpoints:");
  app._router.stack.forEach((layer) => {
    if (layer.route && layer.route.path) {
      const method = layer.route.stack[0].method.toUpperCase();
      console.log(`  ${method} ${layer.route.path}`);
    }
  });
}

server.listen(PORT, () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  listEndpoints(app);
});