#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -un)" == bechirob ]] || { echo "Run this as bechirob in Parrot's terminal."; exit 1; }
[[ "$(hostname)" == parrot ]] || { echo "Wrong machine: expected parrot."; exit 1; }
tailscale ip -4 | grep -Fxq 100.74.152.91 || { echo "Expected Parrot Tailscale address is missing."; exit 1; }
sudo -v
sudo install -d -m 0755 /etc/ssh/sshd_config.d
config=$(mktemp)
trap 'rm -f "$config"' EXIT
cat > "$config" <<'CONF'
ListenAddress 100.74.152.91
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers bechirob@100.84.164.68
CONF
target=/etc/ssh/sshd_config.d/00-parrot-tailnet.conf
if sudo test -e "$target"; then
    sudo cmp -s "$config" "$target" || { echo "Existing Parrot SSH configuration differs; stop for review."; exit 1; }
else
    sudo install -m 0644 "$config" "$target"
fi
if ! sudo test -x /usr/sbin/sshd; then sudo apt install -y openssh-server; fi
sudo /usr/sbin/sshd -t
sudo /usr/sbin/sshd -T | python3 -c 'import sys; rows=[l.split() for l in sys.stdin]; d={r[0]:r[1] for r in rows}; listeners=[r[1] for r in rows if r[0]=="listenaddress"]; assert listeners==["100.74.152.91:22"],listeners; assert d["passwordauthentication"]=="no" and d["kbdinteractiveauthentication"]=="no" and d["permitrootlogin"]=="no" and d["authenticationmethods"]=="publickey"; print("SSH configuration verified")'
install -d -m 0700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 0600 "$HOME/.ssh/authorized_keys"
key='from="100.84.164.68",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINoK7aAWprrEEJ8Uy4xUoVcS6O26E+6FcrhiRSQrcqKE hermes-parrot-assistance'
grep -Fqx "$key" "$HOME/.ssh/authorized_keys" || printf '\n%s\n' "$key" >> "$HOME/.ssh/authorized_keys"
sudo install -d -m 0755 /etc/systemd/system/ssh.service.d
sudo tee /etc/systemd/system/ssh.service.d/parrot-tailnet.conf >/dev/null <<'UNIT'
[Unit]
After=tailscaled.service
Wants=tailscaled.service
StartLimitIntervalSec=0
[Service]
Restart=on-failure
RestartSec=5s
UNIT
sudo systemctl disable --now ssh.socket 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable --now ssh
sudo systemctl restart ssh
sudo tailscale set --shields-up=false
systemctl is-active ssh tailscaled
sudo ss -lntp '( sport = :22 )'
sudo tailscale debug prefs | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:d.get(k) for k in ("RunSSH","ShieldsUp","WantRunning")})'
echo "PARROT_SSH_READY: ordinary SSH, dedicated Hermes key, Tailscale address only."
