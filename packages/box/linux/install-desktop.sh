#!/bin/sh
set -eu
test "$(id -u)" = 0
test -x /opt/companions/companion-agent
for tool in ip iptables unshare setpriv python3 xdotool ffmpeg sysctl; do command -v "$tool" >/dev/null; done
test -x /lib/systemd/systemd-socket-proxyd
getent group companions-desktop-client >/dev/null || groupadd --system companions-desktop-client
id companions-agent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin companions-agent
usermod -a -G companions-desktop-client companions-agent
python3 /opt/companions/retire-legacy.py
install -m 755 /opt/companions/desktop-capture.py /usr/local/bin/companions-desktop-capture
install -m 755 /opt/companions/desktop-quiesce.py /usr/local/bin/companions-desktop-quiesce
install -m 755 /opt/companions/desktop-state.py /usr/local/bin/companions-desktop-state
mkdir -p /var/lib/companions-desktop
chown user:user /var/lib/companions-desktop
chmod 700 /var/lib/companions-desktop
cat > /etc/systemd/system/companions-desktop.service <<'UNIT'
[Unit]
Description=Companions desktop interaction broker
After=network.target
[Service]
User=user
Group=companions-desktop-client
Environment=DISPLAY=:0
Environment=DESKTOP_STATE_DIR=/var/lib/companions-desktop
EnvironmentFile=-/etc/companions-desktop.env
Environment=DESKTOP_AGENT_SOCKET=/run/companions-desktop/agent.sock
Environment=DESKTOP_ADMIN_SOCKET=/run/companions-desktop-admin/control.sock
RuntimeDirectory=companions-desktop companions-desktop-admin
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
ExecStart=/opt/companions/companion-agent --desktop-broker
Restart=on-failure
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/companions-agent.service <<'UNIT'
[Unit]
Description=Companions isolated headless Pi runtime
After=companions-desktop.service network.target
Wants=companions-desktop.service
[Service]
EnvironmentFile=/home/user/.companions.env
ExecStart=/usr/bin/python3 /opt/companions/launch-headless.py
KillMode=control-group
Restart=on-failure
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/companions-agent-proxy.socket <<'UNIT'
[Socket]
# Box private preview reaches the guest address. Bearer auth remains on the daemon;
# the isolated headless veth cannot connect to host listeners through INPUT policy.
ListenStream=0.0.0.0:8787
[Install]
WantedBy=sockets.target
UNIT
cat > /etc/systemd/system/companions-agent-proxy.service <<'UNIT'
[Unit]
Requires=companions-agent.service
After=companions-agent.service
[Service]
ExecStart=/lib/systemd/systemd-socket-proxyd 100.127.250.2:8787
NoNewPrivileges=yes
PrivateTmp=yes
UNIT
printf '1\n' > /opt/companions/desktop-boundary.version
systemctl daemon-reload
systemctl enable companions-desktop.service companions-agent.service companions-agent-proxy.socket
