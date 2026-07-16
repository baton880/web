# jun30a ESP32 loader firmware

This folder contains the Arduino sketch for the RTK loader ESP32.

Important values in `jun30a.ino`:

- OTA hostname: `rtk-loader-01`
- OTA port: `3232`
- OTA password: not set
- Device id: `rtk_loader_01`
- Telemetry endpoint: `https://vi-korm.ru/api/telemetry/rtk`
- Normal telemetry interval: `1000 ms`
- Stationary telemetry interval: `60000 ms`
- Firmware version: `2026.07.15-reliable-1`

## Reliable telemetry behavior

- UART2 uses an `8192` byte RX buffer. Parsing and OTA remain in the main loop;
  TLS, HTTP, SD writes, and backlog draining run in a separate FreeRTOS task.
- A newly produced live packet is sent before backlog work. Older live packets
  waiting behind it are preserved in the SD/RAM queue.
- The SD queue remains capped at `1800` rows and trims to `900`. It is FIFO and
  acknowledges a durable byte offset; the file is compacted only after a large
  acknowledged prefix instead of being rewritten after every 16-row batch.
- SD initialization tries `8 MHz`, `4 MHz`, `1 MHz`, then `400 kHz`.
- HTTP uses a reusable TLS connection. A response is accepted only for a `2xx`;
  retryable failures leave the packet buffered.
- Every packet includes `firmware_version`, random `boot_id`, unique `packet_id`,
  and `time_source`. Buffer envelopes report `buffer_remaining_after_ack`.
- UTC date comes from RMC when available, tracks the GGA midnight rollover, is
  checked against NTP when available, and rejects unexplained backward jumps.
- Stationary throttling stays at 15 minutes / 60 seconds. Two fresh speed samples
  at or above `1 km/h`, or movement outside the adaptive radius, wake it early.

## Wi-Fi name in telemetry

The telemetry JSON field `wifi_profile` now contains the actual name (SSID) of
the Wi-Fi network to which the loader is connected:

- `ISRK_Hozyain` when it is on the primary network;
- `Sasung` when it is on the fallback network;
- `disconnected` if there is no Wi-Fi connection.

It no longer sends the internal labels `primary` and `fallback`. The connection
order and all Wi-Fi credentials are unchanged.

Do not publish this firmware publicly unless Wi-Fi credentials inside `jun30a.ino` are expected to be public.

## OTA update through Raspberry Pi

Use this when the loader ESP32 is already connected to the Raspberry Pi access point.

### 1. Build `.bin` on the laptop

Open the sketch in Arduino IDE:

```powershell
c:\Users\Windows\projects\site_korovki\!LOADER_CODE\jun30a\jun30a.ino
```

In Arduino IDE:

```text
Sketch -> Export Compiled Binary
```

Use the same board configuration as the existing loader firmware:

```text
Board: ESP32 Dev Module / NodeMCU-32S (ESP32)
```

After export, check that a `.bin` appeared under the sketch build folder:

```powershell
Get-ChildItem -LiteralPath "c:\Users\Windows\projects\site_korovki\!LOADER_CODE\jun30a\build" -Recurse -Filter "jun30a.ino.bin"
```

The expected file is usually:

```text
c:\Users\Windows\projects\site_korovki\!LOADER_CODE\jun30a\build\esp32.esp32.nodemcu-32s\jun30a.ino.bin
```

Reliable build `2026.07.15-reliable-1` SHA-256:

```text
E9C54277F583A234BB31E0752296A5ED9B9B37A225D546EE72AB1BB3E54A6AF1
```

### 2. Find `espota.py` on the laptop

In Windows PowerShell:

```powershell
$espota = Get-ChildItem "$env:LOCALAPPDATA\Arduino15\packages" -Recurse -Filter espota.py |
  Select-Object -First 1 -ExpandProperty FullName

$espota
```

If this prints a path, continue. If it prints nothing, install/update ESP32 support in Arduino IDE Board Manager and repeat the command.

### 3. Copy `.bin` and `espota.py` to Raspberry Pi

These commands assume Raspberry Pi is reachable over Amnezia at `10.8.1.2` and the user is `isrk`.

```powershell
ssh isrk@10.8.1.2 "mkdir -p /home/isrk/esp32-ota"

scp "c:\Users\Windows\projects\site_korovki\!LOADER_CODE\jun30a\build\esp32.esp32.nodemcu-32s\jun30a.ino.bin" `
  isrk@10.8.1.2:/home/isrk/esp32-ota/jun30a.ino.bin

scp "$espota" isrk@10.8.1.2:/home/isrk/esp32-ota/espota.py
```

If the `.bin` has another name, replace `jun30a.ino.bin` in the command with the real file name.

### 4. SSH into Raspberry Pi

```powershell
ssh isrk@10.8.1.2
```

On Raspberry Pi:

```bash
cd /home/isrk/esp32-ota
ls -lh
```

You should see:

```text
espota.py
jun30a.ino.bin
```

### 5. Check that ESP32 is connected to Raspberry Pi AP

On the tested Raspberry Pi setup, the loader was visible as:

```text
rtk-loader-01.local -> 10.42.0.166
```

Check by hostname first:

```bash
ping -c 3 rtk-loader-01.local
```

If hostname works, use that name for OTA. If hostname does not work, find the IP:

```bash
arp -a
ip neigh show dev wlan0
```

Depending on how the Raspberry Pi access point is configured, these commands may fail and that is OK:

```bash
sudo hostapd_cli -i wlan0 all_sta
cat /var/lib/misc/dnsmasq.leases
avahi-resolve -n rtk-loader-01.local
```

### 6. Flash by OTA

First try by hostname:

```bash
python3 /home/isrk/esp32-ota/espota.py \
  -i rtk-loader-01.local \
  -p 3232 \
  -f /home/isrk/esp32-ota/jun30a.ino.bin
```

If hostname does not work, flash by IP:

```bash
python3 /home/isrk/esp32-ota/espota.py \
  -i 192.168.X.X \
  -p 3232 \
  -f /home/isrk/esp32-ota/jun30a.ino.bin
```

Replace `192.168.X.X` with the ESP32 IP found in step 5.

Do not use `nc -vz ... 3232` as the main readiness check. With ArduinoOTA on ESP32 it can print `Connection refused` before OTA starts, while `espota.py` can still flash successfully because it first sends an OTA invitation.

### 7. Expected result

During OTA, ESP32 should print in Serial Monitor:

```text
OTA update started
OTA progress: ...
OTA update finished, rebooting
```

After reboot, Serial Monitor should print:

```text
OTA ready: rtk-loader-01 at 192.168.x.x
```

Telemetry and buffering are paused while OTA is running. After the ESP32 reboots, telemetry starts again.

If there is no Serial Monitor, check that ESP32 is alive again:

```bash
ping -c 3 rtk-loader-01.local
ip neigh show dev wlan0
```

It is normal if `nc -vz rtk-loader-01.local 3232` still prints `Connection refused` after reboot. The important signs are: `espota.py` finished without an error, ESP32 came back to ping, and RTK telemetry resumed on the server.

## Troubleshooting

If `rtk-loader-01.local` does not resolve:

```bash
avahi-resolve -n rtk-loader-01.local
arp -a
ip neigh show dev wlan0
```

If OTA cannot connect, first try flashing directly with `espota.py` and read its exact error:

```bash
python3 /home/isrk/esp32-ota/espota.py \
  -i rtk-loader-01.local \
  -p 3232 \
  -f /home/isrk/esp32-ota/jun30a.ino.bin
```

Or by IP:

```bash
python3 /home/isrk/esp32-ota/espota.py \
  -i 192.168.X.X \
  -p 3232 \
  -f /home/isrk/esp32-ota/jun30a.ino.bin
```

If `nc` is missing:

```bash
sudo apt update
sudo apt install -y netcat-openbsd
```

If the ESP32 is not visible in `hostapd_cli`, make sure the loader is powered on and connected to the Raspberry Pi Wi-Fi network.
