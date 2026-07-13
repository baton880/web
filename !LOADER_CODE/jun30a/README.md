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

After export, check that a `.bin` appeared near the sketch:

```powershell
Get-ChildItem -LiteralPath "c:\Users\Windows\projects\site_korovki\!LOADER_CODE\jun30a" -Filter "*.bin"
```

The expected file is usually named like:

```text
jun30a.ino.bin
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

scp "c:\Users\Windows\projects\site_korovki\!LOADER_CODE\jun30a\jun30a.ino.bin" `
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

On Raspberry Pi:

```bash
sudo hostapd_cli -i wlan0 all_sta
```

Also check DHCP leases:

```bash
cat /var/lib/misc/dnsmasq.leases
```

If `rtk-loader-01.local` is resolvable, this should print its IP:

```bash
avahi-resolve -n rtk-loader-01.local
```

If `.local` is not resolvable, look for ESP32 IP in:

```bash
arp -a
ip neigh show dev wlan0
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

## Troubleshooting

If `rtk-loader-01.local` does not resolve:

```bash
avahi-resolve -n rtk-loader-01.local
arp -a
ip neigh show dev wlan0
```

If OTA cannot connect:

```bash
ping rtk-loader-01.local
nc -vz rtk-loader-01.local 3232
```

Or by IP:

```bash
ping 192.168.X.X
nc -vz 192.168.X.X 3232
```

If `nc` is missing:

```bash
sudo apt update
sudo apt install -y netcat-openbsd
```

If the ESP32 is not visible in `hostapd_cli`, make sure the loader is powered on and connected to the Raspberry Pi Wi-Fi network.
