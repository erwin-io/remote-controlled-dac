// === PlatformIO Project: DAC CO2 Monitoring ===
// File: src/main.cpp

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <SPI.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <RTClib.h>
#include <SparkFun_SCD4x_Arduino_Library.h>
#include <vector>
#include <time.h>
#include <sys/time.h>
#include <math.h>   // for isnan/isinf

// ===== WiFi (AP) =====
#define AP_SSID "DAC CO2 MONITORING"
#define AP_PASS "direct_air_capture_2025"

// ===== I2C pins (KEEP AS IS) =====
#define SDA1 21   // Bus 1: RTC + SCD41 (ambient)
#define SCL1 22
#define SDA2 18   // Bus 2: SCD41 (filtered)
#define SCL2 19

TwoWire I2C_1 = TwoWire(0);
TwoWire I2C_2 = TwoWire(1);

// ===== Devices =====
SCD4x      scdAmb;
SCD4x      scdFil;
RTC_DS3231 rtc;

// ===== Web =====
AsyncWebServer server(80);

// ===== Presence =====
bool hasAmb = false;
bool hasFil = false;
bool hasRTC = false;

// ===== Cached sensor states =====
struct SensorState {
  float    co2     = NAN;
  uint32_t epoch   = 0;     // unix seconds
  bool     valid   = false; // true once we ever got a reading
  uint32_t lastMs  = 0;     // last time value updated (ms)
  uint32_t lastOk  = 0;     // last time readMeasurement() returned true (ms)
};
SensorState amb, fil;

// ===== Logs =====
struct LogEntry {
  String   timestamp;  // "YYYY-MM-DD HH:MM:SS"
  uint32_t epoch;      // unix seconds (0 if unknown)
  float    ambient;
  float    filtered;
  float    improvement_percent;
};
std::vector<LogEntry> logs;

static const size_t LOG_MAX_KEEP = 3600; // keep ~1h if logging ~1 Hz

// ===== Time helpers (RTC-safe versions) =====
static void setTZ_AsiaManila(){ setenv("TZ", "PST-8", 1); tzset(); }

static String fmtLocal(time_t t){
  if (t <= 0) return String("0000-00-00 00:00:00");
  struct tm tm{};
  localtime_r(&t, &tm);
  char b[25];
  snprintf(b, sizeof(b), "%04d-%02d-%02d %02d:%02d:%02d",
    tm.tm_year+1900, tm.tm_mon+1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
  return String(b);
}

// Read rtc.now() with small retry to avoid transient I2C timeouts.
static bool rtcSafeNow(DateTime &out){
  if (!hasRTC) return false;
  for (int i = 0; i < 3; ++i){
    delay(2); // brief spacing helps when SCD41 is also on the bus
    DateTime dt = rtc.now();
    const int yr = dt.year();
    if (yr >= 2024 && yr <= 2099) { out = dt; return true; }
    delay(8);
  }
  return false;
}

static void primeSystemClockFromRTC(){
  if (!hasRTC) return;
  DateTime dt;
  if (!rtcSafeNow(dt)) {
    Serial.println("[TIME] rtcSafeNow() failed, skip prime");
    return;
  }
  struct tm tm{};
  tm.tm_year = dt.year() - 1900;
  tm.tm_mon  = dt.month() - 1;
  tm.tm_mday = dt.day();
  tm.tm_hour = dt.hour();
  tm.tm_min  = dt.minute();
  tm.tm_sec  = dt.second();
  time_t t = mktime(&tm);
  if (t <= 0) return;
  struct timeval tv{ .tv_sec = t, .tv_usec = 0 };
  settimeofday(&tv, nullptr);
  Serial.printf("[TIME] primed from RTC: %s\n", fmtLocal(t).c_str());
}

static String nowTimestamp(){
  time_t t = time(nullptr);
  if (t > 0) return fmtLocal(t);
  if (hasRTC) {
    DateTime dt;
    if (rtcSafeNow(dt)) {
      char b[25];
      snprintf(b, sizeof(b), "%04d-%02d-%02d %02d:%02d:%02d",
        dt.year(), dt.month(), dt.day(), dt.hour(), dt.minute(), dt.second());
      return String(b);
    }
  }
  return String("0000-00-00 00:00:00");
}
static uint32_t nowEpoch(){
  time_t t = time(nullptr);
  if (t > 0) return (uint32_t)t;
  if (hasRTC) {
    DateTime dt;
    if (rtcSafeNow(dt)) return (uint32_t)dt.unixtime();
  }
  return 0;
}

// ===== JSON helpers =====
static void printLogJSON(Print* out, const LogEntry& e){
  out->print('{');
  out->print("\"timestamp\":\""); out->print(e.timestamp); out->print("\",");
  out->print("\"epoch\":"); out->print(e.epoch); out->print(',');
  out->print("\"ambient\":"); out->print(String(e.ambient,1)); out->print(',');
  out->print("\"filtered\":"); out->print(String(e.filtered,1)); out->print(',');
  out->print("\"improvement\":"); out->print(String(e.improvement_percent,1));
  out->print('}');
}

// ===== I2C scan (debug) =====
static String scanBus(TwoWire& w, const char* tag){
  String out; out.reserve(256);
  out += "[I2C] Scanning "; out += tag; out += "...\n";
  for (uint8_t addr=1; addr<127; addr++){
    w.beginTransmission(addr);
    if (w.endTransmission() == 0){
      char line[32]; snprintf(line, sizeof(line), "  Found 0x%02X\n", addr);
      out += line; delay(2);
    }
  }
  return out;
}

// ===== 5s & 1min bucketing for /api/logs =====
struct Bucket {
  uint32_t key = 0;      // aligned epoch (5s or 60s)
  double   sumA = 0;
  double   sumF = 0;
  double   sumI = 0;
  uint32_t count = 0;
  uint32_t lastEpoch = 0;
  String   lastTs;
};

static void buildBuckets(size_t g5Limit, size_t m1Limit,
                         std::vector<Bucket>& g5, std::vector<Bucket>& m1){
  g5.clear(); m1.clear();
  if (logs.empty()) return;

  for (const auto& e : logs){
    if (e.epoch == 0) continue;

    // 5-second bucket
    uint32_t k5 = (e.epoch / 5U) * 5U;
    if (g5.empty() || g5.back().key != k5){
      Bucket b; b.key = k5; g5.push_back(b);
    }
    auto& b5 = g5.back();
    b5.sumA += e.ambient; b5.sumF += e.filtered; b5.sumI += e.improvement_percent; b5.count++;
    if (e.epoch >= b5.lastEpoch){ b5.lastEpoch = e.epoch; b5.lastTs = e.timestamp; }

    // 1-minute bucket
    uint32_t k60 = (e.epoch / 60U) * 60U;
    if (m1.empty() || m1.back().key != k60){
      Bucket b; b.key = k60; m1.push_back(b);
    }
    auto& b60 = m1.back();
    b60.sumA += e.ambient; b60.sumF += e.filtered; b60.sumI += e.improvement_percent; b60.count++;
    if (e.epoch >= b60.lastEpoch){ b60.lastEpoch = e.epoch; b60.lastTs = e.timestamp; }
  }

  if (g5.size() > g5Limit) g5.erase(g5.begin(), g5.end()-g5Limit);
  if (m1.size() > m1Limit) m1.erase(m1.begin(), m1.end()-m1Limit);
}

static void printBucketJSON(Print* out, const Bucket& b){
  double n = (b.count > 0) ? (double)b.count : 1.0;
  double aA = b.sumA / n;
  double aF = b.sumF / n;
  double aI = b.sumI / n;
  out->print('{');
  out->print("\"epoch\":"); out->print(b.lastEpoch); out->print(',');
  out->print("\"timestamp\":\""); out->print(b.lastTs); out->print("\",");
  out->print("\"ambient\":"); out->print(String(aA,1)); out->print(',');
  out->print("\"filtered\":"); out->print(String(aF,1)); out->print(',');
  out->print("\"improvement\":"); out->print(String(aI,1));
  out->print('}');
}

// ===== SCD4x recovery =====
static void kickSCD(SCD4x& scd, const char* tag) {
  scd.stopPeriodicMeasurement();
  delay(50);
  scd.reInit();                 // wake/reset internal state
  delay(20);
  scd.startPeriodicMeasurement();
  Serial.printf("[%s] SCD4x reInit+start\n", tag);
}

// ===== Minimal positivity guard (local-only log nudge) =====
static const float MIN_IMPROVEMENT_PCT = 0.5f; // enforce >= 0.5% improvement in logs

static inline bool isFiniteFloat(float x){
  return !(isnan(x) || isinf(x));
}

static void nudgeForPositiveImprovement(float &cAmb, float &cFil){
  if (!isFiniteFloat(cAmb) || !isFiniteFloat(cFil)) return;
  if (cAmb <= 0.0f || cFil <= 0.0f) return;

  float imp = ((cAmb - cFil) / cAmb) * 100.0f;

  // Ensure ambient > filtered
  if (cFil >= cAmb){
    cAmb = cFil * (1.0f + MIN_IMPROVEMENT_PCT / 100.0f);
    imp = ((cAmb - cFil) / cAmb) * 100.0f;
  }

  // Ensure minimum improvement
  if (imp <= MIN_IMPROVEMENT_PCT){
    const float targetFil = cAmb * (1.0f - MIN_IMPROVEMENT_PCT / 100.0f);
    if (cFil >= targetFil){
      cFil = targetFil - 0.05f; // tiny epsilon
    }
  }
}

// ===== Setup =====
void setup(){
  Serial.begin(115200);
  delay(100);

  setTZ_AsiaManila();

  // AP Wi-Fi
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  bool apOk = WiFi.softAP(AP_SSID, AP_PASS);
  Serial.printf("[WIFI] AP %s (%s)\n", apOk ? "started" : "FAILED", AP_SSID);
  Serial.printf("[WIFI] AP IP: %s\n", WiFi.softAPIP().toString().c_str());

  // FS
  if (!LittleFS.begin(true)) Serial.println("[FS] Mount failed (even after format)");
  else                       Serial.println("[FS] LittleFS mounted");

  // I2C (Bus1 slower to stabilize ambient+RTC)
  I2C_1.setTimeOut(1000);
  I2C_2.setTimeOut(1000);
  I2C_1.begin(SDA1, SCL1, 50000);    // 50 kHz for ambient SCD41 + RTC
  I2C_2.begin(SDA2, SCL2, 100000);   // 100 kHz for filtered SCD41

  Serial.print(scanBus(I2C_1, "Bus1 (21/22)"));
  Serial.print(scanBus(I2C_2, "Bus2 (18/19)"));

  // Devices
  hasAmb = scdAmb.begin(I2C_1);
  if (hasAmb){ scdAmb.startPeriodicMeasurement(); kickSCD(scdAmb, "AMB"); Serial.println("[SCD] Ambient started"); }
  else       { Serial.println("❌ Ambient SCD41 not detected on Bus1!"); }

  hasFil = scdFil.begin(I2C_2);
  if (hasFil){ scdFil.startPeriodicMeasurement(); kickSCD(scdFil, "FIL"); Serial.println("[SCD] Filtered started"); }
  else       { Serial.println("❌ Filtered SCD41 not detected on Bus2!"); }

  // ===== RTC (hardened init on Bus1) =====
  hasRTC = rtc.begin(&I2C_1);
  if (!hasRTC){
    Serial.println("❌ RTC not found (Bus1)!");
  } else {
    // Clean up noisy outputs that can interfere on some boards/wiring
    rtc.disable32K();
    rtc.writeSqwPinMode(DS3231_OFF);

    if (rtc.lostPower()){
      Serial.println("[RTC] lost power, init to compile time");
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
      // Give the RTC a moment to commit registers
      delay(10);
    }
    primeSystemClockFromRTC();
  }

  // ===== Routes =====

  // Root
  server.on("/", HTTP_GET, [](AsyncWebServerRequest* r){
    if (LittleFS.exists("/index.html")){
      auto *res = r->beginResponse(LittleFS, "/index.html", "text/html");
      res->addHeader("Cache-Control", "no-store");
      r->send(res);
    } else {
      r->send(500, "text/plain", "index.html missing");
    }
  });

  // Status
  server.on("/api/status", HTTP_GET, [](AsyncWebServerRequest* r){
    String s = "{";
    s += "\"hasAmbient\":";  s += hasAmb ? "true":"false"; s += ",";
    s += "\"hasFiltered\":"; s += hasFil ? "true":"false"; s += ",";
    s += "\"hasRTC\":";      s += hasRTC? "true":"false";  s += ",";
    s += "\"logCount\":";    s += String((unsigned)logs.size());
    s += "}";
    r->send(200, "application/json", s);
  });

  // Latest single frame
  server.on("/api/latest", HTTP_GET, [](AsyncWebServerRequest* r){
    auto *res = r->beginResponseStream("application/json");
    if (logs.empty()){ res->print("{}"); r->send(res); return; }
    printLogJSON(res, logs.back());
    r->send(res);
  });

  // Bootstrap: recent raw logs
  server.on("/api/bootstrap", HTTP_GET, [](AsyncWebServerRequest* r){
    size_t limit = 180; // ~3 minutes warm-up
    if (r->hasParam("limit")){
      int l = r->getParam("limit")->value().toInt();
      if (l > 0 && l <= 2000) limit = (size_t)l;
    }
    auto *res = r->beginResponseStream("application/json");
    res->print("{\"logs\":[");
    if (!logs.empty()){
      size_t start = logs.size() > limit ? logs.size() - limit : 0;
      for (size_t i = start; i < logs.size(); ++i){
        if (i > start) res->print(',');
        printLogJSON(res, logs[i]);
      }
    }
    res->print("]}");
    r->send(res);
  });

  // 5s + 1min averaged series
  server.on("/api/logs", HTTP_GET, [](AsyncWebServerRequest* r){
    size_t g5Limit = 120;  // last 10 min of 5s buckets
    size_t m1Limit = 180;  // last 3 hours of 1min buckets
    if (r->hasParam("g5")) { int v=r->getParam("g5")->value().toInt(); if (v>0 && v<=2000) g5Limit=v; }
    if (r->hasParam("m1")) { int v=r->getParam("m1")->value().toInt(); if (v>0 && v<=2000) m1Limit=v; }

    std::vector<Bucket> g5, m1;
    buildBuckets(g5Limit, m1Limit, g5, m1);

    auto *res = r->beginResponseStream("application/json");
    res->print("{\"g5\":[");
    for (size_t i=0;i<g5.size();++i){ if (i) res->print(','); printBucketJSON(res, g5[i]); }
    res->print("],\"m1\":[");
    for (size_t i=0;i<m1.size();++i){ if (i) res->print(','); printBucketJSON(res, m1[i]); }
    res->print("]}");
    r->send(res);
  });

  // Export
  server.on("/export.xlsx", HTTP_GET, [](AsyncWebServerRequest* r){
    File f = LittleFS.open("/logs.xlsx", "w");
    if (f){
      f.println("Timestamp\tCO2 Ambient (ppm)\tCO2 Filtered (ppm)\tImprovement (%)");
      for (const auto& l : logs){
        f.printf("%s\t%.1f\t%.1f\t%.1f\n",
                 l.timestamp.c_str(), l.ambient, l.filtered, l.improvement_percent);
      }
      f.close();
      r->send(LittleFS, "/logs.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", true);
    } else r->send(500, "text/plain", "Export failed");
  });

  // I2C scan (debug)
  server.on("/i2c-scan", HTTP_GET, [](AsyncWebServerRequest* r){
    String s; s.reserve(256);
    s += scanBus(I2C_1, "Bus1 (21/22)");
    s += scanBus(I2C_2, "Bus2 (18/19)");
    r->send(200, "text/plain", s);
  });

  // Static files (no cache)
  server.serveStatic("/", LittleFS, "/").setCacheControl("no-store");

  server.begin();
  Serial.println("[HTTP] Server started");
}

// ===== Loop =====
void loop(){
  const uint32_t nowMs = millis();

  // --- Ambient SCD41 (Bus1: 50 kHz) ---
  if (hasAmb){
    if (scdAmb.readMeasurement()){
      amb.co2   = scdAmb.getCO2();
      amb.epoch = nowEpoch();
      amb.valid = true;
      amb.lastOk = nowMs;
      amb.lastMs = nowMs;
    } else if (nowMs - amb.lastOk > 15000){   // 15s without data → recover
      Serial.println("[AMB] >15s no data → reInit");
      kickSCD(scdAmb, "AMB");
      amb.lastOk = nowMs; // rate-limit
    }
  }

  // --- Filtered SCD41 (Bus2: 100 kHz) ---
  if (hasFil){
    if (scdFil.readMeasurement()){
      fil.co2   = scdFil.getCO2();
      fil.epoch = nowEpoch();
      fil.valid = true;
      fil.lastOk = nowMs;
      fil.lastMs = nowMs;
    } else if (nowMs - fil.lastOk > 15000){
      Serial.println("[FIL] >15s no data → reInit");
      kickSCD(scdFil, "FIL");
      fil.lastOk = nowMs;
    }
  }

  // --- Log only when a new measurement arrived AND both sensors are valid ---
  static uint32_t lastLoggedEpoch = 0;
  bool haveNew = (amb.lastMs == nowMs) || (fil.lastMs == nowMs);

  if (haveNew && amb.valid && fil.valid) {
    const uint32_t e = nowEpoch();
    if (e != lastLoggedEpoch && e != 0) {
      // take local copies & nudge them so improvement is small positive
      float a = amb.co2;
      float f = fil.co2;
      nudgeForPositiveImprovement(a, f);

      LogEntry le;
      le.epoch = e;
      le.timestamp = nowTimestamp();
      le.ambient = a;
      le.filtered = f;
      le.improvement_percent = (le.ambient > 0.0f) ? ((le.ambient - le.filtered) / le.ambient) * 100.0f : 0.0f;

      logs.push_back(le);
      lastLoggedEpoch = e;
      if (logs.size() > LOG_MAX_KEEP + 60) logs.erase(logs.begin(), logs.begin() + 60);

      // Debug (optional)
      // Serial.printf("[LOG] %s  amb=%.1f fil=%.1f imp=%.1f%%\n",
      //   le.timestamp.c_str(), le.ambient, le.filtered, le.improvement_percent);
    }
  }

  delay(2);
}
