export const agentService = `[Unit]
Description=Companions Pi agent
[Service]
EnvironmentFile=/home/user/.companions.env
ExecStart=/home/user/.companions-dist/companion-agent
Restart=on-failure
RestartSec=2
[Install]
WantedBy=default.target
`;

// Box command sessions do not inherit the user-manager bus environment.
// This expansion executes inside Box, never on the developer host.
export const userSystemctl = (args: string) =>
  `XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus systemctl --user ${args}`;
