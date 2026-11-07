#!/usr/bin/env bash
# ServCrafty – Proxmox VE LXC installer (run on the Proxmox HOST as root)
#   (private repo) copy this script to the Proxmox host and run:  GITHUB_TOKEN=ghp_xxx bash servcrafty-lxc.sh
# Creates a privileged, nesting-enabled Debian 12 CT, installs Docker + Node + ServCrafty (systemd).
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/joaquincabrerasimoes/ServCrafty.git}"
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
HOSTNAME="${HOSTNAME_CT:-servcrafty}"
CORES="${CORES:-4}"
RAM="${RAM:-8192}"
DISK="${DISK:-40}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
IPCFG="${IPCFG:-dhcp}"   # or e.g. 192.168.1.50/24,gw=192.168.1.1

[[ $EUID -eq 0 ]] || { echo "Run as root on the Proxmox host"; exit 1; }
command -v pct >/dev/null || { echo "pct not found – this must run on a Proxmox VE host"; exit 1; }

read -rp "PostgreSQL URL (postgres://user:pass@host:5432/db): " DATABASE_URL
read -rp "Admin username [admin]: " ADMIN_USERNAME; ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
read -rsp "Admin password: " ADMIN_PASSWORD; echo
read -rp "Public URL [https://servcrafty.joaquincabrerasimoes.com]: " PUBLIC_URL || true
PUBLIC_URL=${PUBLIC_URL:-https://servcrafty.joaquincabrerasimoes.com}
# The repository is private: a GitHub token with read access is required.
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
[[ -n "$GITHUB_TOKEN" ]] || read -rsp "GitHub token (repo read access): " GITHUB_TOKEN; echo
CLONE_URL="${REPO_URL/https:\/\//https://$GITHUB_TOKEN@}"

echo ">> Downloading Debian 12 template"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '/debian-12-standard/{print $2}' | sort -V | tail -1)
pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE" || pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"

echo ">> Creating CT $CTID"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME" --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "$STORAGE:$DISK" --net0 "name=eth0,bridge=$BRIDGE,ip=$IPCFG" \
  --unprivileged 0 --features nesting=1,keyctl=1 --onboot 1 --ostype debian
pct start "$CTID"
sleep 8

pct exec "$CTID" -- bash -s <<EOF
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get install -y curl ca-certificates git gnupg tar iptables
curl -fsSL https://get.docker.com | sh
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
git clone "$CLONE_URL" /opt/servcrafty && git -C /opt/servcrafty remote set-url origin "$CLONE_URL"
cd /opt/servcrafty && npm install --workspaces --include-workspace-root && npm run build --workspace web && npm run build --workspace server
mkdir -p /data /etc/servcrafty
SECRET=\$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')
cat > /etc/servcrafty/env <<ENV
DATABASE_URL=$DATABASE_URL
SECRET_KEY=\$SECRET
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
PUBLIC_URL=$PUBLIC_URL
DATA_DIR=/data
PORT=8080
NODE_ENV=production
ENV
chmod 600 /etc/servcrafty/env
cat > /etc/systemd/system/servcrafty.service <<UNIT
[Unit]
Description=ServCrafty
After=docker.service network-online.target
Requires=docker.service
[Service]
EnvironmentFile=/etc/servcrafty/env
ExecStartPre=-/usr/bin/docker network create servcrafty
WorkingDirectory=/opt/servcrafty
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now docker servcrafty
EOF

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
echo "== ServCrafty ready: http://$IP:8080 (CT $CTID). Update later with: pct exec $CTID -- bash /opt/servcrafty/lxc/update.sh"
