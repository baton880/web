# Loader ESP32 Firmware Agent Notes

This folder is separate from the website frontend. It contains firmware for the
ESP32-based RTK loader telemetry device.

## Scope

- Main/current sketch: `jun30a/jun30a.ino`.
- Current docs and OTA notes: `jun30a/README.md`.
- Existing exported build output: `jun30a/build/esp32.esp32.nodemcu-32s/`.
- Older/reference sketch: `GOOD_BUFFER/GOOD_BUFFER.ino`.

Treat `jun30a` as the active firmware unless the user explicitly asks to work on
the backup/reference version.

## What The Firmware Does

The ESP32 reads RTK/GNSS data from an Ardusimple/u-blox receiver over UART2,
turns selected NMEA/UBX data into JSON telemetry, and sends it to:

```text
https://vi-korm.ru/api/telemetry/rtk
```

The device id is:

```text
rtk_loader_01
```

Normal telemetry is emitted about once per second. If the loader stays within a
small radius for 15 minutes, stationary throttling activates and telemetry drops
to once per minute until the loader moves again.

## Hardware Map

RTK receiver UART:

- ESP32 UART: `HardwareSerial RTK(2)`
- RX pin: `17`
- TX pin: `16`
- Baud: `115200`

SD card SPI:

- CS: `5`
- SCK: `18`
- MOSI: `23`
- MISO: `19`

OTA:

- Hostname: `rtk-loader-01`
- Port: `3232`
- Password: none currently set

## Data Inputs

The sketch consumes mixed text and binary data from the RTK receiver.

NMEA text handled:

- `GGA`: main position packet. Produces the telemetry payload.
- `RMC`: date and speed over ground fallback.
- `VTG`: speed over ground fallback.
- `PUBX,00`: horizontal accuracy from u-blox proprietary NMEA.
- `GST`: horizontal accuracy fallback.
- Text sentences containing `RELPOS`: optional moving-base relative position.

UBX binary handled:

- `NAV-RELPOSNED` (`class 0x01`, `id 0x3C`): heading, baseline, carrier
  solution, validity flags, and accuracy fields.

`RELPOS` data is considered fresh for 3 seconds. If fresh, payload
`packetType` is `moving_base`; otherwise it is `pvt`.

## Telemetry Payload

`buildPayload()` manually builds JSON. Important fields:

- `packetType`
- `deviceId`
- `firmware_version`, `boot_id`, `packet_id`, `time_source`
- `timestamp`
- `lat`, `lon`
- `hacc`
- `quality`, `satellites`
- `speed_kmh`
- `corr_age_s`
- optional `heading`, `baseline_m`, `heading_acc_deg`, `baseline_acc_m`,
  `rel_pos_valid`, `rel_pos_carrier_solution`, `rel_pos_flags`
- `wifi_profile`
- `rssi_dbm`
- `sd_queue_len`, `ram_queue_len`, `queue_len`
- `stationary`
- `telemetry_interval_ms`

As of the current working copy, `wifi_profile` is the actual connected SSID,
not the internal labels `primary` or `fallback`.

## Networking

The sketch has two Wi-Fi profiles and always tries the primary network first,
then fallback, then waits before retrying the full cycle.

Important behavior:

- `WiFi.setAutoReconnect(false)` is used; reconnect flow is manual.
- TLS validation is disabled with `telemetryClient.setInsecure()`.
- HTTP timeouts are short by design so telemetry parsing and OTA stay responsive.
- HTTP status `400`, `413`, and `422` are treated as permanent payload rejects
  and dropped instead of endlessly retrying.

Do not publish this folder publicly without intentionally handling the embedded
Wi-Fi credentials.

## Buffering And Queues

Live packets always take priority. TLS/HTTP and SD work run in the dedicated
`telemetry-sender` FreeRTOS task so UART parsing and OTA do not block. Failed live
sends fall back to buffering.

Buffer layers:

- SD queue file: `/telemetry_queue.jsonl`
- SD temp rewrite file: `/telemetry_queue.tmp`
- SD acknowledged offset: `/telemetry_queue.meta`
- RAM queue: ring buffer of 64 payloads

SD queue controls in the current `jun30a` sketch:

- Batch flush max: `16`
- Hard max rows: `1800`
- Trim target: `900`
- Free-space guard: `64 KiB`

Flush behavior:

- Queued telemetry is flushed FIFO only after a recent successful live send.
- Queue flush uses exponential backoff up to 60 seconds and stops between batches
  as soon as a new live packet is waiting.
- A successful batch advances a durable byte offset. Compaction happens only
  after at least 256 acknowledged rows and a 64 KiB prefix (or during trimming).
- SD mount speeds are tried from 8 MHz down to 400 kHz.

Be careful changing queue code: `sdQueueHeadOffset`, `sdQueueCount`, and the meta
file must remain consistent across reset, trimming, acknowledgment, and reboot.

## OTA Flow

OTA is initialized lazily after Wi-Fi connects via `ensureOtaReady()`.

While OTA is running:

- `otaInProgress` is set.
- The main loop returns early from normal telemetry work.
- `ArduinoOTA.handle()` is called frequently, including while draining UART.

Expected serial logs:

```text
OTA ready: rtk-loader-01 at ...
OTA update started
OTA progress: ...
OTA update finished, rebooting
```

Do not use `nc -vz ... 3232` as the main readiness signal for ArduinoOTA on
ESP32. The existing docs explain that `espota.py` may still work even when a raw
TCP probe reports connection refused.

## Build Notes

Known build configuration from `build.options.json`:

```text
FQBN: esp32:esp32:nodemcu-32s:UploadSpeed=115200,FlashFreq=80,DebugLevel=none,EraseFlash=none
Core path: Arduino ESP32 package 3.3.10
Flash: dio, 80 MHz, 4 MB
```

Arduino IDE route:

```text
Sketch -> Export Compiled Binary
Board: ESP32 Dev Module / NodeMCU-32S (ESP32)
```

Existing exported app binary:

```text
jun30a/build/esp32.esp32.nodemcu-32s/jun30a.ino.bin
SHA-256: E9C54277F583A234BB31E0752296A5ED9B9B37A225D546EE72AB1BB3E54A6AF1
```

Flash offsets from `flash_args`:

```text
0x1000  jun30a.ino.bootloader.bin
0x8000  jun30a.ino.partitions.bin
0xe000  boot_app0.bin
0x10000 jun30a.ino.bin
```

## Main Code Flow

`setup()`:

1. Starts Serial.
2. Starts RTK UART2.
3. Configures Wi-Fi station mode.
4. Starts the first Wi-Fi attempt.
5. Starts NTP sync.
6. Initializes SD.

`loop()`:

1. Maintains Wi-Fi.
2. Handles OTA if available.
3. Reads all pending RTK bytes.
4. Feeds each byte to the UBX parser.
5. Builds NMEA lines until newline.
6. Updates date, speed, accuracy, RELPOS, and telemetry from the completed line.
7. Enqueues completed payloads for the sender task.

`telemetrySenderTask()` owns HTTP and SD, prioritizes the newest waiting live
payload, buffers displaced/retryable payloads, then drains FIFO batches.

## Editing Guidance

- Keep changes small and firmware-focused. This folder is intentionally separate
  from the website.
- Prefer changing constants at the top of `jun30a.ino` for timings, endpoints,
  pins, IDs, and queue limits.
- Be careful with `String` allocations on ESP32. The sketch already uses
  `reserve()` in hot paths; preserve that style for payload/batch strings.
- Keep the loop non-blocking. Avoid long waits while Wi-Fi, HTTP, SD, or OTA may
  need service.
- Preserve OTA handling around UART reads; large RTK bursts should not starve
  OTA.
- Do not change telemetry field names without coordinating with the server API.
- If adding fields to telemetry, update both `buildPayload()` and this file.
- Avoid editing generated build outputs unless the task is explicitly about a
  compiled binary or release package.

## Known Differences: GOOD_BUFFER vs jun30a

`GOOD_BUFFER/GOOD_BUFFER.ino` appears to be an earlier stable/reference sketch.
Compared with it, `jun30a/jun30a.ino` currently adds or changes:

- ArduinoOTA support.
- Stationary detection and throttling.
- More queue controls, hard limits, and trimming.
- Shorter live-send backoff.
- More nuanced send result handling (`OK`, `RETRY`, `REJECTED`).
- Actual SSID in `wifi_profile` in the current working copy.
- Stricter NMEA coordinate validation.

Use `GOOD_BUFFER` for comparison when investigating regressions, not as the
default target for new work.

## Quick Checks After Changes

At minimum, inspect/verify these after firmware edits:

- `setup()` still initializes Serial, RTK UART, Wi-Fi, NTP, and SD.
- `loop()` still services Wi-Fi, OTA, RTK UART, and queue flushing.
- `buildPayload()` produces valid JSON for both PVT-only and RELPOS-fresh cases.
- Failed HTTP sends still buffer to SD or RAM.
- SD queue trimming cannot delete the entire queue accidentally unless reset is
  intentional.
- OTA remains reachable after Wi-Fi connects.

If hardware is not attached, note that full validation was not possible.
