#!/usr/bin/env bash
# One-time VPS provisioning for the Energy app. Run as jdkroese01 on the VPS.
# (jdkroese01 has passwordless sudo.) Idempotent.
set -euo pipefail

echo "[1/5] App + secrets directories"
sudo mkdir -p /var/energy/apps/api/dist
sudo chown -R jdkroese01:jdkroese01 /var/energy
sudo mkdir -p /opt/energy/secrets
[ -f /opt/energy/.env ] || { sudo touch /opt/energy/.env; sudo chmod 600 /opt/energy/.env; }
sudo chown -R jdkroese01:jdkroese01 /opt/energy

echo "[2/5] systemd service"
sudo cp "$(dirname "$0")/energy-api.service" /etc/systemd/system/energy-api.service
sudo systemctl daemon-reload
sudo systemctl enable energy-api

echo "[3/5] nginx vhost"
sudo cp "$(dirname "$0")/nginx-energy.conf" /etc/nginx/sites-available/energy
sudo ln -sf /etc/nginx/sites-available/energy /etc/nginx/sites-enabled/energy
sudo nginx -t

echo "[4/5] reload nginx"
sudo systemctl reload nginx

echo "[5/5] start service (needs dist/index.cjs deployed first)"
sudo systemctl restart energy-api || echo "  (service will start once the first deploy lands the API build)"

echo "Done. Remember to fill /opt/energy/.env with real secrets."
