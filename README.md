# NimbusOS Beta 2

**A modern, open-source NAS operating system** with a desktop-like web interface.

Transform any Ubuntu/Debian server into a powerful NAS with Docker management, RAID storage, media streaming, file sharing, and more — all from a glass-effect browser-based desktop.

---

## Quick Install

One command on a fresh Ubuntu Server 22.04+ or Debian 12+:

```bash
curl -fsSL https://raw.githubusercontent.com/andresgv-beep/nimbus-os-beta-2/main/install.sh | sudo bash
```

Then open `http://<your-server-ip>:5000` in any browser.

### What gets installed

- Node.js 20 (via NodeSource)
- Docker CE (if not already present)
- Samba, FTP, Avahi (mDNS)
- UFW firewall (preconfigured)
- NimbusOS as a systemd service (auto-start on boot)

### Supported platforms

| Platform | Architecture | Status |
|----------|-------------|--------|
| Ubuntu Server 22.04+ | x86_64 | ✔ Primary |
| Ubuntu Server 22.04+ | aarch64 | ✔ Tested |
| Debian 12+ | x86_64 | ✔ Tested |
| Raspberry Pi OS (64-bit) | aarch64 | ✔ Tested |

### Requirements

- 1 GB RAM minimum (2 GB+ recommended)
- 2 GB free disk for NimbusOS + your data
- Network connection

---

## Features

- **Desktop UI** — Glass-effect windowed interface with taskbar, dock, and app launcher
- **3 Themes** — Dark, Midnight, and Light with custom accent colors and glow intensity
- **Docker Management** — Install, configure, and manage containers from the App Store
- **File Manager** — Browse, upload, download with drag-and-drop
- **Storage Manager** — RAID 0/1/5/10 via mdadm, disk health (SMART), auto-import existing arrays
- **Network Manager** — SMB, FTP, NFS, WebDAV, SSH, DNS, Reverse Proxy, SSL certificates
- **Firewall & UPnP** — Port management, router forwarding, DDNS
- **Remote Access** — DDNS + Let's Encrypt + HTTPS in one panel
- **System Monitor** — CPU, RAM, GPU, temps in real-time
- **Virtual Machines** — QEMU/KVM management
- **Download Station** — Transmission + aMule integration
- **Media Player** — Built-in audio/video player with playlists
- **Terminal** — Web-based shell (admin only)
- **Multi-user** — Admin and standard accounts with 2FA (TOTP)
- **GPU Detection** — NVIDIA, AMD, Intel — auto performance modes

---

## Management

```bash
# Service control
sudo systemctl status nimbusos
sudo systemctl restart nimbusos
sudo journalctl -u nimbusos -f

# Update to latest
sudo /opt/nimbusos/scripts/update.sh

# Uninstall
sudo /opt/nimbusos/scripts/uninstall.sh
```

---

## Architecture (Beta 2)

Beta 2 introduces a modular backend — the monolithic server was split into 12 focused modules:

```
server/
  index.cjs          ← Router only (467 lines)
  lib/
    shared.cjs       ← Constants, sessions, helpers
    auth.cjs         ← Auth, 2FA, users, preferences
    apps.cjs         ← App registry, native app detection
    shares.cjs       ← Shared folders
    docker.cjs       ← Containers, compose, stacks
    network.cjs      ← SMB, FTP, NFS, WebDAV, SSH, DNS, Proxy, UPnP
    hardware.cjs     ← CPU, GPU, memory, temps, disks
    storage.cjs      ← RAID pools, health checks
    files.cjs        ← File manager, upload/download
    vms.cjs          ← Virtual machines (QEMU/KVM)
    downloads.cjs    ← Transmission + aMule
```

```
Browser ──→ Vite (dev) / Static (prod) ──→ Node.js Backend
                                              ├── System APIs (/proc, /sys, lm-sensors)
                                              ├── Docker API (unix socket)
                                              ├── Storage (mdadm, smartctl)
                                              ├── Network (ufw, ss, UPnP, nginx)
                                              └── File System (SMB, NFS, WebDAV, FTP)
```

---

## Directory Structure

```
/opt/nimbusos/          # Application code
~/.nimbusos/config/     # Users, sessions, app configs
~/.nimbusos/userdata/   # Per-user preferences, playlists
~/.nimbusos/volumes/    # Docker volumes, shared folders
/var/log/nimbusos/      # Logs
```

## Default Ports

| Port | Service |
|------|---------|
| 5000 | NimbusOS Web UI |
| 22   | SSH |
| 445  | Samba (SMB) |
| 5353 | Avahi (mDNS) |

## Security

- Rate-limited login with progressive lockout
- 2FA with TOTP (Google Authenticator compatible)
- One-time backup codes
- Tokens hashed (SHA-256) before storage
- 24h session expiry
- UFW firewall with sensible defaults
- Path traversal prevention

---

## Changelog: Beta 1 → Beta 2

- **Modular backend** — 8,649-line monolith split into 12 modules
- **Fixed duplicate `hashPassword`** — Was silently defined twice
- **Update script** — Now detects changes in all server modules, not just index
- **Repo independence** — Beta 2 has its own repo, Beta 1 untouched

---

## License

MIT License — see [LICENSE](LICENSE)

---

Built with ❤️ for the self-hosting community.
