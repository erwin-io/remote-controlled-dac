#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>
#include <math.h>

#define PMS_RX 16
#define PMS_TX 17
HardwareSerial pmsSerial(2);

// ======== WiFi Credentials ========
const char* ssid = "HG8145V5_D0A04";
const char* password = "p75z~${Tn2Iy";

// ======== Server Endpoint ========
const char* serverUrl = "https://192.168.1.15:3000/api/log-readings"; // Use your actual endpoint

// ======== Timing Settings ========
#define READ_INTERVAL_MS 3000      // Every 3 seconds
#define POST_INTERVAL_MS 30000     // Every 30 seconds
#define MAX_ENTRIES 30

unsigned long lastReadTime = 0;
unsigned long lastPostTime = 0;

// ======== Timezone Config ========
const char* ntpServer = "pool.ntp.org";
const long gmtOffset_sec = 8 * 3600;  // GMT+8
const int daylightOffset_sec = 0;

// ======== Data Buffer ========
struct SensorData {
  int co2;
  String timestamp;
};

SensorData dataLog[MAX_ENTRIES];
int dataIndex = 0;

void setup() {
  Serial.begin(115200);
  pmsSerial.begin(9600, SERIAL_8N1, PMS_RX, PMS_TX);

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" Connected!");

  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
}

void loop() {
  unsigned long now = millis();

  // === Read every 3 seconds ===
  if (now - lastReadTime >= READ_INTERVAL_MS && pmsSerial.available() >= 32) {
    lastReadTime = now;

    if (pmsSerial.read() == 0x42 && pmsSerial.read() == 0x4D) {
      byte buffer[30];
      pmsSerial.readBytes(buffer, 30);
      int pm25 = (buffer[4] << 8) | buffer[5];

      float co2Float = 400 + (log(pm25 + 1) * 150);
      int CO2 = round(co2Float);
      if (CO2 < 400) CO2 = 400;
      if (CO2 > 2000) CO2 = 2000;

      struct tm timeinfo;
      if (!getLocalTime(&timeinfo)) {
        Serial.println("❌ Failed to get time");
        return;
      }

      char timeStr[30];
      strftime(timeStr, sizeof(timeStr), "%Y-%m-%d %H:%M:%S", &timeinfo);

      if (dataIndex < MAX_ENTRIES) {
        dataLog[dataIndex++] = { CO2, String(timeStr) };
        Serial.printf("📌 Stored: CO2=%d ppm @ %s\n", CO2, timeStr);
      }
    }
  }

  // === Send every 30s if we have 10 or more readings ===
  if (now - lastPostTime >= POST_INTERVAL_MS && dataIndex >= 10) {
    lastPostTime = now;
    sendData();
  }
}

void sendData() {
  if (WiFi.status() == WL_CONNECTED) {
    WiFiClientSecure client;
    client.setInsecure(); // For self-signed certs or development only

    HTTPClient http;
    http.begin(client, serverUrl);

    http.addHeader("Content-Type", "application/json");
    http.setTimeout(10000); // Optional: 10 second timeout

    // Build readings JSON array
    String readingsJson = "[";
    for (int i = 0; i < dataIndex; i++) {
      readingsJson += "{";
      readingsJson += "\"co2\":" + String(dataLog[i].co2) + ",";
      readingsJson += "\"timestamp\":\"" + dataLog[i].timestamp + "\"";
      readingsJson += "}";
      if (i < dataIndex - 1) readingsJson += ",";
    }
    readingsJson += "]";

    // Final JSON object
    unsigned long batchTimestamp = millis();
    String json = "{";
    json += "\"timestamp\":" + String(batchTimestamp) + ",";
    json += "\"readings\":" + readingsJson;
    json += "}";

    Serial.println("📤 Sending JSON:");
    Serial.println(json);

    int httpResponseCode = http.POST(json);
    if (httpResponseCode > 0) {
      Serial.printf("✅ POST success: %d\n", httpResponseCode);
      dataIndex = 0;  // Clear buffer after successful send
    } else {
      Serial.printf("❌ POST failed: %s\n", http.errorToString(httpResponseCode).c_str());
    }

    http.end();
  } else {
    Serial.println("❌ WiFi not connected");
  }
}
