import { describe, expect, test } from "bun:test";
import { createMailAdapter, MailDeliveryError, type MailConfiguration } from "../src/mail";

const base: MailConfiguration = {
  provider: "resend",
  from: "companions.build <auth@companions.build>",
  resendApiKey: "test-provider-secret",
  smtpPort: 25,
  smtpSecure: false,
};
const message = { to: "person@example.com", subject: "Your link", text: "Open the link" };

describe("mail adapter", () => {
  test("sends the documented Resend request to the fixed endpoint", async () => {
    let request: { input: string; init?: RequestInit } | undefined;
    const adapter = createMailAdapter(base, { fetch: async (input, init) => {
      request = { input: String(input), init };
      return Response.json({ id: "email_123" });
    } });

    await adapter.send(message);

    expect(request?.input).toBe("https://api.resend.com/emails");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.redirect).toBe("error");
    expect(request?.init?.headers).toEqual({ authorization: "Bearer test-provider-secret", "content-type": "application/json" });
    expect(JSON.parse(String(request?.init?.body))).toEqual({ from: base.from, to: [message.to], subject: message.subject, text: message.text });
  });

  test("requires explicit Resend selection and preserves implicit local SMTP", async () => {
    const noProvider = createMailAdapter({ ...base, provider: undefined, smtpHost: undefined });
    expect(noProvider.isConfigured).toBe(false);
    await expect(noProvider.send(message)).rejects.toMatchObject({ code: "mail_not_configured" });

    let sent: unknown;
    const smtp = createMailAdapter({ ...base, provider: undefined, resendApiKey: undefined, smtpHost: "127.0.0.1", smtpPort: 4325 }, {
      sendSmtp: async (options, mail) => { sent = { options, mail }; },
    });
    expect(smtp.provider).toBe("smtp");
    await smtp.send(message);
    expect(sent).toEqual({
      options: { host: "127.0.0.1", port: 4325, secure: false, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 },
      mail: { from: base.from, ...message },
    });
  });

  test("returns stable errors without exposing provider responses or credentials", async () => {
    const adapter = createMailAdapter(base, { fetch: async () => new Response('{"message":"rejected test-provider-secret customer-token"}', { status: 403 }) });
    let failure: unknown;
    try { await adapter.send(message); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MailDeliveryError);
    expect((failure as MailDeliveryError).code).toBe("mail_delivery_failed");
    expect(String(failure)).not.toContain("test-provider-secret");
    expect(String(failure)).not.toContain("customer-token");
  });

  test("bounds hung Resend requests and reports a stable timeout", async () => {
    const adapter = createMailAdapter(base, {
      timeoutMs: 5,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted with provider detail", "AbortError")), { once: true });
      }),
    });
    await expect(adapter.send(message)).rejects.toMatchObject({ code: "mail_delivery_timeout", message: "mail_delivery_timeout" });
  });

  test("rejects malformed and oversized success responses", async () => {
    const malformed = createMailAdapter(base, { fetch: async () => Response.json({ ok: true }) });
    await expect(malformed.send(message)).rejects.toMatchObject({ code: "mail_delivery_failed" });

    const oversized = createMailAdapter(base, { fetch: async () => new Response("x", { headers: { "content-length": "20000" } }) });
    await expect(oversized.send(message)).rejects.toMatchObject({ code: "mail_delivery_failed" });
  });

  test("does not send with partial or unknown provider configuration", async () => {
    let calls = 0;
    const fetchStub = async () => { calls++; return Response.json({ id: "unexpected" }); };
    await expect(createMailAdapter({ ...base, resendApiKey: undefined }, { fetch: fetchStub }).send(message))
      .rejects.toMatchObject({ code: "mail_configuration_invalid" });
    expect(createMailAdapter({ ...base, resendApiKey: undefined }).isConfigured).toBe(false);
    const unknown = createMailAdapter({ ...base, provider: "other" }, { fetch: fetchStub });
    expect(unknown.isConfigured).toBe(false);
    await expect(unknown.send(message))
      .rejects.toMatchObject({ code: "mail_configuration_invalid" });
    expect(calls).toBe(0);
  });
});
