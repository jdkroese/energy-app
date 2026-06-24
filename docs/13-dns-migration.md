# hirobo.nl DNS migration → Cloudflare

> 2026-06-24. Moving hirobo.nl nameservers from **TransIP** to **Cloudflare** so we
> can run **Cloudflare Tunnel** to the Mac mini. Replicate EVERY record below in
> Cloudflare (DNS-only first), verify, switch NS, then enable tunnel/proxy.

## ⚠️ Rollback reference — current LIVE records (authoritative TransIP NS, 2026-06-24)
Current nameservers: `ns0.transip.net`, `ns1.transip.nl`, `ns2.transip.eu`.

| Type | Name | Value | Notes |
|---|---|---|---|
| A | `hirobo.nl` (root) | `34.111.179.208` | marketing site (Replit/GCP) |
| A | `www` | `149.210.189.239` | VPS |
| A | `energy` | `149.210.189.239` | VPS (→ tunnel at cutover) |
| MX | `hirobo.nl` | `hirobo-nl.mail.protection.outlook.com` (pri 10) | **M365 email** |
| TXT | `hirobo.nl` | `v=spf1 include:spf.protection.outlook.com -all` | SPF |
| TXT | `hirobo.nl` | `MS=ms62867760` | M365 domain verification |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | DMARC |
| CNAME | `autodiscover` | `autodiscover.outlook.com` | M365 |
| CNAME | `autoconfig` | `autoconfig.transip.email` | legacy TransIP |
| CNAME | `transip-A._domainkey` | `_dkim-A.transip.email` | DKIM |
| CNAME | `transip-B._domainkey` | `_dkim-B.transip.email` | DKIM |
| CNAME | `transip-C._domainkey` | `_dkim-C.transip.email` | DKIM |
| TXT | `x-transip-mail-auth` | `536b42eb89075224cbae57dcc59224a077113aa642379d738e46683a665aaf65` | TransIP mail-auth |
| TXT | `x-transip-mail-auth` | `c96d183a6816582d54e1e0345817f959e57a7ffaa325bde337ccbdd2ed6fda9a` | TransIP mail-auth |

**14 records total.** No `app`, no `AAAA`, no wildcard exist. In Cloudflare set
**every** record to **DNS only (gray cloud)** initially — proxying MX/CNAME/DKIM
breaks email. Auto-scan imports the A + MX but usually **drops the TXT + CNAMEs**
(SPF, MS=, the two x-transip-mail-auth, DMARC, autoconfig, autodiscover, 3 DKIM) —
add those by hand. Verify by querying the assigned Cloudflare NS before NS switch.

## ✅ Status (2026-06-24)
Cloudflare zone **configured via API + verified**: all **14 records present**, every
one **DNS-only (un-proxied)**; querying Cloudflare's NS (`celeste`/`trevor`) returns
identical answers to TransIP for MX, SPF, MS=, DMARC, x-transip-mail-auth×2,
autodiscover, autoconfig, 3× DKIM, www, energy, root. Zone status: **pending** (NS
not switched). **Assigned Cloudflare NS: `celeste.ns.cloudflare.com`,
`trevor.ns.cloudflare.com`.** Next: switch NS at TransIP. (API token still needed to
add the tunnel CNAME later — revoke after.)

## Migration steps
1. **Add hirobo.nl** to the user's Cloudflare account → Cloudflare auto-scans &
   imports records. **Set all records DNS-only (gray cloud)** initially to match
   current behaviour exactly.
2. **Verify** the imported set against the table above; add any missing
   (especially the email TXT/MX/CNAMEs). Keep MX + email records **DNS-only**.
3. Note the **2 Cloudflare nameservers** Cloudflare assigns.
4. **At TransIP:** change hirobo.nl nameservers to the Cloudflare pair.
5. **Wait** for Cloudflare to mark the zone Active; verify email (send/receive)
   and that root/www/energy still resolve to the same IPs.
6. **Then** set up Cloudflare Tunnel and repoint `energy.hirobo.nl` (and new
   hostnames) to the tunnel; selectively enable proxy (orange) on web records.
   Email records stay DNS-only forever.

## Post-migration target (after tunnel)
- `energy.hirobo.nl` → Cloudflare Tunnel → Mac mini (energy app)
- `app.hirobo.nl` / others → tunnel as apps migrate off the VPS
- root/`www` → unchanged until/unless the marketing site also moves
