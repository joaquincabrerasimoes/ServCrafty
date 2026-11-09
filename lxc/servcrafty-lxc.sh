#!/usr/bin/env bash
# ServCrafty – Proxmox VE LXC installer (run on the Proxmox HOST as root)
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/joaquincabrerasimoes/ServCrafty/main/lxc/servcrafty-lxc.sh)"
# (If you fork this repo and make it private, export GITHUB_TOKEN=... first.)
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
# The repository is public; GITHUB_TOKEN is only needed for a private fork.
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

CLONE_URL="$REPO_URL"; [[ -z "$GITHUB_TOKEN" ]] || CLONE_URL="${REPO_URL/https:\/\//https://$GITHUB_TOKEN@}"

echo ">> Downloading Debian 12 template"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '/debian-12-standard/{print $2}' | sort -V | tail -1)
[[ -n "$TEMPLATE" ]] || { echo "No debian-12-standard template found in 'pveam available'"; exit 1; }
# (no `grep -q` in a pipeline: under pipefail an early-exit grep can make the pipeline fail)
TEMPLATES_PRESENT=$(pveam list "$TEMPLATE_STORAGE")
grep -qF "$TEMPLATE" <<<"$TEMPLATES_PRESENT" || pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"

echo ">> Creating CT $CTID"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME" --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "$STORAGE:$DISK" --net0 "name=eth0,bridge=$BRIDGE,ip=$IPCFG" \
  --unprivileged 0 --features nesting=1,keyctl=1 --onboot 1 --ostype debian
pct start "$CTID"
echo ">> Waiting for the CT network"
for _ in $(seq 60); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done

# User-supplied values travel base64-encoded so that $, `, quotes, backslashes or
# newlines in a password / URL are never interpreted by either shell.
b64() { printf '%s' "$1" | base64 -w0; }

# --- in-container install: a generated header (values) + a quoted, literal body ---
{
  cat <<HEADER
DATABASE_URL_B64=$(b64 "$DATABASE_URL")
ADMIN_USERNAME_B64=$(b64 "$ADMIN_USERNAME")
ADMIN_PASSWORD_B64=$(b64 "$ADMIN_PASSWORD")
PUBLIC_URL_B64=$(b64 "$PUBLIC_URL")
CLONE_URL_B64=$(b64 "$CLONE_URL")
HEADER
  cat <<'INSTALL'
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
dec() { printf '%s' "$1" | base64 -d; }
# systemd EnvironmentFile syntax: KEY="value" with \ and \" escaped
envline() { printf '%s="%s"\n' "$1" "$(dec "$2" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }
CLONE_URL=$(dec "$CLONE_URL_B64")

apt-get update && apt-get install -y curl ca-certificates git gnupg tar iptables
curl -fsSL https://get.docker.com | sh
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
git clone "$CLONE_URL" /opt/servcrafty && git -C /opt/servcrafty remote set-url origin "$CLONE_URL"
cd /opt/servcrafty && npm install --workspaces --include-workspace-root && npm run build --workspace web && npm run build --workspace server
mkdir -p /data /etc/servcrafty
SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')
umask 077
{
  envline DATABASE_URL "$DATABASE_URL_B64"
  printf 'SECRET_KEY="%s"\n' "$SECRET"
  envline ADMIN_USERNAME "$ADMIN_USERNAME_B64"
  envline ADMIN_PASSWORD "$ADMIN_PASSWORD_B64"
  envline PUBLIC_URL "$PUBLIC_URL_B64"
  printf '%s\n' 'TRUST_PROXY=1' 'DATA_DIR=/data' 'PORT=8080' 'NODE_ENV=production'
  # Self-update (Admin > Updates): git checkout install, stable GitHub releases of UPDATE_REPO.
  printf '%s\n' 'INSTALL_TYPE=lxc' 'UPDATE_REPO=joaquincabrerasimoes/ServCrafty' 'UPDATE_CHECK=1'
} > /etc/servcrafty/env
chmod 600 /etc/servcrafty/env
cat > /etc/systemd/system/servcrafty.service <<'UNIT'
[Unit]
Description=ServCrafty
Wants=network-online.target
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
INSTALL
} | pct exec "$CTID" -- bash -s

IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
echo "== ServCrafty ready: http://$IP:8080 (CT $CTID). Update later from Admin > Updates in the web UI."
