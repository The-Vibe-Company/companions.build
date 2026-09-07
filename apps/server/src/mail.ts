import nodemailer from "nodemailer";

export type MailMessage = { to: string; subject: string; text: string };
export type MailProvider = "smtp" | "resend";

export type MailConfiguration = {
  provider?: string;
  from: string;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  resendApiKey?: string;
};

type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  auth?: { user: string; pass: string };
};

type Dependencies = {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  sendSmtp?: (options: SmtpOptions, message: MailMessage & { from: string }) => Promise<unknown>;
};

export type MailErrorCode = "mail_not_configured" | "mail_configuration_invalid" | "mail_delivery_failed" | "mail_delivery_timeout";

export class MailDeliveryError extends Error {
  constructor(readonly code: MailErrorCode) {
    super(code);
    this.name = "MailDeliveryError";
  }
}

function selectedProvider(configuration: MailConfiguration): MailProvider | null | "invalid" {
  const explicit = configuration.provider?.trim().toLowerCase();
  if (explicit === "smtp" || explicit === "resend") return explicit;
  if (explicit) return "invalid";
  // SMTP inference preserves the zero-configuration Mailpit development path. A
  // Resend key alone never changes the provider; hosted use must be explicit.
  return configuration.smtpHost ? "smtp" : null;
}

async function readSmallJson(response: Response): Promise<unknown> {
  const limit = 16 * 1024;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new MailDeliveryError("mail_delivery_failed");
  if (!response.body) throw new MailDeliveryError("mail_delivery_failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new MailDeliveryError("mail_delivery_failed");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new MailDeliveryError("mail_delivery_failed"); }
}

export function createMailAdapter(configuration: MailConfiguration, dependencies: Dependencies = {}) {
  const provider = selectedProvider(configuration);
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  const fetchImpl = dependencies.fetch ?? fetch;
  const sendSmtp = dependencies.sendSmtp ?? (async (options, message) => {
    await nodemailer.createTransport(options).sendMail(message);
  });
  const validFrom = Boolean(configuration.from.trim());
  const validSmtp = Boolean(configuration.smtpHost)
    && Number.isInteger(configuration.smtpPort) && configuration.smtpPort >= 1 && configuration.smtpPort <= 65_535
    && Boolean(configuration.smtpUser) === Boolean(configuration.smtpPassword);
  const validResend = Boolean(configuration.resendApiKey);
  const isConfigured = validFrom && ((provider === "smtp" && validSmtp) || (provider === "resend" && validResend));

  return {
    provider: provider === "invalid" ? null : provider,
    isConfigured,
    async send(message: MailMessage): Promise<void> {
      if (provider === null) throw new MailDeliveryError("mail_not_configured");
      if (provider === "invalid" || !configuration.from.trim()) throw new MailDeliveryError("mail_configuration_invalid");

      if (provider === "smtp") {
        if (!configuration.smtpHost || !Number.isInteger(configuration.smtpPort) || configuration.smtpPort < 1 || configuration.smtpPort > 65_535) {
          throw new MailDeliveryError("mail_configuration_invalid");
        }
        if (Boolean(configuration.smtpUser) !== Boolean(configuration.smtpPassword)) throw new MailDeliveryError("mail_configuration_invalid");
        try {
          await sendSmtp({
            host: configuration.smtpHost,
            port: configuration.smtpPort,
            secure: configuration.smtpSecure,
            connectionTimeout: timeoutMs,
            greetingTimeout: timeoutMs,
            socketTimeout: timeoutMs,
            ...(configuration.smtpUser && configuration.smtpPassword
              ? { auth: { user: configuration.smtpUser, pass: configuration.smtpPassword } }
              : {}),
          }, { from: configuration.from, ...message });
        } catch {
          throw new MailDeliveryError("mail_delivery_failed");
        }
        return;
      }

      if (!configuration.resendApiKey) throw new MailDeliveryError("mail_configuration_invalid");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${configuration.resendApiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ from: configuration.from, to: [message.to], subject: message.subject, text: message.text }),
        });
        if (!response.ok) throw new MailDeliveryError("mail_delivery_failed");
        const result = await readSmallJson(response);
        if (!result || typeof result !== "object" || typeof (result as { id?: unknown }).id !== "string" || !(result as { id: string }).id) {
          throw new MailDeliveryError("mail_delivery_failed");
        }
      } catch (error) {
        if (error instanceof MailDeliveryError) throw error;
        if (controller.signal.aborted) throw new MailDeliveryError("mail_delivery_timeout");
        throw new MailDeliveryError("mail_delivery_failed");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
