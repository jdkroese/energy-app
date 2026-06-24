# VPN Setup — Spain home LAN ↔ NL VPS

> Status: ✅ **WORKING** (2026-06-24). The NL VPS reaches the Spain home LAN over a
> WireGuard tunnel terminated on the UDM, with a Zone-Based Firewall policy
> permitting it. **Verified: VPS pulls live data from the Sonnen `/api/v2/status`
> over the tunnel.**

## ✅ SOLUTION SUMMARY (what's live)
1. **VPS WireGuard server** `wg0 = 10.10.0.1/24`, UDP 51820 (ufw open), ip_forward
   on. Public key `QgoLLAHHe/4W8aiAdYwyiBL/Lm24edd2zNY4MCO41kE=`. Peer = UDM,
   AllowedIPs `10.10.0.2/32, 192.168.1.0/24`.
2. **UDM WireGuard VPN Client** ("WireGuard Client 1"): Manual, tunnel IP
   `10.10.0.2/24`, server `149.210.189.239:51820`, Device Wizard **Off** (no LAN
   redirect), DNS 1.1.1.1/1.0.0.1 (unused). Public key
   `B6dwQ/ssytTX1Hbq5HYK/ZwzPbWAzA98eo/Kci6CXAI=`. Status: Established.
3. **Zone-Based Firewall** (upgraded from legacy): the WireGuard client lands in
   the **External** zone (LAN "Unifi" = **Internal**). Added policy
   **"Allow VPS Energy app to LAN"**: Source zone External, source `10.10.0.0/24`,
   Action Allow, Destination zone Internal (Any), all protocols, auto-allow return.
   This is what unblocked inbound VPS→LAN. (Gateway zone deliberately NOT opened →
   the UDM's own `192.168.1.1`/`10.10.0.2` don't answer pings; LAN devices do.)

**Verified from the VPS:** ping `192.168.1.170`/`.175` (Teslas) 0% loss ~45–80 ms;
`curl http://192.168.1.197/api/v2/status` returns live Sonnen JSON.

### LAN device map (Spain, 192.168.1.0/24)
| IP | Device |
|---|---|
| `192.168.1.1` | UDM gateway (Gateway zone — not exposed to tunnel) |
| `192.168.1.170` / `.175` | Tesla Powerwall 3 (×2) |
| `192.168.1.197` | **Sonnen** — `/api/v2/status` reads WITHOUT token over the tunnel |
| `192.168.1.210` | status API returns "unauthorized user" — likely Sungrow/inverter (TBD) |
| `.115` NVR/camera, `.122`/`.137` other services | not relevant |

---

> Original plan notes below (kept for reference). Goal: let the NL VPS reach Spain
> home LAN devices (Sonnen `/api/v2/`, Tesla Gateway TEDAPI, Sungrow) securely,
> with the **UDM** terminating the tunnel.

## Confirmed environment (from the live UniFi console)
- **Gateway:** UniFi Dream Machine (**UDM**), Network app **v10.5.51**.
- **Home LAN:** `192.168.1.0/24` (DHCP on UDM). Tesla PW3 at `192.168.1.170` /
  `192.168.1.175`. Sonnen IP = **TBD** (find in UniFi client list).
- **WAN:** ISP **Altecom**, WAN IPv4 **`192.168.18.2`** → **double-NAT / CGNAT**.
  ⇒ Home **cannot accept inbound**; the **UDM must dial out**.
- **Existing VPN:** a road-warrior **WireGuard VPN Server** already exists on the
  UDM (`192.168.5.0/24`, UDP 51820). Leave it; we use a **different** tunnel
  subnet to avoid clashes.
- **No native Tailscale** option on this UDM/version → use **WireGuard
  Site-to-Site**.

## Chosen design — WireGuard Site-to-Site (UDM initiates → VPS listens)

```
  Spain UDM (192.168.1.0/24)            WireGuard            NL VPS (public static IP)
   peer endpoint = VPS:51820   ───────── dial out ────────►  wg listens :51820
   PersistentKeepalive = 25s                                 peer AllowedIPs = 192.168.1.0/24
   remote networks = 10.10.0.0/24 (+VPS)                     local tunnel = 10.10.0.0/24
```

- **Tunnel subnet:** `10.10.0.0/24` (VPS = `10.10.0.1`, UDM = `10.10.0.2`).
- **VPS reaches** `192.168.1.0/24` over the tunnel; **Tesla cloud** stays a
  direct VPS→internet path (no tunnel needed for that).
- UDM keepalive keeps the NAT mapping open so the VPS can reach in anytime.

### Step 1 — VPS side (WireGuard server)
On the TransIP VPS (Linux):
```bash
sudo apt update && sudo apt install -y wireguard
wg genkey | sudo tee /etc/wireguard/vps_priv.key | wg pubkey | sudo tee /etc/wireguard/vps_pub.key
sudo nano /etc/wireguard/wg0.conf
```
`/etc/wireguard/wg0.conf`:
```ini
[Interface]
Address = 10.10.0.1/24
ListenPort = 51820
PrivateKey = <VPS_PRIVATE_KEY>

[Peer]                                  # the UDM (Spain home)
PublicKey = <UDM_PUBLIC_KEY>            # paste after Step 2
AllowedIPs = 10.10.0.2/32, 192.168.1.0/24
```
```bash
sudo sysctl -w net.ipv4.ip_forward=1          # persist in /etc/sysctl.conf
sudo ufw allow 51820/udp                       # open the WG port
sudo systemctl enable --now wg-quick@wg0
sudo wg show                                    # note Interface public key
```
Record the **VPS public key**, **VPS public IP**, and **port 51820** for Step 2.

### Step 2 — UDM side (Settings → VPN → Site-to-Site VPN → Create New → WireGuard)
- Type: **WireGuard (manual)**; UDM generates its own keypair → **copy the UDM
  public key** into the VPS `[Peer] PublicKey` (then restart `wg0` on the VPS).
- **Peer/Remote endpoint:** `VPS_public_IP:51820`
- **Peer public key:** the VPS public key from Step 1.
- **Local networks:** `192.168.1.0/24` (the home LAN to expose).
- **Remote networks:** `10.10.0.0/24` (the tunnel; add the VPS host if needed).
- Set **Persistent Keepalive = 25**. Save/enable.

### Step 3 — Verify
- VPS: `sudo wg show` shows a recent handshake + transfer.
- VPS: `ping 192.168.1.170` (Tesla) and the Sonnen IP succeed.
- VPS: `curl http://<sonnen-ip>/api/v2/status` (once the Sonnen token is enabled).

## Security
- Lock down with firewall rules so only the **VPS tunnel IP** (`10.10.0.1`) may
  reach only the battery/inverter IPs + ports (Sonnen `:80`, Tesla gateway,
  Sungrow) — not the whole `192.168.1.0/24`.
- Keep WG keys, Sonnen `Auth-Token`, and the Tesla gateway password in the VPS
  **secrets store**, never in git.

## Implementation status (2026-06-24)

**Done:**
- ✅ VPS WireGuard server (`wg0` = `10.10.0.1/24`, UDP 51820 open via ufw,
  ip_forward on). VPS public key `QgoLLAHHe/4W8aiAdYwyiBL/Lm24edd2zNY4MCO41kE=`.
  Keys in `/etc/wireguard/` on `149.210.189.239`.
- ✅ UDM **WireGuard VPN Client** created (Settings → VPN → VPN Client, Manual),
  tunnel IP `10.10.0.2/24`, server `149.210.189.239:51820`, Device Wizard **Off**
  (no LAN traffic redirected). **Status: Established.** UDM public key
  `B6dwQ/ssytTX1Hbq5HYK/ZwzPbWAzA98eo/Kci6CXAI=`. VPS peer registered with
  AllowedIPs `10.10.0.2/32, 192.168.1.0/24`.
- ✅ Handshake confirmed (UDM dials out from real public IP `212.121.235.197`;
  data flowing) — so the home is **not** strict CGNAT; outbound tunnel works.

**Was-blocker (RESOLVED):** inbound VPS→LAN initially failed because the UDM was
on the **legacy firewall** (no VPN ruleset). **Fix applied:** upgraded to the
**Zone-Based Firewall** and added the *External(10.10.0.0/24) → Internal* allow
policy (see Solution Summary at top). Inbound now works.

## Done / remaining
- [x] VPN site-to-site working; VPS reaches LAN; Sonnen `/api/v2/status` readable.
- [x] Sonnen LAN IP identified: **192.168.1.197**.
- [x] **Control verified over the tunnel (2026-06-24):** authenticated
      `GET /api/v2/configurations` (HTTP 200, `Auth-Token` header) and a reversible
      `PUT EM_USOC` write (0→5→0) both succeeded from the VPS; battery left as
      found (mode 2 self-consumption, reserve 0%). Live state at test: SoC 100%,
      exporting ~3.3–3.5 kW solar — the exact "Sonnen full, dumping solar" problem.
- [ ] **Token placement:** the Sonnen `Auth-Token` (36-char UUID) currently lives
      only in the **local PC** `.env` as `SONNEN_API_TOKEN` (NOTE: that line has an
      inline `# comment` — parse the quoted value, not the whole line). For the app
      to control the Sonnen from the VPS, copy it into the VPS app secrets/env.
- [ ] Identify `192.168.1.210` (Sungrow inverter?) and the Sungrow read path.
- [ ] Tighten the firewall policy later if desired (restrict to specific device
      IPs/ports instead of the whole Internal zone).
- [ ] Tesla: cloud Fleet API path (separate from this tunnel).
