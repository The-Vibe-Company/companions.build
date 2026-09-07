import { useEffect } from "react";
import { CompanionAvatar } from "@/components/CompanionAvatar";
import "./LegalPage.css";

export type LegalPageKind = "privacy" | "terms";

const UPDATED = "September 7, 2026";

function BrandMark() {
  return <CompanionAvatar name="companions.build" avatar={{ shape: 1, color: 2, face: 0 }} size={30} />;
}

function PageFrame({ kind, children }: { kind: LegalPageKind; children: React.ReactNode }) {
  const title = kind === "privacy" ? "Privacy Policy" : "Terms of Use";
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} — companions.build`;
    return () => { document.title = previousTitle; };
  }, [title]);

  return <div className="legal-page">
    <a className="legal-skip" href="#legal-content">Skip to content</a>
    <header className="legal-header">
      <a className="legal-brand" href="/about" aria-label="companions.build home"><BrandMark /><strong>companions<span>.build</span></strong></a>
      <nav aria-label="Legal pages"><a aria-current={kind === "privacy" ? "page" : undefined} href="/privacy">Privacy</a><a aria-current={kind === "terms" ? "page" : undefined} href="/terms">Terms</a></nav>
    </header>
    <main id="legal-content" className="legal-content">
      <header><p>Legal</p><h1>{title}</h1><time dateTime="2026-09-07">Last updated {UPDATED}</time></header>
      {children}
    </main>
    <footer className="legal-footer"><span>© The Vibe Company</span><nav aria-label="Footer"><a href="/about">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:stan@thevibecompany.co">Contact</a></nav></footer>
  </div>;
}

function PrivacyPolicy() {
  return <PageFrame kind="privacy">
    <section>
      <h2>Who we are</h2>
      <p>companions.build is an AI companion service operated by The Vibe Company. This policy explains how we handle information when you visit or use the service.</p>
      <p>Questions and privacy requests can be sent to <a href="mailto:stan@thevibecompany.co">stan@thevibecompany.co</a>.</p>
    </section>
    <section>
      <h2>Information we handle</h2>
      <p>We handle the information needed to provide the service, including:</p>
      <ul>
        <li><strong>Account information</strong>, such as your email address, sign-in records, and session information.</li>
        <li><strong>Content you provide</strong>, such as Companion names and instructions, chat messages, files, routines, tasks, and support messages.</li>
        <li><strong>Connected-app information</strong>, including connection identifiers, encrypted authorization credentials, and information returned by a connected app when a Companion performs a task.</li>
        <li><strong>Service information</strong>, such as task status, usage, billing records, and technical or security records needed to operate and protect the service.</li>
      </ul>
    </section>
    <section>
      <h2>How we use information</h2>
      <p>We use this information to authenticate you, run and preserve your Companions and their work, carry out tasks and routines you direct, maintain connected apps, provide support and billing, and protect the service. We use technical and service records to diagnose problems and improve reliability.</p>
      <p>A Companion has a persistent cloud computer and execution history. Information used during a task may appear in its transcript, memory, files, or task results so that the task works and you can review or continue it.</p>
    </section>
    <section>
      <h2>Google Workspace and Gmail data</h2>
      <p>If you choose to connect Gmail, companions.build requests only the permissions used by its Gmail features:</p>
      <ul>
        <li><strong>Read-only Gmail access</strong> lets a Companion view your email messages and settings to perform tasks such as finding, reading, or summarizing messages.</li>
        <li><strong>Compose Gmail access</strong> is the Google permission used for draft management and sending. companions.build currently exposes creating and listing drafts only; it does not expose sending, deleting, or changing messages or labels.</li>
      </ul>
      <p>You choose whether to connect Gmail and which Companion may use the connection. OAuth credentials are stored encrypted by companions.build and used to make authorized requests for that Companion. Gmail content used in a task may be processed by the AI model provider used to complete that task and may be included in the Companion records described above.</p>
      <p>We use Google user data only to provide or improve the user-facing features you initiate or direct, and for security or legal purposes allowed by policy. Our use and transfer of information received from Google Workspace APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including its Limited Use requirements. We do not sell Google user data, use it for advertising, use it to determine creditworthiness, or use or transfer it to train or improve generalized, non-personalized AI or machine-learning models.</p>
    </section>
    <section>
      <h2>When we share information</h2>
      <p>We share information with service providers only as needed to operate companions.build—for example, providers of cloud hosting, storage, AI model processing, authentication email, billing, and connected-app infrastructure. They process information for the service functions we ask them to perform. We may also disclose information when required by law, to protect the service or its users, or as part of a business transaction where the recipient assumes the obligations that apply to the information.</p>
      <p>When you direct a Companion to communicate through a connected app that supports sending, the information you choose to send is shared with the recipients and service you selected. The current Gmail integration creates drafts for your review and does not send them.</p>
    </section>
    <section>
      <h2>Storage, security, and retention</h2>
      <p>We use safeguards appropriate to the information we handle, including access controls and encryption of stored connected-app credentials. No method of storage or transmission is completely secure.</p>
      <p>We keep information for as long as it is needed to provide the service, maintain security and business records, resolve disputes, and meet legal obligations. The period depends on the type of information and why it is held; we do not currently publish fixed retention periods.</p>
    </section>
    <section>
      <h2>Your choices</h2>
      <p>You can disconnect Gmail in the Apps area of companions.build, which removes the stored Gmail connection from the service. You can also revoke access from your Google Account’s third-party connections page. Revocation stops future access but does not automatically remove content already included in your Companion’s records.</p>
      <p>To ask for access to, correction of, or deletion of your information, email <a href="mailto:stan@thevibecompany.co">stan@thevibecompany.co</a>. We may need to verify your identity before completing a request.</p>
    </section>
    <section>
      <h2>Changes to this policy</h2>
      <p>We may update this policy as the service changes. We will update the date above when we do.</p>
    </section>
  </PageFrame>;
}

function TermsOfUse() {
  return <PageFrame kind="terms">
    <section>
      <h2>Using companions.build</h2>
      <p>These terms govern your use of companions.build, a service operated by The Vibe Company. By using the service, you agree to these terms. If you use it for an organization, you confirm that you have authority to accept these terms for that organization.</p>
      <p>The service is currently a private beta. Features may change as the product develops.</p>
    </section>
    <section>
      <h2>Your account and content</h2>
      <p>You are responsible for the accuracy of your account information, for activity performed through your account, and for keeping sign-in links and sessions secure. Tell us promptly if you believe your account has been used without permission.</p>
      <p>You retain your rights in the content you provide. You give The Vibe Company permission to host, process, transmit, and display that content only as needed to operate, secure, and support the service.</p>
    </section>
    <section>
      <h2>Connected apps and actions</h2>
      <p>You may connect third-party accounts, including Gmail, and assign them to a Companion. You confirm that you are authorized to connect those accounts and direct actions through them. You can disconnect an account at any time in the Apps area.</p>
      <p>Review important outputs and actions before relying on them. AI systems can make mistakes, and you remain responsible for decisions, messages, drafts, files, and other actions you approve or direct. Third-party services have their own terms and policies.</p>
    </section>
    <section>
      <h2>Acceptable use</h2>
      <p>Do not use companions.build to break the law, violate another person’s rights, gain unauthorized access, distribute spam or malware, interfere with the service, evade provider safeguards, or expose credentials or personal information you are not authorized to use.</p>
      <p>We may limit or suspend access when reasonably necessary to protect users, providers, or the service, or to address a violation of these terms.</p>
    </section>
    <section>
      <h2>Service availability</h2>
      <p>We work to provide a reliable service, but beta software may be interrupted, delayed, or changed. To the extent permitted by law, the service is provided without warranties beyond those that cannot legally be excluded. Nothing in these terms limits rights or liability that applicable law does not allow us to limit.</p>
    </section>
    <section>
      <h2>Open-source software</h2>
      <p>Parts of companions.build are available as open-source software. The license included with that software governs your use of the source code; these terms govern your use of the hosted service.</p>
    </section>
    <section>
      <h2>Changes and contact</h2>
      <p>We may update these terms as the service changes. We will update the date above when we do. Continued use after an update means you accept the revised terms.</p>
      <p>Questions about these terms can be sent to <a href="mailto:stan@thevibecompany.co">stan@thevibecompany.co</a>.</p>
    </section>
  </PageFrame>;
}

export function LegalPage({ kind }: { kind: LegalPageKind }) {
  return kind === "privacy" ? <PrivacyPolicy /> : <TermsOfUse />;
}
