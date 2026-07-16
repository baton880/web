#include <WiFi.h>
#include <ESPmDNS.h>
#include <WiFiUdp.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoOTA.h>
#include <SPI.h>
#include <SD.h>
#include <time.h>
#include <math.h>
#include <esp_system.h>

HardwareSerial RTK(2);
String line = "";

// --- Network/server settings (easy to change) ---
const char* WIFI_PRIMARY_SSID = "ISRK_Hozyain";
const char* WIFI_PRIMARY_PASS = "SrostkiKorovki";
const char* WIFI_FALLBACK_SSID = "Sasung";
const char* WIFI_FALLBACK_PASS = "223334444";
const char* TELEMETRY_URL = "https://vi-korm.ru/api/telemetry/rtk";
const char* DEVICE_ID = "rtk_loader_01";
const char* OTA_HOSTNAME = "rtk-loader-01";
const char* FIRMWARE_VERSION = "2026.07.15-reliable-1";

// --- UART pins for Ardusimple ---
const int RTK_RX_PIN = 17;
const int RTK_TX_PIN = 16;

// --- SD card pins ---
const int SD_CS_PIN = 5;
const int SD_SCK_PIN = 18;
const int SD_MOSI_PIN = 23;
const int SD_MISO_PIN = 19;

const unsigned long WIFI_CONNECT_TIMEOUT_MS = 7000;
const unsigned long WIFI_RETRY_CYCLE_MS = 5000;
const unsigned long SD_RETRY_MS = 5000;
const unsigned long FLUSH_BACKOFF_MIN_MS = 1000;
const unsigned long FLUSH_BACKOFF_MAX_MS = 60000;
const unsigned long LIVE_SEND_BACKOFF_MIN_MS = 1000;
const unsigned long LIVE_SEND_BACKOFF_MAX_MS = 5000;
const unsigned long HTTP_CONNECT_TIMEOUT_MS = 3000;
const unsigned long HTTP_TOTAL_TIMEOUT_MS = 5000;
const unsigned long QUEUE_FLUSH_AFTER_LIVE_OK_MS = 45000;
const int FLUSH_BATCH_MAX = 16;
const int SD_QUEUE_HARD_MAX_ROWS = 1800;
const int SD_QUEUE_TRIM_TO_ROWS = 900;
const uint64_t SD_FREE_GUARD_BYTES = 64ULL * 1024ULL;
const int SD_INIT_RETRIES = 5;
const int RAM_QUEUE_MAX = 64;
const unsigned long TELEMETRY_INTERVAL_MS = 1000;
const unsigned long STATIONARY_DETECT_MS = 15UL * 60UL * 1000UL;
const unsigned long STATIONARY_TELEMETRY_INTERVAL_MS = 60UL * 1000UL;
const unsigned long STATIONARY_SKIP_LOG_INTERVAL_MS = 60UL * 1000UL;
const double STATIONARY_BASE_RADIUS_M = 3.0;
const double STATIONARY_HACC_MULTIPLIER = 2.0;
const double STATIONARY_MAX_RADIUS_M = 30.0;
const unsigned long RELPOS_FRESH_MS = 3000;
const unsigned long SPEED_FRESH_MS = 3000;
const unsigned long TIME_SKIP_LOG_INTERVAL_MS = 5000;
const char* QUEUE_FILE = "/telemetry_queue.jsonl";
const char* QUEUE_TMP_FILE = "/telemetry_queue.tmp";
const char* QUEUE_BACKUP_FILE = "/telemetry_queue.bak";
const char* QUEUE_META_FILE = "/telemetry_queue.meta";
const char* QUEUE_META_TMP_FILE = "/telemetry_queue.meta.tmp";
const uint32_t SD_SPEEDS[] = {8000000, 4000000, 1000000, 400000};
const int SD_SPEEDS_COUNT = sizeof(SD_SPEEDS) / sizeof(SD_SPEEDS[0]);
const int UBX_PAYLOAD_MAX = 128;
const int RTK_RX_BUFFER_BYTES = 8192;
const int SENDER_TASK_STACK_BYTES = 16384;
const int QUEUE_COMPACT_AFTER_ACK_ROWS = 256;
const uint32_t QUEUE_COMPACT_MIN_PREFIX_BYTES = 64UL * 1024UL;
const double STATIONARY_WAKE_SPEED_KMH = 1.0;

enum SendResult {
  SEND_RESULT_OK,
  SEND_RESULT_RETRY,
  SEND_RESULT_REJECTED
};

const uint8_t UBX_CLASS_NAV = 0x01;
const uint8_t UBX_ID_NAV_RELPOSNED = 0x3C;
const int UBX_WAIT_SYNC1 = 0;
const int UBX_WAIT_SYNC2 = 1;
const int UBX_READ_CLASS = 2;
const int UBX_READ_ID = 3;
const int UBX_READ_LEN1 = 4;
const int UBX_READ_LEN2 = 5;
const int UBX_READ_PAYLOAD = 6;
const int UBX_READ_CK_A = 7;
const int UBX_READ_CK_B = 8;
const int UBX_SKIP_PAYLOAD = 9;

struct WifiProfile {
  const char* ssid;
  const char* pass;
  const char* profileName;
};

const WifiProfile WIFI_PROFILES[] = {
  {WIFI_PRIMARY_SSID, WIFI_PRIMARY_PASS, "primary"},
  {WIFI_FALLBACK_SSID, WIFI_FALLBACK_PASS, "fallback"}
};
const int WIFI_PROFILE_COUNT = sizeof(WIFI_PROFILES) / sizeof(WIFI_PROFILES[0]);

bool wifiAttemptActive = false;
bool wifiWasConnected = false;
int wifiAttemptProfileIndex = -1;
int wifiConnectedProfileIndex = -1;
unsigned long wifiAttemptStartedMs = 0;
unsigned long wifiRetryAllowedAtMs = 0;

unsigned long lastFlushAttemptMs = 0;
unsigned long lastSdAttemptMs = 0;
unsigned long flushBackoffMs = FLUSH_BACKOFF_MIN_MS;
unsigned long liveSendBlockedUntilMs = 0;
unsigned long liveSendBackoffMs = LIVE_SEND_BACKOFF_MIN_MS;
unsigned long lastLiveSendOkMs = 0;
volatile bool sdReady = false;
volatile bool otaStarted = false;
volatile bool otaInProgress = false;
unsigned long lastTelemetryMs = 0;
unsigned long lastTimeSkipLogMs = 0;
unsigned long stationaryAnchorMs = 0;
unsigned long lastStationarySkipLogMs = 0;
double stationaryAnchorLat = NAN;
double stationaryAnchorLon = NAN;
bool stationaryAnchorValid = false;
bool stationaryModeActive = false;
String ramQueue[RAM_QUEUE_MAX];
int ramQueueHead = 0;
int ramQueueCount = 0;
int sdQueueCount = 0;
uint32_t sdQueueHeadOffset = 0;
int sdRowsAckedSinceCompact = 0;
String lastRmcDateYmd = "";
bool lastRmcDateValid = false;
String maintainedDateYmd = "";
bool maintainedDateValid = false;
int lastGgaSecondOfDay = -1;
uint32_t nmeaSentenceSequence = 0;
uint32_t lastGgaNmeaSequence = 0;
uint32_t lastRmcNmeaSequence = 0;
time_t lastFormattedEpoch = 0;
int movingSpeedSamples = 0;
double latestHaccM = NAN;
double latestSpeedKmh = NAN;
unsigned long latestSpeedReceivedMs = 0;
WiFiClientSecure telemetryClient;
HTTPClient telemetryHttp;
bool telemetryHttpReady = false;
QueueHandle_t telemetryWorkQueue = nullptr;
TaskHandle_t telemetrySenderTaskHandle = nullptr;
char bootId[17] = {0};
uint32_t packetSequence = 0;

uint8_t ubxState = UBX_WAIT_SYNC1;
uint8_t ubxClass = 0;
uint8_t ubxId = 0;
uint16_t ubxLength = 0;
uint16_t ubxIndex = 0;
uint16_t ubxSkipRemaining = 0;
uint8_t ubxChecksumA = 0;
uint8_t ubxChecksumB = 0;
uint8_t ubxPayload[UBX_PAYLOAD_MAX];

struct RelPosData {
  bool seen;
  unsigned long receivedMs;
  uint32_t iTow;
  double relPosNM;
  double relPosEM;
  double relPosDM;
  double baselineM;
  double headingDeg;
  double accNM;
  double accEM;
  double accDM;
  double baselineAccM;
  double headingAccDeg;
  uint32_t flags;
  bool relPosValid;
  bool headingValid;
  int carrierSolution;
};

RelPosData latestRelPos = {
  false,
  0,
  0,
  NAN,
  NAN,
  NAN,
  NAN,
  NAN,
  NAN,
  NAN,
  NAN,
  NAN,
  NAN,
  0,
  false,
  false,
  0
};

struct GpsData {
  String timestamp;
  String timeSource;
  double lat;
  double lon;
  double haccM;
  double speedKmh;
  double corrAgeS;
  double hdop;
  double altitudeM;
  int gpsSatellites;
  int gpsQuality;
};

String getField(const String& s, int index) {
  int found = 0;
  int start = 0;

  for (int i = 0; i <= s.length(); i++) {
    if (i == s.length() || s[i] == ',') {
      if (found == index) {
        return s.substring(start, i);
      }
      found++;
      start = i + 1;
    }
  }
  return "";
}

int countChar(const String& s, char target) {
  int n = 0;
  for (size_t i = 0; i < s.length(); i++) {
    if (s[i] == target) n++;
  }
  return n;
}

bool isDigitsOnly(const String& s) {
  if (s.length() == 0) return false;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c < '0' || c > '9') return false;
  }
  return true;
}

bool parseFiniteDouble(const String& s, double& out) {
  if (s.length() == 0) return false;
  char* endp = nullptr;
  double v = strtod(s.c_str(), &endp);
  if (endp == s.c_str()) return false;
  if (isnan(v) || isinf(v)) return false;
  out = v;
  return true;
}

String compileDateYmd() {
  // __DATE__ format: "Mmm dd yyyy"
  const char* d = __DATE__;
  String monthStr = String(d).substring(0, 3);
  String dayStr = String(d).substring(4, 6);
  String yearStr = String(d).substring(7, 11);
  dayStr.trim();

  int month = 1;
  if (monthStr == "Jan") month = 1;
  else if (monthStr == "Feb") month = 2;
  else if (monthStr == "Mar") month = 3;
  else if (monthStr == "Apr") month = 4;
  else if (monthStr == "May") month = 5;
  else if (monthStr == "Jun") month = 6;
  else if (monthStr == "Jul") month = 7;
  else if (monthStr == "Aug") month = 8;
  else if (monthStr == "Sep") month = 9;
  else if (monthStr == "Oct") month = 10;
  else if (monthStr == "Nov") month = 11;
  else if (monthStr == "Dec") month = 12;

  int day = dayStr.toInt();
  int year = yearStr.toInt();
  if (day < 1 || day > 31 || year < 2000) return "2026-01-01";

  char buf[11];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02d", year, month, day);
  return String(buf);
}

double nmeaToDecimal(const String& val, const String& dir) {
  if (val.length() < 4) return 0.0;

  double raw = val.toDouble();
  int degrees = int(raw / 100);
  double minutes = raw - degrees * 100;
  double decimal = degrees + minutes / 60.0;

  if (dir == "S" || dir == "W") decimal = -decimal;
  return decimal;
}

bool readSystemUtc(struct tm& tmUtc) {
  time_t now = time(nullptr);
  if (now <= 1700000000) {
    return false;
  }

  gmtime_r(&now, &tmUtc);
  return tmUtc.tm_year + 1900 >= 2024;
}

String formatSystemIsoUtc(const struct tm& tmUtc) {
  char buf[25];
  snprintf(
    buf,
    sizeof(buf),
    "%04d-%02d-%02dT%02d:%02d:%02d.000Z",
    tmUtc.tm_year + 1900,
    tmUtc.tm_mon + 1,
    tmUtc.tm_mday,
    tmUtc.tm_hour,
    tmUtc.tm_min,
    tmUtc.tm_sec
  );
  return String(buf);
}

bool parseYmd(const String& ymd, int& year, int& month, int& day) {
  if (ymd.length() != 10 || ymd[4] != '-' || ymd[7] != '-') return false;
  String yyyy = ymd.substring(0, 4);
  String mm = ymd.substring(5, 7);
  String dd = ymd.substring(8, 10);
  if (!isDigitsOnly(yyyy) || !isDigitsOnly(mm) || !isDigitsOnly(dd)) return false;
  year = yyyy.toInt();
  month = mm.toInt();
  day = dd.toInt();
  return year >= 2024 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

String formatYmd(int year, int month, int day) {
  char buf[11];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02d", year, month, day);
  return String(buf);
}

bool incrementYmd(String& ymd) {
  int year = 0;
  int month = 0;
  int day = 0;
  if (!parseYmd(ymd, year, month, day)) return false;
  const int monthDays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  int days = monthDays[month - 1];
  bool leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
  if (month == 2 && leap) days = 29;
  day++;
  if (day > days) {
    day = 1;
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  ymd = formatYmd(year, month, day);
  return true;
}

time_t epochFromYmdHms(const String& ymd, int hour, int minute, int second) {
  int year = 0;
  int month = 0;
  int day = 0;
  if (!parseYmd(ymd, year, month, day)) return 0;
  year -= month <= 2;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yearOfEra = (unsigned)(year - era * 400);
  const unsigned dayOfYear = (153U * (unsigned)(month + (month > 2 ? -3 : 9)) + 2U) / 5U + (unsigned)day - 1U;
  const unsigned dayOfEra = yearOfEra * 365U + yearOfEra / 4U - yearOfEra / 100U + dayOfYear;
  int64_t daysSinceEpoch = (int64_t)era * 146097LL + (int64_t)dayOfEra - 719468LL;
  return (time_t)(daysSinceEpoch * 86400LL + hour * 3600LL + minute * 60LL + min(second, 59));
}

bool formatNmeaTime(const String& nmeaTime, String& out, String& sourceOut) {
  struct tm tmUtc;
  bool systemTimeValid = readSystemUtc(tmUtc);

  // Expected format: hhmmss.sss. If GGA time is absent but NTP is valid,
  // send with current system time instead of inventing 00:00:00Z.
  if (nmeaTime.length() < 6 || !isDigitsOnly(nmeaTime.substring(0, 6))) {
    if (!systemTimeValid) {
      return false;
    }
    out = formatSystemIsoUtc(tmUtc);
    sourceOut = "ntp";
    lastFormattedEpoch = time(nullptr);
    return true;
  }

  String hh = nmeaTime.substring(0, 2);
  String mm = nmeaTime.substring(2, 4);
  String ss = nmeaTime.substring(4, 6);
  String ms = "000";
  int hhI = hh.toInt();
  int mmI = mm.toInt();
  int ssI = ss.toInt();
  if (hhI < 0 || hhI > 23 || mmI < 0 || mmI > 59 || ssI < 0 || ssI > 60) {
    return false;
  }

  int secondOfDay = hhI * 3600 + mmI * 60 + min(ssI, 59);
  if (maintainedDateValid && lastGgaSecondOfDay >= 23 * 3600 && secondOfDay <= 3600) {
    bool rmcUpdatedSincePreviousGga = lastRmcNmeaSequence != 0 &&
      (int32_t)(lastRmcNmeaSequence - lastGgaNmeaSequence) > 0;
    if (rmcUpdatedSincePreviousGga && lastRmcDateValid) {
      maintainedDateYmd = lastRmcDateYmd;
      sourceOut = "rmc_rollover";
    } else if (incrementYmd(maintainedDateYmd)) {
      sourceOut = "gga_rollover";
    }
  }

  String dateYmd = maintainedDateValid ? maintainedDateYmd : "";
  if (dateYmd.length() != 10 && lastRmcDateValid) {
    dateYmd = lastRmcDateYmd;
    sourceOut = "rmc";
  }
  if (dateYmd.length() != 10 && systemTimeValid) {
    dateYmd = formatYmd(tmUtc.tm_year + 1900, tmUtc.tm_mon + 1, tmUtc.tm_mday);
    sourceOut = "ntp_date";
  }
  if (dateYmd.length() != 10) return false;

  if (sourceOut.length() == 0) {
    sourceOut = (lastRmcDateValid && maintainedDateYmd == lastRmcDateYmd) ? "rmc" : "maintained";
  }

  time_t candidateEpoch = epochFromYmdHms(dateYmd, hhI, mmI, ssI);
  if (systemTimeValid && candidateEpoch > 0 && fabs(difftime(candidateEpoch, time(nullptr))) > 12.0 * 3600.0) {
    dateYmd = formatYmd(tmUtc.tm_year + 1900, tmUtc.tm_mon + 1, tmUtc.tm_mday);
    candidateEpoch = epochFromYmdHms(dateYmd, hhI, mmI, ssI);
    sourceOut = "ntp_date_repair";
  }

  if (candidateEpoch <= 0 || (lastFormattedEpoch > 0 && candidateEpoch + 300 < lastFormattedEpoch)) {
    return false;
  }

  maintainedDateYmd = dateYmd;
  maintainedDateValid = true;
  lastGgaSecondOfDay = secondOfDay;
  lastGgaNmeaSequence = nmeaSentenceSequence;
  lastFormattedEpoch = candidateEpoch;

  if (nmeaTime.length() > 7 && nmeaTime[6] == '.') {
    String frac = nmeaTime.substring(7);
    String msOnly = "";
    for (size_t i = 0; i < frac.length(); i++) {
      char c = frac[i];
      if (c < '0' || c > '9') break;
      msOnly += c;
      if (msOnly.length() == 3) break;
    }
    while (msOnly.length() < 3) msOnly += "0";
    if (msOnly.length() == 3) ms = msOnly;
  }

  out = dateYmd + "T" + hh + ":" + mm + ":" + ss + "." + ms + "Z";
  return true;
}

String escapeJson(const String& s) {
  String out;
  out.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '\\' || c == '"') {
      out += '\\';
      out += c;
    } else if (c == '\n') {
      out += "\\n";
    } else if (c == '\r') {
      out += "\\r";
    } else if (c == '\t') {
      out += "\\t";
    } else {
      out += c;
    }
  }
  return out;
}

String formatDoubleOrNull(double value, int precision) {
  if (isnan(value) || isinf(value)) return "null";
  return String(value, precision);
}

String formatLongOrNull(long value, bool valid) {
  if (!valid) return "null";
  return String(value);
}

String formatBool(bool value) {
  return value ? "true" : "false";
}

String carrierSolutionLabel(int value) {
  if (value == 2) return "fixed";
  if (value == 1) return "float";
  return "none";
}

bool isRelPosFresh() {
  return latestRelPos.seen && (millis() - latestRelPos.receivedMs <= RELPOS_FRESH_MS);
}

bool isSpeedFresh() {
  return !isnan(latestSpeedKmh) && !isinf(latestSpeedKmh) && (millis() - latestSpeedReceivedMs <= SPEED_FRESH_MS);
}

double degToRad(double deg) {
  return deg * PI / 180.0;
}

double distanceMeters(double lat1, double lon1, double lat2, double lon2) {
  const double earthRadiusM = 6371000.0;
  double dLat = degToRad(lat2 - lat1);
  double dLon = degToRad(lon2 - lon1);
  double rLat1 = degToRad(lat1);
  double rLat2 = degToRad(lat2);

  double a = sin(dLat / 2.0) * sin(dLat / 2.0) +
             cos(rLat1) * cos(rLat2) * sin(dLon / 2.0) * sin(dLon / 2.0);
  double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
  return earthRadiusM * c;
}

double stationaryRadiusM(double haccM) {
  double radius = STATIONARY_BASE_RADIUS_M;

  if (!isnan(haccM) && !isinf(haccM) && haccM > 0) {
    radius = max(radius, haccM * STATIONARY_HACC_MULTIPLIER);
  }

  return min(radius, STATIONARY_MAX_RADIUS_M);
}

bool updateStationaryMode(const GpsData& data, unsigned long nowMs) {
  if (!stationaryAnchorValid) {
    stationaryAnchorValid = true;
    stationaryAnchorLat = data.lat;
    stationaryAnchorLon = data.lon;
    stationaryAnchorMs = nowMs;
    stationaryModeActive = false;
    return false;
  }

  if (isSpeedFresh() && latestSpeedKmh >= STATIONARY_WAKE_SPEED_KMH) {
    movingSpeedSamples = min(movingSpeedSamples + 1, 2);
  } else {
    movingSpeedSamples = 0;
  }

  if (movingSpeedSamples >= 2) {
    if (stationaryModeActive) Serial.println("Stationary mode off, speed confirmed");
    stationaryAnchorLat = data.lat;
    stationaryAnchorLon = data.lon;
    stationaryAnchorMs = nowMs;
    stationaryModeActive = false;
    return false;
  }

  double movedM = distanceMeters(stationaryAnchorLat, stationaryAnchorLon, data.lat, data.lon);
  double allowedM = stationaryRadiusM(data.haccM);

  if (movedM > allowedM) {
    if (stationaryModeActive) {
      Serial.print("Stationary mode off, moved m=");
      Serial.println(movedM, 1);
    }
    stationaryAnchorLat = data.lat;
    stationaryAnchorLon = data.lon;
    stationaryAnchorMs = nowMs;
    stationaryModeActive = false;
    return false;
  }

  if (!stationaryModeActive && nowMs - stationaryAnchorMs >= STATIONARY_DETECT_MS) {
    stationaryModeActive = true;
    Serial.print("Stationary mode on, radius m=");
    Serial.println(allowedM, 1);
  }

  return stationaryModeActive;
}

String stripChecksum(String value) {
  int star = value.indexOf('*');
  if (star >= 0) {
    value = value.substring(0, star);
  }
  value.trim();
  return value;
}

String normalizeFieldKey(String value) {
  value = stripChecksum(value);
  value.toLowerCase();

  String out;
  out.reserve(value.length());
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    if (c != '_' && c != '-' && c != ' ') {
      out += c;
    }
  }
  return out;
}

bool parseUnsigned32(const String& raw, uint32_t& out) {
  String value = stripChecksum(raw);
  if (value.length() == 0) return false;

  char* endp = nullptr;
  unsigned long parsed = 0;
  if (value.startsWith("0x") || value.startsWith("0X")) {
    parsed = strtoul(value.c_str() + 2, &endp, 16);
  } else {
    parsed = strtoul(value.c_str(), &endp, 10);
  }

  if (endp == value.c_str()) return false;
  out = (uint32_t)parsed;
  return true;
}

String findKeyValue(const String& sentence, const char* key) {
  String target = normalizeFieldKey(String(key));

  for (int i = 0; i < 32; i++) {
    String field = stripChecksum(getField(sentence, i));
    if (field.length() == 0 && i > countChar(sentence, ',')) break;

    int sep = field.indexOf('=');
    if (sep < 0) sep = field.indexOf(':');
    if (sep <= 0) continue;

    String currentKey = normalizeFieldKey(field.substring(0, sep));
    if (currentKey == target) {
      return stripChecksum(field.substring(sep + 1));
    }
  }

  return "";
}

bool parseKeyedDouble(const String& sentence, double& out, const char* key1, const char* key2 = nullptr, const char* key3 = nullptr) {
  String value = findKeyValue(sentence, key1);
  if (value.length() == 0 && key2) value = findKeyValue(sentence, key2);
  if (value.length() == 0 && key3) value = findKeyValue(sentence, key3);
  return parseFiniteDouble(value, out);
}

bool parseKeyedU32(const String& sentence, uint32_t& out, const char* key1, const char* key2 = nullptr, const char* key3 = nullptr) {
  String value = findKeyValue(sentence, key1);
  if (value.length() == 0 && key2) value = findKeyValue(sentence, key2);
  if (value.length() == 0 && key3) value = findKeyValue(sentence, key3);
  return parseUnsigned32(value, out);
}

int detectWifiProfileIndex(const String& ssid) {
  for (int i = 0; i < WIFI_PROFILE_COUNT; i++) {
    if (ssid == WIFI_PROFILES[i].ssid) return i;
  }
  return -1;
}

const char* wifiProfileNameByIndex(int idx) {
  if (idx >= 0 && idx < WIFI_PROFILE_COUNT) return WIFI_PROFILES[idx].profileName;
  return "unknown";
}

String currentWifiNetworkName() {
  if (WiFi.status() != WL_CONNECTED) return "disconnected";
  return WiFi.SSID();
}

void startWifiAttempt(int profileIndex) {
  if (profileIndex < 0 || profileIndex >= WIFI_PROFILE_COUNT) return;

  wifiAttemptProfileIndex = profileIndex;
  wifiAttemptStartedMs = millis();
  wifiAttemptActive = true;

  WiFi.disconnect(false, false);
  WiFi.begin(WIFI_PROFILES[profileIndex].ssid, WIFI_PROFILES[profileIndex].pass);

  Serial.print("WiFi connect attempt: ");
  Serial.print(WIFI_PROFILES[profileIndex].ssid);
  Serial.print(" (");
  Serial.print(WIFI_PROFILES[profileIndex].profileName);
  Serial.println(")");
}

String buildPayload(const GpsData& data, uint32_t sequence) {
  bool wifiConnected = (WiFi.status() == WL_CONNECTED);
  long wifiRssi = wifiConnected ? WiFi.RSSI() : 0;
  int totalQueueLen = ramQueueCount + sdQueueCount;
  bool hasRelPos = isRelPosFresh();

  String payload;
  payload.reserve(720);

  payload += "{";
  payload += "\"packetType\":\"" + String(hasRelPos ? "moving_base" : "pvt") + "\",";
  payload += "\"deviceId\":\"" + escapeJson(String(DEVICE_ID)) + "\",";
  payload += "\"firmware_version\":\"" + escapeJson(String(FIRMWARE_VERSION)) + "\",";
  payload += "\"boot_id\":\"" + escapeJson(String(bootId)) + "\",";
  payload += "\"packet_id\":\"" + escapeJson(String(bootId) + ":" + String(sequence)) + "\",";
  payload += "\"timestamp\":\"" + escapeJson(data.timestamp) + "\",";
  payload += "\"time_source\":\"" + escapeJson(data.timeSource) + "\",";
  payload += "\"lat\":" + formatDoubleOrNull(data.lat, 7) + ",";
  payload += "\"lon\":" + formatDoubleOrNull(data.lon, 7) + ",";
  payload += "\"hacc\":" + formatDoubleOrNull(data.haccM, 3) + ",";
  payload += "\"quality\":" + String(data.gpsQuality) + ",";
  payload += "\"satellites\":" + String(data.gpsSatellites) + ",";
  payload += "\"speed_kmh\":" + formatDoubleOrNull(data.speedKmh, 2) + ",";
  payload += "\"corr_age_s\":" + formatDoubleOrNull(data.corrAgeS, 1) + ",";

  if (hasRelPos) {
    payload += "\"heading\":" + formatDoubleOrNull(latestRelPos.headingDeg, 5) + ",";
    payload += "\"baseline_m\":" + formatDoubleOrNull(latestRelPos.baselineM, 4) + ",";
    payload += "\"heading_acc_deg\":" + formatDoubleOrNull(latestRelPos.headingAccDeg, 5) + ",";
    payload += "\"baseline_acc_m\":" + formatDoubleOrNull(latestRelPos.baselineAccM, 4) + ",";
    payload += "\"rel_pos_valid\":" + formatBool(latestRelPos.relPosValid) + ",";
    payload += "\"rel_pos_carrier_solution\":\"" + carrierSolutionLabel(latestRelPos.carrierSolution) + "\",";
    payload += "\"rel_pos_flags\":" + String(latestRelPos.flags) + ",";
  }

  // Report the actual connected SSID, not the internal primary/fallback label.
  payload += "\"wifi_profile\":\"" + escapeJson(currentWifiNetworkName()) + "\",";
  payload += "\"rssi_dbm\":" + formatLongOrNull(wifiRssi, wifiConnected) + ",";
  payload += "\"sd_queue_len\":" + String(sdQueueCount) + ",";
  payload += "\"ram_queue_len\":" + String(ramQueueCount) + ",";
  payload += "\"stationary\":" + formatBool(stationaryModeActive) + ",";
  payload += "\"telemetry_interval_ms\":" + String(stationaryModeActive ? STATIONARY_TELEMETRY_INTERVAL_MS : TELEMETRY_INTERVAL_MS) + ",";
  payload += "\"queue_len\":" + String(totalQueueLen);
  payload += "}";

  return payload;
}

bool isPermanentPayloadRejectCode(int code) {
  return code == 400 || code == 413 || code == 422;
}

SendResult sendPayload(const String& payload) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("HTTP send skipped: WiFi disconnected");
    return SEND_RESULT_RETRY;
  }

  if (!telemetryHttpReady) {
    telemetryHttp.setConnectTimeout(HTTP_CONNECT_TIMEOUT_MS);
    telemetryHttp.setTimeout(HTTP_TOTAL_TIMEOUT_MS);
    telemetryHttp.setReuse(true);
    if (!telemetryHttp.begin(telemetryClient, TELEMETRY_URL)) {
      Serial.print("HTTP begin failed: ");
      Serial.println(TELEMETRY_URL);
      return SEND_RESULT_RETRY;
    }
    telemetryHttp.addHeader("Content-Type", "application/json");
    telemetryHttp.addHeader("Connection", "keep-alive");
    telemetryHttpReady = true;
  }

  int code = telemetryHttp.POST(payload);
  bool ok = (code >= 200 && code < 300);
  String responseBody = (!ok && code > 0) ? telemetryHttp.getString() : "";
  SendResult result = SEND_RESULT_RETRY;

  if (!ok) {
    telemetryHttp.end();
    telemetryHttpReady = false;
    Serial.print("HTTP send failed, code=");
    Serial.println(code);
    if (responseBody.length() > 0) {
      Serial.print("HTTP body: ");
      Serial.println(responseBody);
    }
    if (isPermanentPayloadRejectCode(code)) {
      result = SEND_RESULT_REJECTED;
    }
  } else {
    Serial.print("HTTP send ok, code=");
    Serial.println(code);
    result = SEND_RESULT_OK;
  }

  return result;
}

bool persistQueueHeadOffset() {
  if (!sdReady) return false;
  SD.remove(QUEUE_META_TMP_FILE);
  File out = SD.open(QUEUE_META_TMP_FILE, FILE_WRITE);
  if (!out) return false;
  out.println(sdQueueHeadOffset);
  out.close();
  SD.remove(QUEUE_META_FILE);
  return SD.rename(QUEUE_META_TMP_FILE, QUEUE_META_FILE);
}

void loadQueueHeadOffset() {
  sdQueueHeadOffset = 0;
  if (!sdReady || !SD.exists(QUEUE_FILE) || !SD.exists(QUEUE_META_FILE)) return;
  File meta = SD.open(QUEUE_META_FILE, FILE_READ);
  if (!meta) return;
  String raw = meta.readStringUntil('\n');
  meta.close();
  uint32_t parsed = (uint32_t)strtoul(raw.c_str(), nullptr, 10);
  File queue = SD.open(QUEUE_FILE, FILE_READ);
  if (!queue) return;
  uint32_t size = (uint32_t)queue.size();
  queue.close();
  if (parsed <= size) sdQueueHeadOffset = parsed;
}

int countSdQueueRows() {
  if (!sdReady || !SD.exists(QUEUE_FILE)) return 0;

  File in = SD.open(QUEUE_FILE, FILE_READ);
  if (!in) return 0;
  if (sdQueueHeadOffset > 0 && !in.seek(sdQueueHeadOffset)) {
    in.close();
    return 0;
  }

  int count = 0;
  while (in.available()) {
    String row = in.readStringUntil('\n');
    row.trim();
    if (row.length() > 0) count++;
    if ((count & 0x3F) == 0) yield();
  }

  in.close();
  return count;
}

bool readQueuedRowsAtHead(String rows[], uint32_t offsetsAfter[], int maxRows, int& rowsOut) {
  rowsOut = 0;
  if (!sdReady || !SD.exists(QUEUE_FILE) || maxRows <= 0) return false;
  maxRows = min(maxRows, FLUSH_BATCH_MAX);
  File in = SD.open(QUEUE_FILE, FILE_READ);
  if (!in) return false;
  if (sdQueueHeadOffset > 0 && !in.seek(sdQueueHeadOffset)) {
    in.close();
    return false;
  }

  while (in.available() && rowsOut < maxRows) {
    String row = in.readStringUntil('\n');
    uint32_t nextOffset = (uint32_t)in.position();
    row.trim();
    if (row.length() == 0) continue;
    rows[rowsOut] = row;
    offsetsAfter[rowsOut] = nextOffset;
    rowsOut++;
  }
  in.close();
  return rowsOut > 0;
}

bool replaceQueueFileWithTemp() {
  SD.remove(QUEUE_BACKUP_FILE);
  if (SD.exists(QUEUE_FILE) && !SD.rename(QUEUE_FILE, QUEUE_BACKUP_FILE)) return false;
  if (!SD.rename(QUEUE_TMP_FILE, QUEUE_FILE)) {
    if (SD.exists(QUEUE_BACKUP_FILE)) SD.rename(QUEUE_BACKUP_FILE, QUEUE_FILE);
    return false;
  }
  SD.remove(QUEUE_BACKUP_FILE);
  return true;
}

bool compactAcknowledgedQueue(bool forceCompact = false) {
  if (!sdReady || !SD.exists(QUEUE_FILE) || sdQueueHeadOffset == 0) return true;
  File in = SD.open(QUEUE_FILE, FILE_READ);
  if (!in) return false;
  uint32_t totalBytes = (uint32_t)in.size();
  bool shouldCompact = forceCompact ||
    (sdQueueHeadOffset >= QUEUE_COMPACT_MIN_PREFIX_BYTES &&
     (sdRowsAckedSinceCompact >= QUEUE_COMPACT_AFTER_ACK_ROWS || sdQueueHeadOffset >= totalBytes / 2));
  if (!shouldCompact) {
    in.close();
    return true;
  }
  if (!in.seek(sdQueueHeadOffset)) {
    in.close();
    return false;
  }

  SD.remove(QUEUE_TMP_FILE);
  File out = SD.open(QUEUE_TMP_FILE, FILE_WRITE);
  if (!out) {
    in.close();
    return false;
  }
  uint8_t buffer[512];
  while (in.available()) {
    size_t count = in.read(buffer, sizeof(buffer));
    if (count == 0 || out.write(buffer, count) != count) {
      in.close();
      out.close();
      SD.remove(QUEUE_TMP_FILE);
      return false;
    }
    yield();
  }
  in.close();
  out.close();
  SD.remove(QUEUE_META_FILE);
  SD.remove(QUEUE_META_TMP_FILE);
  if (!replaceQueueFileWithTemp()) {
    persistQueueHeadOffset();
    return false;
  }
  sdQueueHeadOffset = 0;
  sdRowsAckedSinceCompact = 0;
  return persistQueueHeadOffset();
}

bool acknowledgeSdRows(uint32_t nextOffset, int rows) {
  if (rows <= 0 || rows > sdQueueCount) return false;
  sdQueueHeadOffset = nextOffset;
  sdQueueCount -= rows;
  sdRowsAckedSinceCompact += rows;
  if (sdQueueCount == 0) {
    SD.remove(QUEUE_FILE);
    SD.remove(QUEUE_TMP_FILE);
    SD.remove(QUEUE_META_FILE);
    SD.remove(QUEUE_META_TMP_FILE);
    sdQueueHeadOffset = 0;
    sdRowsAckedSinceCompact = 0;
    return true;
  }
  if (!persistQueueHeadOffset()) return false;
  return compactAcknowledgedQueue(false);
}

bool readFirstQueuedRows(String& batchJson, int maxRows, int& rowsOut) {
  batchJson = "";
  rowsOut = 0;
  if (!sdReady || !SD.exists(QUEUE_FILE) || maxRows <= 0) return false;

  File in = SD.open(QUEUE_FILE, FILE_READ);
  if (!in) return false;
  if (sdQueueHeadOffset > 0 && !in.seek(sdQueueHeadOffset)) {
    in.close();
    return false;
  }

  batchJson.reserve(maxRows * 580);
  batchJson = "[";

  while (in.available() && rowsOut < maxRows) {
    String row = in.readStringUntil('\n');
    row.trim();
    if (row.length() == 0) continue;

    if (rowsOut > 0) batchJson += ",";
    batchJson += row;
    rowsOut++;
    if ((rowsOut & 0x3F) == 0) yield();
  }

  in.close();
  batchJson += "]";
  return rowsOut > 0;
}

bool buildRowsBatch(String rows[], int rowCount, String& batchJson) {
  batchJson = "";
  if (rowCount <= 0) return false;

  batchJson.reserve(rowCount * 580);
  batchJson = "[";

  for (int i = 0; i < rowCount; i++) {
    String row = rows[i];
    row.trim();
    if (row.length() == 0) continue;

    if (batchJson.length() > 1) batchJson += ",";
    batchJson += row;
  }

  batchJson += "]";
  return batchJson.length() > 2;
}

bool readNewestQueuedRows(String rows[], int maxRows, int& rowsOut) {
  rowsOut = 0;
  if (!sdReady || !SD.exists(QUEUE_FILE) || maxRows <= 0) return false;

  maxRows = min(maxRows, FLUSH_BATCH_MAX);
  File in = SD.open(QUEUE_FILE, FILE_READ);
  if (!in) return false;

  String ring[FLUSH_BATCH_MAX];
  int totalRows = 0;

  while (in.available()) {
    String row = in.readStringUntil('\n');
    row.trim();
    if (row.length() == 0) continue;

    ring[totalRows % maxRows] = row;
    totalRows++;
    if ((totalRows & 0x3F) == 0) yield();
  }

  in.close();
  rowsOut = min(totalRows, maxRows);

  for (int i = 0; i < rowsOut; i++) {
    int sourceIndex = totalRows - 1 - i;
    rows[i] = ring[sourceIndex % maxRows];
  }

  return rowsOut > 0;
}

bool rewriteQueueSkippingFirstRows(int skipRows) {
  if (!sdReady || !SD.exists(QUEUE_FILE)) {
    return false;
  }

  File in = SD.open(QUEUE_FILE, FILE_READ);
  if (!in) return false;
  if (sdQueueHeadOffset > 0 && !in.seek(sdQueueHeadOffset)) {
    in.close();
    return false;
  }

  SD.remove(QUEUE_TMP_FILE);
  File out = SD.open(QUEUE_TMP_FILE, FILE_WRITE);
  if (!out) {
    in.close();
    return false;
  }

  int rowsSeen = 0;
  int rowsWritten = 0;

  while (in.available()) {
    String row = in.readStringUntil('\n');
    row.trim();
    if (row.length() == 0) continue;

    rowsSeen++;
    if ((rowsSeen & 0x3F) == 0) yield();
    if (rowsSeen <= skipRows) continue;

    out.println(row);
    rowsWritten++;
  }

  in.close();
  out.close();

  if (rowsWritten > 0) {
    SD.remove(QUEUE_META_FILE);
    SD.remove(QUEUE_META_TMP_FILE);
    if (!replaceQueueFileWithTemp()) return false;
  } else {
    SD.remove(QUEUE_FILE);
    SD.remove(QUEUE_TMP_FILE);
    SD.remove(QUEUE_META_FILE);
    SD.remove(QUEUE_META_TMP_FILE);
  }
  sdQueueCount = rowsWritten;
  sdQueueHeadOffset = 0;
  sdRowsAckedSinceCompact = 0;
  if (rowsWritten > 0) persistQueueHeadOffset();

  return true;
}

bool rewriteQueueSkippingLastRows(int skipRows) {
  if (!sdReady || !SD.exists(QUEUE_FILE)) {
    return false;
  }
  if (skipRows <= 0) return true;

  int totalRows = countSdQueueRows();
  int rowsToKeep = max(0, totalRows - skipRows);

  File in = SD.open(QUEUE_FILE, FILE_READ);
  if (!in) return false;

  SD.remove(QUEUE_TMP_FILE);
  File out = SD.open(QUEUE_TMP_FILE, FILE_WRITE);
  if (!out) {
    in.close();
    return false;
  }

  int rowsSeen = 0;
  int rowsWritten = 0;

  while (in.available()) {
    String row = in.readStringUntil('\n');
    row.trim();
    if (row.length() == 0) continue;

    if (rowsSeen < rowsToKeep) {
      out.println(row);
      rowsWritten++;
    }
    rowsSeen++;
    if ((rowsSeen & 0x3F) == 0) yield();
  }

  in.close();
  out.close();

  if (rowsWritten > 0) {
    if (!replaceQueueFileWithTemp()) return false;
  } else {
    SD.remove(QUEUE_FILE);
    SD.remove(QUEUE_TMP_FILE);
  }
  sdQueueCount = rowsWritten;

  return true;
}

bool resetSdQueueFile(const char* reason) {
  if (!sdReady) return false;

  Serial.print("Queue reset, old SD buffer dropped: ");
  Serial.println(reason);

  SD.remove(QUEUE_TMP_FILE);
  SD.remove(QUEUE_FILE);
  SD.remove(QUEUE_BACKUP_FILE);
  SD.remove(QUEUE_META_FILE);
  SD.remove(QUEUE_META_TMP_FILE);
  sdQueueCount = 0;
  sdQueueHeadOffset = 0;
  sdRowsAckedSinceCompact = 0;
  return true;
}

bool trimSdQueueToHardLimit() {
  if (!sdReady) return false;

  if (!SD.exists(QUEUE_FILE)) {
    sdQueueCount = 0;
    return true;
  }

  if (sdQueueCount <= 0) {
    sdQueueCount = countSdQueueRows();
  }

  if (sdQueueCount < SD_QUEUE_HARD_MAX_ROWS) {
    return true;
  }

  int keepRows = min(SD_QUEUE_TRIM_TO_ROWS, SD_QUEUE_HARD_MAX_ROWS - 1);
  int dropRows = sdQueueCount - keepRows;
  if (dropRows <= 0) return true;

  Serial.print("Queue hard limit reached, dropping oldest SD rows: ");
  Serial.println(dropRows);

  if (!rewriteQueueSkippingFirstRows(dropRows)) {
    return resetSdQueueFile("trim failed");
  }

  return true;
}

bool peekQueuedRowAtOffset(int skipRows, String& rowOut) {
  rowOut = "";
  if (!sdReady || !SD.exists(QUEUE_FILE)) return false;

  File in = SD.open(QUEUE_FILE, FILE_READ);
  if (!in) return false;

  int rowsSeen = 0;
  while (in.available()) {
    String row = in.readStringUntil('\n');
    row.trim();
    if (row.length() > 0) {
      if (rowsSeen < skipRows) {
        rowsSeen++;
        continue;
      }
      rowOut = row;
      break;
    }
  }
  in.close();
  return rowOut.length() > 0;
}

bool peekFirstQueuedRow(String& rowOut) {
  return peekQueuedRowAtOffset(0, rowOut);
}

bool deleteFirstQueuedRow() {
  return rewriteQueueSkippingFirstRows(1);
}

bool enqueueRam(const String& payload) {
  if (RAM_QUEUE_MAX <= 0) return false;
  int idx = (ramQueueHead + ramQueueCount) % RAM_QUEUE_MAX;
  if (ramQueueCount == RAM_QUEUE_MAX) {
    ramQueueHead = (ramQueueHead + 1) % RAM_QUEUE_MAX; // drop oldest
    idx = (ramQueueHead + ramQueueCount - 1) % RAM_QUEUE_MAX;
    Serial.println("RAM queue full, oldest dropped");
  } else {
    ramQueueCount++;
  }
  ramQueue[idx] = payload;
  return true;
}

bool peekRam(String& payload) {
  if (ramQueueCount <= 0) return false;
  payload = ramQueue[ramQueueHead];
  return true;
}

bool popRam() {
  if (ramQueueCount <= 0) return false;
  ramQueue[ramQueueHead] = "";
  ramQueueHead = (ramQueueHead + 1) % RAM_QUEUE_MAX;
  ramQueueCount--;
  return true;
}

bool buildRamBatch(String& batchJson, int maxRows, int& rowsOut) {
  batchJson = "";
  rowsOut = 0;
  if (ramQueueCount <= 0 || maxRows <= 0) return false;

  int rowsToSend = min(ramQueueCount, maxRows);
  batchJson.reserve(rowsToSend * 340);
  batchJson = "[";

  for (int i = 0; i < rowsToSend; i++) {
    int idx = (ramQueueHead + i) % RAM_QUEUE_MAX;
    String row = ramQueue[idx];
    row.trim();
    if (row.length() == 0) continue;

    if (rowsOut > 0) batchJson += ",";
    batchJson += row;
    rowsOut++;
  }

  batchJson += "]";
  return rowsOut > 0;
}

bool popRamRows(int rows) {
  if (rows <= 0 || rows > ramQueueCount) return false;

  for (int i = 0; i < rows; i++) {
    if (!popRam()) return false;
  }

  return true;
}

bool buildRamNewestBatch(String& batchJson, int maxRows, int& rowsOut) {
  batchJson = "";
  rowsOut = 0;
  if (ramQueueCount <= 0 || maxRows <= 0) return false;

  int rowsToSend = min(ramQueueCount, maxRows);
  batchJson.reserve(rowsToSend * 340);
  batchJson = "[";

  for (int i = 0; i < rowsToSend; i++) {
    int idx = (ramQueueHead + ramQueueCount - 1 - i + RAM_QUEUE_MAX) % RAM_QUEUE_MAX;
    String row = ramQueue[idx];
    row.trim();
    if (row.length() == 0) continue;

    if (rowsOut > 0) batchJson += ",";
    batchJson += row;
    rowsOut++;
  }

  batchJson += "]";
  return rowsOut > 0;
}

bool peekRamNewestAtOffset(int offset, String& payload) {
  if (ramQueueCount <= 0 || offset < 0 || offset >= ramQueueCount) return false;
  int idx = (ramQueueHead + ramQueueCount - 1 - offset + RAM_QUEUE_MAX) % RAM_QUEUE_MAX;
  payload = ramQueue[idx];
  return true;
}

bool popRamNewestRows(int rows) {
  if (rows <= 0 || rows > ramQueueCount) return false;

  for (int i = 0; i < rows; i++) {
    int idx = (ramQueueHead + ramQueueCount - 1 + RAM_QUEUE_MAX) % RAM_QUEUE_MAX;
    ramQueue[idx] = "";
    ramQueueCount--;
  }

  if (ramQueueCount == 0) {
    ramQueueHead = 0;
  }

  return true;
}

uint64_t sdFreeBytes() {
  if (!sdReady) return 0;

  uint64_t total = SD.totalBytes();
  uint64_t used = SD.usedBytes();
  if (total == 0 || used > total) return 0;
  return total - used;
}

bool ensureSpaceForQueueWrite(size_t payloadBytes) {
  // Payload + newline + small FAT write overhead.
  uint64_t required = (uint64_t)payloadBytes + 64ULL + SD_FREE_GUARD_BYTES;
  uint64_t total = SD.totalBytes();

  // If storage stats are unavailable, skip proactive trimming and rely on append result.
  if (total == 0) return true;

  int evictCount = 0;
  while (sdFreeBytes() < required) {
    if (sdQueueCount <= 0) {
      sdQueueCount = countSdQueueRows();
    }

    if (sdQueueCount <= 0) {
      return false;
    }

    int dropRows = min(max(1, sdQueueCount / 4), 200);
    if (!rewriteQueueSkippingFirstRows(dropRows)) {
      return resetSdQueueFile("free-space trim failed");
    }

    evictCount += dropRows;
    if (evictCount > 10000) {
      return false;
    }
  }

  if (evictCount > 0) {
    Serial.print("Queue evicted oldest rows: ");
    Serial.println(evictCount);
  }

  return true;
}

bool appendToQueue(const String& payload) {
  if (!sdReady) return false;

  if (!SD.exists(QUEUE_FILE)) {
    sdQueueHeadOffset = 0;
    sdRowsAckedSinceCompact = 0;
    SD.remove(QUEUE_META_FILE);
    SD.remove(QUEUE_META_TMP_FILE);
  }

  if (!trimSdQueueToHardLimit()) {
    resetSdQueueFile("hard-limit trim failed");
  }

  if (!ensureSpaceForQueueWrite(payload.length())) {
    Serial.println("Queue full and cannot evict enough");
    resetSdQueueFile("not enough free space");
  }

  // If append still fails, drop the old file once and retry with a clean queue.
  for (int attempt = 0; attempt < 3; attempt++) {
    File f = SD.open(QUEUE_FILE, FILE_APPEND);
    if (f) {
      size_t written = f.println(payload);
      f.close();
      if (written > 0) {
        sdQueueCount++;
        return true;
      }
    }

    if (attempt == 0) {
      resetSdQueueFile("append failed");
    } else {
      delay(20);
    }
  }

  Serial.println("Queue append failed");
  return false;
}

bool initSdCard() {
  pinMode(SD_CS_PIN, OUTPUT);
  digitalWrite(SD_CS_PIN, HIGH);

  for (int s = 0; s < SD_SPEEDS_COUNT; s++) {
    uint32_t speed = SD_SPEEDS[s];

    SPI.end();
    delay(30);
    SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);

    for (int i = 0; i < SD_INIT_RETRIES; i++) {
      SD.end();
      bool ok = SD.begin(SD_CS_PIN, SPI, speed);
      uint8_t cardType = SD.cardType();

      Serial.print("SD init try speed=");
      Serial.print(speed);
      Serial.print("Hz attempt=");
      Serial.print(i + 1);
      Serial.print(" ok=");
      Serial.print(ok ? "1" : "0");
      Serial.print(" type=");
      Serial.println(cardType);

      if (ok && cardType != CARD_NONE) {
        uint64_t cardSizeMb = SD.cardSize() / (1024ULL * 1024ULL);
        Serial.print("SD card size MB: ");
        Serial.println((unsigned long)cardSizeMb);

        File t = SD.open("/sd_test.tmp", FILE_WRITE);
        if (t) {
          t.println("ok");
          t.close();
          SD.remove("/sd_test.tmp");
          sdReady = true;
          if (!SD.exists(QUEUE_FILE) && SD.exists(QUEUE_BACKUP_FILE)) {
            SD.rename(QUEUE_BACKUP_FILE, QUEUE_FILE);
          } else if (SD.exists(QUEUE_FILE)) {
            SD.remove(QUEUE_BACKUP_FILE);
          }
          SD.remove(QUEUE_TMP_FILE);
          loadQueueHeadOffset();
          sdQueueCount = countSdQueueRows();
          trimSdQueueToHardLimit();
          return true;
        }
        Serial.println("SD mounted but write test failed");
      }
      delay(150);
    }
  }
  sdReady = false;
  return false;
}

void ensureSdReady() {
  if (sdReady) return;

  unsigned long now = millis();
  if (now - lastSdAttemptMs < SD_RETRY_MS) return;
  lastSdAttemptMs = now;

  Serial.println("SD reconnect attempt...");
  sdReady = initSdCard();
  if (sdReady) {
    sdQueueCount = countSdQueueRows();
  }
  Serial.print("SD state: ");
  Serial.println(sdReady ? "OK" : "FAILED");
}

String buildTransportEnvelope(const String& itemsJson, const char* deliveryKind, int remainingAfterAck) {
  String envelope;
  envelope.reserve(itemsJson.length() + 128);
  envelope = "{\"items\":";
  envelope += itemsJson;
  envelope += ",\"transport\":{\"delivery_kind\":\"";
  envelope += deliveryKind;
  envelope += "\",\"buffer_remaining_after_ack\":";
  envelope += String(max(0, remainingAfterAck));
  envelope += "}}";
  return envelope;
}

String buildSingleItemEnvelope(const String& itemJson, const char* deliveryKind, int remainingAfterAck) {
  return buildTransportEnvelope("[" + itemJson + "]", deliveryKind, remainingAfterAck);
}

void flushQueueIfPossible() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (otaInProgress || (telemetryWorkQueue && uxQueueMessagesWaiting(telemetryWorkQueue) > 0)) return;

  unsigned long now = millis();
  if (lastLiveSendOkMs == 0 || now - lastLiveSendOkMs > QUEUE_FLUSH_AFTER_LIVE_OK_MS) {
    return;
  }

  if (now - lastFlushAttemptMs < flushBackoffMs) return;
  lastFlushAttemptMs = now;

  bool failed = false;
  int sentSd = 0;
  int sentRam = 0;
  int droppedSd = 0;
  int droppedRam = 0;
  int rowsLeft = FLUSH_BATCH_MAX;

  while (rowsLeft > 0 && ramQueueCount > 0) {
    String batchPayload;
    int batchRows = 0;
    if (!buildRamBatch(batchPayload, rowsLeft, batchRows)) break;

    int remainingAfterAck = ramQueueCount + sdQueueCount - batchRows;
    SendResult result = sendPayload(buildTransportEnvelope(batchPayload, "buffer", remainingAfterAck));
    if (result == SEND_RESULT_OK) {
      if (!popRamRows(batchRows)) {
        failed = true;
        break;
      }
      sentRam += batchRows;
      rowsLeft -= batchRows;
      continue;
    }

    if (result != SEND_RESULT_REJECTED) {
      failed = true;
      break;
    }

    int rowsChecked = 0;
    while (rowsChecked < batchRows && rowsLeft > 0 && ramQueueCount > 0) {
      String queuedPayload;
      if (!peekRam(queuedPayload)) break;

      int singleRemaining = ramQueueCount + sdQueueCount - 1;
      SendResult singleResult = sendPayload(buildSingleItemEnvelope(queuedPayload, "buffer", singleRemaining));
      if (singleResult == SEND_RESULT_OK) {
        if (!popRam()) {
          failed = true;
          break;
        }
        sentRam++;
        rowsChecked++;
        rowsLeft--;
      } else if (singleResult == SEND_RESULT_REJECTED) {
        if (!popRam()) {
          failed = true;
          break;
        }
        droppedRam++;
        rowsChecked++;
        rowsLeft--;
        Serial.println("Queued packet rejected by server, dropped (RAM)");
      } else {
        failed = true;
        break;
      }
    }

    if (failed || rowsChecked < batchRows) break;
  }

  while (!failed && rowsLeft > 0 && sdReady && sdQueueCount > 0 && SD.exists(QUEUE_FILE)) {
    if (otaInProgress || (telemetryWorkQueue && uxQueueMessagesWaiting(telemetryWorkQueue) > 0)) break;
    String queuedRows[FLUSH_BATCH_MAX];
    uint32_t offsetsAfter[FLUSH_BATCH_MAX];
    String batchPayload;
    int batchRows = 0;
    if (!readQueuedRowsAtHead(queuedRows, offsetsAfter, rowsLeft, batchRows)) break;
    if (!buildRowsBatch(queuedRows, batchRows, batchPayload)) break;

    int remainingAfterAck = ramQueueCount + sdQueueCount - batchRows;
    SendResult result = sendPayload(buildTransportEnvelope(batchPayload, "buffer", remainingAfterAck));
    if (result == SEND_RESULT_OK) {
      if (!acknowledgeSdRows(offsetsAfter[batchRows - 1], batchRows)) {
        failed = true;
        break;
      }
      sentSd += batchRows;
      rowsLeft -= batchRows;
      continue;
    }

    if (result == SEND_RESULT_REJECTED) {
      int rowsToDelete = 0;
      int rowsChecked = 0;

      while (rowsChecked < batchRows && rowsLeft > 0) {
        String queuedPayload = queuedRows[rowsChecked];
        queuedPayload.trim();
        if (queuedPayload.length() == 0) break;

        int singleRemaining = ramQueueCount + sdQueueCount - rowsToDelete - 1;
        SendResult singleResult = sendPayload(buildSingleItemEnvelope(queuedPayload, "buffer", singleRemaining));
        if (singleResult == SEND_RESULT_OK) {
          sentSd++;
          rowsToDelete++;
          rowsChecked++;
          rowsLeft--;
        } else if (singleResult == SEND_RESULT_REJECTED) {
          droppedSd++;
          rowsToDelete++;
          rowsChecked++;
          rowsLeft--;
          Serial.println("Queued packet rejected by server, dropped (SD)");
        } else {
          failed = true;
          break;
        }
      }

      if (rowsToDelete > 0 && !acknowledgeSdRows(offsetsAfter[rowsToDelete - 1], rowsToDelete)) {
        failed = true;
      }

      if (failed || rowsChecked < batchRows) break;
      continue;
    }

    failed = true;
    break;
  }

  if (sentSd > 0) {
    Serial.print("Queued packets sent (SD), count=");
    Serial.println(sentSd);
  }
  if (droppedSd > 0) {
    Serial.print("Queued packets dropped (SD), count=");
    Serial.println(droppedSd);
  }

  if (sentRam > 0) {
    Serial.print("Queued packets sent (RAM), count=");
    Serial.println(sentRam);
  }
  if (droppedRam > 0) {
    Serial.print("Queued packets dropped (RAM), count=");
    Serial.println(droppedRam);
  }

  if (failed) {
    unsigned long nextBackoff = flushBackoffMs * 2;
    flushBackoffMs = (nextBackoff > FLUSH_BACKOFF_MAX_MS) ? FLUSH_BACKOFF_MAX_MS : nextBackoff;
    Serial.print("Queue flush failed, backoff ms=");
    Serial.println(flushBackoffMs);
  } else {
    flushBackoffMs = FLUSH_BACKOFF_MIN_MS;
    liveSendBackoffMs = LIVE_SEND_BACKOFF_MIN_MS;
    liveSendBlockedUntilMs = 0;
  }
}

void noteLiveSendFailed() {
  unsigned long now = millis();
  liveSendBlockedUntilMs = now + liveSendBackoffMs;

  unsigned long nextBackoff = liveSendBackoffMs * 2;
  liveSendBackoffMs = (nextBackoff > LIVE_SEND_BACKOFF_MAX_MS) ? LIVE_SEND_BACKOFF_MAX_MS : nextBackoff;

  Serial.print("Live send backoff ms=");
  Serial.println(liveSendBackoffMs);
}

void noteLiveSendOk() {
  lastLiveSendOkMs = millis();
  liveSendBackoffMs = LIVE_SEND_BACKOFF_MIN_MS;
  liveSendBlockedUntilMs = 0;
}

bool shouldTryLiveSend() {
  if (WiFi.status() != WL_CONNECTED) return false;

  unsigned long now = millis();
  if (liveSendBlockedUntilMs != 0 && now < liveSendBlockedUntilMs) return false;

  return true;
}

bool bufferPayload(const String& payload) {
  if (appendToQueue(payload)) {
    Serial.print("Telemetry buffered to SD, size=");
    Serial.println(sdQueueCount);
    return true;
  }

  if (enqueueRam(payload)) {
    Serial.print("Telemetry buffered to RAM, size=");
    Serial.println(ramQueueCount);
    return true;
  }

  return false;
}

bool enqueueTelemetryWork(const String& payload) {
  if (!telemetryWorkQueue) return false;
  String* queuedPayload = new String(payload);
  if (!queuedPayload) return false;
  if (xQueueSend(telemetryWorkQueue, &queuedPayload, 0) != pdTRUE) {
    delete queuedPayload;
    return false;
  }
  return true;
}

void telemetrySenderTask(void* parameter) {
  (void)parameter;

  while (true) {
    if (otaInProgress) {
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    ensureSdReady();

    String* livePayload = nullptr;
    if (xQueueReceive(telemetryWorkQueue, &livePayload, pdMS_TO_TICKS(20)) == pdTRUE) {
      String* newerPayload = nullptr;
      while (xQueueReceive(telemetryWorkQueue, &newerPayload, 0) == pdTRUE) {
        if (livePayload) {
          if (!bufferPayload(*livePayload)) {
            Serial.println("Telemetry dropped while prioritizing newer live packet");
          }
          delete livePayload;
        }
        livePayload = newerPayload;
        newerPayload = nullptr;
      }

      if (livePayload) {
        if (otaInProgress) {
          if (!bufferPayload(*livePayload)) Serial.println("Telemetry dropped during OTA");
        } else if (shouldTryLiveSend()) {
          int remaining = ramQueueCount + sdQueueCount;
          SendResult result = sendPayload(buildSingleItemEnvelope(*livePayload, "live", remaining));
          if (result == SEND_RESULT_OK) {
            noteLiveSendOk();
            Serial.println("Live telemetry sent");
          } else if (result == SEND_RESULT_REJECTED) {
            noteLiveSendOk();
            Serial.println("Live telemetry rejected by server, dropped");
          } else {
            noteLiveSendFailed();
            if (!bufferPayload(*livePayload)) Serial.println("Telemetry dropped (no SD/RAM)");
          }
        } else if (!bufferPayload(*livePayload)) {
          Serial.println("Telemetry dropped (no SD/RAM)");
        }
        delete livePayload;
      }
    } else {
      flushQueueIfPossible();
    }

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void ensureOtaReady() {
  if (otaStarted || WiFi.status() != WL_CONNECTED) return;

  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPort(3232);

  ArduinoOTA.onStart([]() {
    otaInProgress = true;
    Serial.println("OTA update started");
  });

  ArduinoOTA.onEnd([]() {
    Serial.println("OTA update finished, rebooting");
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    static unsigned int lastPct = 101;
    unsigned int pct = total > 0 ? (progress * 100U) / total : 0;
    if (pct != lastPct && (pct % 10U == 0 || pct == 100U)) {
      lastPct = pct;
      Serial.print("OTA progress: ");
      Serial.print(pct);
      Serial.println("%");
    }
  });

  ArduinoOTA.onError([](ota_error_t error) {
    otaInProgress = false;
    Serial.print("OTA error: ");
    Serial.println((int)error);
  });

  ArduinoOTA.begin();
  otaStarted = true;
  Serial.print("OTA ready: ");
  Serial.print(OTA_HOSTNAME);
  Serial.print(" at ");
  Serial.println(WiFi.localIP());
}

void handleOtaIfReady() {
  if (otaStarted && WiFi.status() == WL_CONNECTED) {
    ArduinoOTA.handle();
  }
}

void ensureWifiConnected() {
  unsigned long now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    int activeProfileIdx = detectWifiProfileIndex(WiFi.SSID());
    if (!wifiWasConnected || activeProfileIdx != wifiConnectedProfileIndex) {
      wifiConnectedProfileIndex = activeProfileIdx;
      wifiWasConnected = true;
      liveSendBackoffMs = LIVE_SEND_BACKOFF_MIN_MS;
      liveSendBlockedUntilMs = 0;
      Serial.print("WiFi connected: ");
      Serial.print(WiFi.SSID());
      Serial.print(" (");
      Serial.print(wifiProfileNameByIndex(wifiConnectedProfileIndex));
      Serial.println(")");
    }
    wifiAttemptActive = false;
    wifiRetryAllowedAtMs = 0;
    ensureOtaReady();
    return;
  }

  wifiWasConnected = false;

  if (wifiRetryAllowedAtMs != 0 && now < wifiRetryAllowedAtMs) {
    return;
  }

  if (!wifiAttemptActive) {
    startWifiAttempt(0);  // Always try primary first.
    return;
  }

  if (now - wifiAttemptStartedMs < WIFI_CONNECT_TIMEOUT_MS) {
    return;
  }

  if (wifiAttemptProfileIndex == 0) {
    // Primary failed by timeout -> try fallback once.
    startWifiAttempt(1);
    return;
  }

  // Full cycle failed: both primary and fallback timed out.
  wifiAttemptActive = false;
  wifiConnectedProfileIndex = -1;
  wifiRetryAllowedAtMs = now + WIFI_RETRY_CYCLE_MS;
  Serial.println("WiFi cycle failed (primary+fallback), waiting before retry");
}

void updateDateFromRmc(const String& sentence) {
  if (!(sentence.startsWith("$GNRMC") || sentence.startsWith("$GPRMC"))) {
    return;
  }

  // RMC fields: 1=utc, 2=status, 9=date(ddmmyy)
  if (countChar(sentence, ',') < 9) return;

  String dateRaw = getField(sentence, 9);
  if (dateRaw.length() < 6) return;
  String dd = dateRaw.substring(0, 2);
  String mm = dateRaw.substring(2, 4);
  String yy = dateRaw.substring(4, 6);
  if (!isDigitsOnly(dd) || !isDigitsOnly(mm) || !isDigitsOnly(yy)) return;

  int ddI = dd.toInt();
  int mmI = mm.toInt();
  int yyI = yy.toInt();
  if (ddI < 1 || ddI > 31 || mmI < 1 || mmI > 12) return;

  int year = (yyI >= 80) ? (1900 + yyI) : (2000 + yyI);
  if (year < 2024 || year > 2099) return;

  char buf[11];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02d", year, mmI, ddI);
  lastRmcDateYmd = String(buf);
  lastRmcDateValid = true;
  lastRmcNmeaSequence = nmeaSentenceSequence;
  maintainedDateYmd = lastRmcDateYmd;
  maintainedDateValid = true;
}

void updateSpeedFromSentence(const String& sentence) {
  double speedKmh = NAN;

  if (sentence.startsWith("$GNRMC") || sentence.startsWith("$GPRMC")) {
    // RMC field 7 is speed over ground in knots.
    double knots = NAN;
    if (parseFiniteDouble(stripChecksum(getField(sentence, 7)), knots)) {
      speedKmh = knots * 1.852;
    }
  } else if (sentence.startsWith("$GNVTG") || sentence.startsWith("$GPVTG")) {
    // VTG field 7 is km/h; field 5 is knots if km/h is absent.
    if (!parseFiniteDouble(stripChecksum(getField(sentence, 7)), speedKmh)) {
      double knots = NAN;
      if (parseFiniteDouble(stripChecksum(getField(sentence, 5)), knots)) {
        speedKmh = knots * 1.852;
      }
    }
  } else {
    return;
  }

  if (isnan(speedKmh) || isinf(speedKmh)) {
    return;
  }

  latestSpeedKmh = speedKmh;
  latestSpeedReceivedMs = millis();
}

void updateAccuracyFromSentence(const String& sentence) {
  // u-blox proprietary NMEA sentence:
  // $PUBX,00,utc,lat,N,lon,E,altRef,navStat,hAcc,vAcc,...
  if (sentence.startsWith("$PUBX,00")) {
    double h = NAN;
    if (parseFiniteDouble(getField(sentence, 9), h)) {
      latestHaccM = h;
    }
    return;
  }

  // Fallback from GST if PUBX is unavailable.
  // $GxGST,time,rms,semiMajor,semiMinor,orient,latStd,lonStd,altStd*cs
  if (sentence.startsWith("$GNGST") || sentence.startsWith("$GPGST")) {
    double latStd = NAN;
    double lonStd = NAN;

    if (parseFiniteDouble(getField(sentence, 6), latStd) &&
        parseFiniteDouble(getField(sentence, 7), lonStd)) {
      latestHaccM = sqrt(latStd * latStd + lonStd * lonStd);
    }
  }
}

double normalizeHeadingDeg(double value) {
  if (isnan(value) || isinf(value)) return NAN;
  double normalized = fmod(value, 360.0);
  if (normalized < 0) normalized += 360.0;
  return normalized;
}

bool isValidCoordinate(double value, double minValue, double maxValue) {
  return !isnan(value) && !isinf(value) && value >= minValue && value <= maxValue;
}

bool parseNmeaCoordinate(const String& rawValue, const String& rawDir, bool latitude, double& out) {
  String value = stripChecksum(rawValue);
  value.trim();
  String dir = stripChecksum(rawDir);
  dir.trim();
  dir.toUpperCase();

  if (value.length() == 0) return false;
  int dotCount = 0;
  for (int i = 0; i < value.length(); i++) {
    char c = value[i];
    if (c == '.') {
      dotCount++;
      if (dotCount > 1) return false;
    } else if (c < '0' || c > '9') {
      return false;
    }
  }

  if (latitude) {
    if (dir != "N" && dir != "S") return false;
  } else {
    if (dir != "E" && dir != "W") return false;
  }

  int dot = value.indexOf('.');
  int wholeLen = (dot >= 0) ? dot : value.length();
  int degreeDigits = latitude ? 2 : 3;
  if (wholeLen != degreeDigits + 2) return false;

  double minutes = NAN;
  if (!parseFiniteDouble(value.substring(degreeDigits), minutes)) return false;

  int degrees = value.substring(0, degreeDigits).toInt();
  if (minutes < 0.0 || minutes >= 60.0) return false;

  double decimal = degrees + minutes / 60.0;
  if (dir == "S" || dir == "W") decimal = -decimal;

  if (latitude && !isValidCoordinate(decimal, -90.0, 90.0)) return false;
  if (!latitude && !isValidCoordinate(decimal, -180.0, 180.0)) return false;

  out = decimal;
  return true;
}

void updateRelPosFlags(uint32_t flags) {
  latestRelPos.flags = flags;
  latestRelPos.relPosValid = (flags & (1UL << 2)) != 0;
  latestRelPos.carrierSolution = (int)((flags >> 3) & 0x03);
  latestRelPos.headingValid = (flags & (1UL << 8)) != 0;
}

void markRelPosReceived() {
  latestRelPos.seen = true;
  latestRelPos.receivedMs = millis();
}

bool parseRelPosTextSentence(const String& sentence) {
  String upper = sentence;
  upper.toUpperCase();
  if (upper.indexOf("RELPOS") < 0) {
    return false;
  }

  double value = NAN;
  uint32_t flags = 0;
  bool hasAny = false;

  if (parseKeyedU32(sentence, latestRelPos.iTow, "iTOW", "itow", "rel_pos_itow")) {
    hasAny = true;
  }

  if (parseKeyedDouble(sentence, value, "relPosNM", "rel_pos_n_m")) {
    latestRelPos.relPosNM = value;
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "relPosN", "rel_pos_n")) {
    latestRelPos.relPosNM = value / 100.0;
    hasAny = true;
  }
  if (parseKeyedDouble(sentence, value, "relPosEM", "rel_pos_e_m")) {
    latestRelPos.relPosEM = value;
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "relPosE", "rel_pos_e")) {
    latestRelPos.relPosEM = value / 100.0;
    hasAny = true;
  }
  if (parseKeyedDouble(sentence, value, "relPosDM", "rel_pos_d_m")) {
    latestRelPos.relPosDM = value;
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "relPosD", "rel_pos_d")) {
    latestRelPos.relPosDM = value / 100.0;
    hasAny = true;
  }
  if (parseKeyedDouble(sentence, value, "baseline_m", "baselineM", "relPosLengthM")) {
    latestRelPos.baselineM = value;
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "relPosLength", "rel_pos_length", "baseline_cm")) {
    latestRelPos.baselineM = value / 100.0;
    hasAny = true;
  }
  if (parseKeyedDouble(sentence, value, "heading", "headingDeg", "relPosHeadingDeg")) {
    latestRelPos.headingDeg = normalizeHeadingDeg(value);
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "relPosHeading", "rel_pos_heading")) {
    latestRelPos.headingDeg = normalizeHeadingDeg(value / 100000.0);
    hasAny = true;
  }
  if (parseKeyedDouble(sentence, value, "accNM", "acc_n_m")) {
    latestRelPos.accNM = value;
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "accN", "acc_n")) {
    latestRelPos.accNM = value * 0.0001;
    hasAny = true;
  }
  if (parseKeyedDouble(sentence, value, "accEM", "acc_e_m")) {
    latestRelPos.accEM = value;
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "accE", "acc_e")) {
    latestRelPos.accEM = value * 0.0001;
    hasAny = true;
  }
  if (parseKeyedDouble(sentence, value, "accDM", "acc_d_m")) {
    latestRelPos.accDM = value;
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "accD", "acc_d")) {
    latestRelPos.accDM = value * 0.0001;
    hasAny = true;
  }
  if (parseKeyedDouble(sentence, value, "baseline_acc_m", "baselineAccM", "accLengthM")) {
    latestRelPos.baselineAccM = value;
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "accLength", "acc_length")) {
    latestRelPos.baselineAccM = value * 0.0001;
    hasAny = true;
  }
  if (parseKeyedDouble(sentence, value, "heading_acc_deg", "headingAccDeg", "accHeadingDeg")) {
    latestRelPos.headingAccDeg = value;
    hasAny = true;
  } else if (parseKeyedDouble(sentence, value, "accHeading", "acc_heading")) {
    latestRelPos.headingAccDeg = value / 100000.0;
    hasAny = true;
  }
  if (parseKeyedU32(sentence, flags, "flags", "relPosFlags", "rel_pos_flags")) {
    updateRelPosFlags(flags);
    hasAny = true;
  }

  if (!hasAny) {
    int markerIndex = -1;
    int commaCount = countChar(sentence, ',');

    for (int i = 0; i <= commaCount; i++) {
      String field = getField(sentence, i);
      field.toUpperCase();
      if (field.indexOf("RELPOS") >= 0) {
        markerIndex = i;
        break;
      }
    }

    if (markerIndex >= 0 && markerIndex + 12 <= commaCount) {
      int base = markerIndex + 1;
      uint32_t parsedU32 = 0;
      double parsed = NAN;

      if (parseUnsigned32(getField(sentence, base), parsedU32)) latestRelPos.iTow = parsedU32;
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 1)), parsed)) latestRelPos.relPosNM = parsed / 100.0;
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 2)), parsed)) latestRelPos.relPosEM = parsed / 100.0;
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 3)), parsed)) latestRelPos.relPosDM = parsed / 100.0;
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 4)), parsed)) latestRelPos.baselineM = parsed / 100.0;
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 5)), parsed)) latestRelPos.headingDeg = normalizeHeadingDeg(parsed / 100000.0);
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 6)), parsed)) latestRelPos.accNM = parsed * 0.0001;
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 7)), parsed)) latestRelPos.accEM = parsed * 0.0001;
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 8)), parsed)) latestRelPos.accDM = parsed * 0.0001;
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 9)), parsed)) latestRelPos.baselineAccM = parsed * 0.0001;
      if (parseFiniteDouble(stripChecksum(getField(sentence, base + 10)), parsed)) latestRelPos.headingAccDeg = parsed / 100000.0;
      if (parseUnsigned32(getField(sentence, base + 11), parsedU32)) updateRelPosFlags(parsedU32);
      hasAny = true;
    }
  }

  if (!hasAny) {
    return false;
  }

  markRelPosReceived();
  Serial.print("RELPOS text: heading=");
  Serial.print(latestRelPos.headingDeg, 3);
  Serial.print(" baseline=");
  Serial.print(latestRelPos.baselineM, 3);
  Serial.print(" carrier=");
  Serial.println(carrierSolutionLabel(latestRelPos.carrierSolution));
  return true;
}

void ubxChecksumAdd(uint8_t value) {
  ubxChecksumA = ubxChecksumA + value;
  ubxChecksumB = ubxChecksumB + ubxChecksumA;
}

int32_t ubxI4(int offset) {
  return (int32_t)(
    ((uint32_t)ubxPayload[offset]) |
    ((uint32_t)ubxPayload[offset + 1] << 8) |
    ((uint32_t)ubxPayload[offset + 2] << 16) |
    ((uint32_t)ubxPayload[offset + 3] << 24)
  );
}

uint32_t ubxU4(int offset) {
  return
    ((uint32_t)ubxPayload[offset]) |
    ((uint32_t)ubxPayload[offset + 1] << 8) |
    ((uint32_t)ubxPayload[offset + 2] << 16) |
    ((uint32_t)ubxPayload[offset + 3] << 24);
}

int8_t ubxI1(int offset) {
  return (int8_t)ubxPayload[offset];
}

void parseUbxNavRelPosNed() {
  if (ubxLength < 64) {
    return;
  }

  latestRelPos.iTow = ubxU4(4);
  latestRelPos.relPosNM = ubxI4(8) / 100.0 + ubxI1(32) * 0.0001;
  latestRelPos.relPosEM = ubxI4(12) / 100.0 + ubxI1(33) * 0.0001;
  latestRelPos.relPosDM = ubxI4(16) / 100.0 + ubxI1(34) * 0.0001;
  latestRelPos.baselineM = ubxI4(20) / 100.0 + ubxI1(35) * 0.0001;
  latestRelPos.headingDeg = normalizeHeadingDeg(ubxI4(24) / 100000.0);
  latestRelPos.accNM = ubxU4(36) * 0.0001;
  latestRelPos.accEM = ubxU4(40) * 0.0001;
  latestRelPos.accDM = ubxU4(44) * 0.0001;
  latestRelPos.baselineAccM = ubxU4(48) * 0.0001;
  latestRelPos.headingAccDeg = ubxU4(52) / 100000.0;
  updateRelPosFlags(ubxU4(60));
  markRelPosReceived();

  Serial.print("RELPOS UBX: heading=");
  Serial.print(latestRelPos.headingDeg, 3);
  Serial.print(" baseline=");
  Serial.print(latestRelPos.baselineM, 3);
  Serial.print(" carrier=");
  Serial.println(carrierSolutionLabel(latestRelPos.carrierSolution));
}

void processUbxByte(uint8_t value) {
  switch (ubxState) {
    case UBX_WAIT_SYNC1:
      if (value == 0xB5) ubxState = UBX_WAIT_SYNC2;
      break;

    case UBX_WAIT_SYNC2:
      ubxState = (value == 0x62) ? UBX_READ_CLASS : UBX_WAIT_SYNC1;
      break;

    case UBX_READ_CLASS:
      ubxClass = value;
      ubxChecksumA = 0;
      ubxChecksumB = 0;
      ubxChecksumAdd(value);
      ubxState = UBX_READ_ID;
      break;

    case UBX_READ_ID:
      ubxId = value;
      ubxChecksumAdd(value);
      ubxState = UBX_READ_LEN1;
      break;

    case UBX_READ_LEN1:
      ubxLength = value;
      ubxChecksumAdd(value);
      ubxState = UBX_READ_LEN2;
      break;

    case UBX_READ_LEN2:
      ubxLength |= ((uint16_t)value << 8);
      ubxChecksumAdd(value);
      ubxIndex = 0;
      if (ubxLength > UBX_PAYLOAD_MAX) {
        ubxSkipRemaining = ubxLength;
        ubxState = UBX_SKIP_PAYLOAD;
      } else {
        ubxState = ubxLength == 0 ? UBX_READ_CK_A : UBX_READ_PAYLOAD;
      }
      break;

    case UBX_READ_PAYLOAD:
      ubxPayload[ubxIndex++] = value;
      ubxChecksumAdd(value);
      if (ubxIndex >= ubxLength) {
        ubxState = UBX_READ_CK_A;
      }
      break;

    case UBX_SKIP_PAYLOAD:
      ubxChecksumAdd(value);
      if (ubxSkipRemaining > 0) ubxSkipRemaining--;
      if (ubxSkipRemaining == 0) {
        ubxState = UBX_READ_CK_A;
      }
      break;

    case UBX_READ_CK_A:
      if (value == ubxChecksumA) {
        ubxState = UBX_READ_CK_B;
      } else {
        ubxState = UBX_WAIT_SYNC1;
      }
      break;

    case UBX_READ_CK_B:
      if (value == ubxChecksumB &&
          ubxClass == UBX_CLASS_NAV &&
          ubxId == UBX_ID_NAV_RELPOSNED &&
          ubxLength <= UBX_PAYLOAD_MAX) {
        parseUbxNavRelPosNed();
      }
      ubxState = UBX_WAIT_SYNC1;
      break;

    default:
      ubxState = UBX_WAIT_SYNC1;
      break;
  }
}

bool parseGga(const String& sentence, GpsData& out) {
  if (!(sentence.startsWith("$GNGGA") || sentence.startsWith("$GPGGA"))) {
    return false;
  }

  String utcRaw = getField(sentence, 1);
  String latRaw = getField(sentence, 2);
  String latDir = getField(sentence, 3);
  String lonRaw = getField(sentence, 4);
  String lonDir = getField(sentence, 5);
  String quality = getField(sentence, 6);
  String sats = getField(sentence, 7);
  String hdop = getField(sentence, 8);
  String alt = getField(sentence, 9);
  String corrAge = getField(sentence, 13);

  double latDecimal = NAN;
  double lonDecimal = NAN;
  if (!parseNmeaCoordinate(latRaw, latDir, true, latDecimal) ||
      !parseNmeaCoordinate(lonRaw, lonDir, false, lonDecimal)) {
    Serial.print("Telemetry skipped: invalid NMEA coordinates lat=");
    Serial.print(latRaw);
    Serial.print(" ");
    Serial.print(latDir);
    Serial.print(" lon=");
    Serial.print(lonRaw);
    Serial.print(" ");
    Serial.println(lonDir);
    return false;
  }

  String timestamp;
  String timeSource;
  if (!formatNmeaTime(utcRaw, timestamp, timeSource)) {
    unsigned long nowMs = millis();
    if (nowMs - lastTimeSkipLogMs >= TIME_SKIP_LOG_INTERVAL_MS) {
      lastTimeSkipLogMs = nowMs;
      Serial.print("Telemetry skipped: waiting for valid GPS/NTP time, GGA utc=");
      Serial.print(utcRaw.length() ? utcRaw : "<empty>");
      Serial.print(" RMC date=");
      Serial.println(lastRmcDateValid ? lastRmcDateYmd : "<none>");
    }
    return false;
  }

  out.timestamp = timestamp;
  out.timeSource = timeSource;
  out.lat = latDecimal;
  out.lon = lonDecimal;
  out.haccM = latestHaccM;
  out.speedKmh = isSpeedFresh() ? latestSpeedKmh : NAN;
  out.hdop = hdop.toDouble();
  out.altitudeM = alt.toDouble();
  out.corrAgeS = NAN;
  parseFiniteDouble(corrAge, out.corrAgeS);
  out.gpsQuality = quality.toInt();
  out.gpsSatellites = sats.toInt();

  return true;
}

void handleGpsSentence(const String& sentence) {
  GpsData data;
  if (!parseGga(sentence, data)) {
    return;
  }

  unsigned long nowMs = millis();
  bool stationary = updateStationaryMode(data, nowMs);
  unsigned long telemetryIntervalMs = stationary ? STATIONARY_TELEMETRY_INTERVAL_MS : TELEMETRY_INTERVAL_MS;

  if (nowMs - lastTelemetryMs < telemetryIntervalMs) {
    if (stationary && nowMs - lastStationarySkipLogMs >= STATIONARY_SKIP_LOG_INTERVAL_MS) {
      lastStationarySkipLogMs = nowMs;
      Serial.println("Telemetry skipped: stationary throttle");
    }
    return;
  }
  lastTelemetryMs = nowMs;

  Serial.print("LAT: ");
  Serial.print(data.lat, 7);
  Serial.print("  LON: ");
  Serial.print(data.lon, 7);
  Serial.print("  Q: ");
  Serial.print(data.gpsQuality);
  Serial.print("  SATS: ");
  Serial.print(data.gpsSatellites);
  Serial.print("  HACC(m): ");
  Serial.print(data.haccM, 3);
  Serial.print("  SPEED(km/h): ");
  if (isnan(data.speedKmh) || isinf(data.speedKmh)) {
    Serial.print("null");
  } else {
    Serial.print(data.speedKmh, 2);
  }
  if (isRelPosFresh()) {
    Serial.print("  HEAD(deg): ");
    Serial.print(latestRelPos.headingDeg, 3);
    Serial.print("  BASE(m): ");
    Serial.print(latestRelPos.baselineM, 3);
    Serial.print("  CARR: ");
    Serial.println(carrierSolutionLabel(latestRelPos.carrierSolution));
  } else {
    Serial.println("  RELPOS: none");
  }

  uint32_t sequence = ++packetSequence;
  String payload = buildPayload(data, sequence);
  if (!enqueueTelemetryWork(payload)) {
    Serial.println("Telemetry work queue full, packet dropped");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("RTK UART + WiFi + SD telemetry started");

  uint32_t bootHigh = esp_random();
  uint32_t bootLow = esp_random();
  snprintf(bootId, sizeof(bootId), "%08lx%08lx", (unsigned long)bootHigh, (unsigned long)bootLow);
  Serial.print("Firmware: ");
  Serial.print(FIRMWARE_VERSION);
  Serial.print(" boot_id=");
  Serial.println(bootId);

  RTK.setRxBufferSize(RTK_RX_BUFFER_BYTES);
  RTK.begin(115200, SERIAL_8N1, RTK_RX_PIN, RTK_TX_PIN);

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(false);
  telemetryClient.setInsecure();
  startWifiAttempt(0);
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.windows.com");

  sdReady = initSdCard();
  Serial.print("SD init: ");
  Serial.println(sdReady ? "OK" : "FAILED");

  telemetryWorkQueue = xQueueCreate(RAM_QUEUE_MAX, sizeof(String*));
  if (!telemetryWorkQueue) {
    Serial.println("Telemetry sender queue allocation failed");
    return;
  }

  BaseType_t taskCreated = xTaskCreatePinnedToCore(
    telemetrySenderTask,
    "telemetry-sender",
    SENDER_TASK_STACK_BYTES,
    nullptr,
    1,
    &telemetrySenderTaskHandle,
    0
  );
  if (taskCreated != pdPASS) {
    telemetrySenderTaskHandle = nullptr;
    Serial.println("Telemetry sender task creation failed");
  }
}

void loop() {
  ensureWifiConnected();
  handleOtaIfReady();
  if (otaInProgress) return;

  while (RTK.available()) {
    handleOtaIfReady();
    if (otaInProgress) return;

    uint8_t b = RTK.read();
    char c = (char)b;

    processUbxByte(b);

    if (c == '\n') {
      nmeaSentenceSequence++;
      updateDateFromRmc(line);
      updateSpeedFromSentence(line);
      updateAccuracyFromSentence(line);
      parseRelPosTextSentence(line);
      handleGpsSentence(line);
      line = "";
    } else if (c != '\r' && (c == '\t' || (c >= 32 && c <= 126))) {
      line += c;

      if (line.length() > 360) {
        line = "";
      }
    }
  }

  handleOtaIfReady();
  if (otaInProgress) return;

  handleOtaIfReady();
}
