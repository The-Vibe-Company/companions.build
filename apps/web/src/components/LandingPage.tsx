import { useEffect } from "react";
import { CompanionAvatar, type CompanionAvatarValue } from "@/components/CompanionAvatar";
import { ProviderMark } from "@/components/ProviderMark";
import "./LandingPage.css";

const people: Array<{ name: string; avatar: CompanionAvatarValue }> = [
  { name: "Sage", avatar: { shape: 6, color: 5, face: 0 } },
  { name: "Nova", avatar: { shape: 1, color: 2, face: 0 } },
  { name: "Bo", avatar: { shape: 6, color: 4, face: 1 } },
];

const stories = [
  { name: "June", job: "inbox", avatar: { shape: 3, color: 7, face: 0 }, did: "Reads support email every morning, drafts replies in your tone, and brings you the ones that need a decision.", who: "For an indie app maker" },
  { name: "Nova", job: "your app", avatar: { shape: 1, color: 2, face: 0 }, did: "Watches for errors, fixes small ones, opens a pull request for the rest, and explains the change like a colleague would.", who: "For a small product team" },
  { name: "Bo", job: "the shop", avatar: { shape: 6, color: 4, face: 1 }, did: "Answers customer questions, brings refunds to you for approval, and prepares a Friday summary of what sold.", who: "For an online shop" },
] satisfies Array<{ name: string; job: string; avatar: CompanionAvatarValue; did: string; who: string }>;

const questions = [
  ["Do I need to know how to code?", "No. Give your companion a name and a job in a sentence. Everything else is a conversation."],
  ["Can it do things I didn't ask for?", "It works with the accounts you explicitly grant. Its activity is written down, and you can stop active work."],
  ["What are specialists?", "Reusable helpers a companion can bring in for a specific job, such as research, writing, or checking."],
  ["Where does it run?", "On a persistent cloud computer, or locally when that option is available in your deployment."],
  ["Who can join the private beta?", "Access is currently limited to invited, verified email addresses."],
];

function BrandMark({ size = 30 }: { size?: number }) {
  return <CompanionAvatar name="companions.build" avatar={{ shape: 1, color: 2, face: 0 }} size={size} />;
}

function Cta({ onClick, compact = false }: { onClick: () => void; compact?: boolean }) {
  return <button type="button" className={compact ? "landing-cta landing-cta--compact" : "landing-cta"} onClick={onClick}>{compact ? "Private beta" : "Log in to private beta"} <span aria-hidden="true">→</span></button>;
}

export function LandingPage({ onLogin }: { onLogin: () => void }) {
  useEffect(() => {
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousTitle = document.title;
    const previousDescription = description?.content;
    document.title = "companions.build — Your persistent AI teammate";
    if (description) description.content = "Name an AI companion, give it a job, and work together from one durable chat.";
    return () => {
      document.title = previousTitle;
      if (description && previousDescription != null) description.content = previousDescription;
    };
  }, []);

  return <main className="landing" id="main-content">
    <a className="landing-skip" href="#how-it-works">Skip to content</a>
    <header className="landing-header">
      <a className="landing-brand" href="/" aria-label="companions.build home"><BrandMark /><strong>companions<span>.build</span></strong></a>
      <nav aria-label="Main navigation">
        <a href="#how-it-works">How it works</a>
        <a href="#stories">Stories</a>
        <a href="https://github.com/The-Vibe-Company/companions.build" target="_blank" rel="noreferrer">Open source</a>
        <button type="button" onClick={onLogin}>Log in</button>
        <Cta onClick={onLogin} compact />
      </nav>
      <button className="landing-mobile-login" type="button" onClick={onLogin}>Log in</button>
    </header>

    <section className="landing-hero">
      <div className="landing-hero-copy">
        <div className="landing-badge"><i />Open source · Private beta</div>
        <h1>A companion for whatever’s on your mind.</h1>
        <p>A little help with everyday tasks, big ideas, and everything in between. Give your companion a name, tell it what you need, and take it from there.</p>
        <div className="landing-hero-action"><Cta onClick={onLogin} /><span>Invitation required</span></div>
        <div className="landing-promises"><span>Uses only granted accounts</span><span>Every step written down</span><span>Take the mouse any time</span></div>
      </div>
      <div className="landing-lineup" aria-label="A team of Companions">
        <div className="landing-bubble landing-bubble--companion">Two errors overnight. I fixed a typo and opened a pull request for the other. Review it?</div>
        <div className="landing-bubble landing-bubble--person">I’ll read it first.</div>
        {people.map((person, index) => <CompanionAvatar key={person.name} {...person} size={[130, 210, 150][index]} className={`landing-person landing-person--${index + 1}`} />)}
      </div>
    </section>

    <div className="landing-tools"><span>Works with the tools you already use</span><div>{[["linear", "Linear"], ["github", "GitHub"], ["slack", "Slack"], ["gmail", "Gmail"]].map(([provider, name]) => <span key={provider}><ProviderMark provider={provider} name={name} />{name}</span>)}</div></div>

    <section className="landing-section" id="how-it-works">
      <h2>Three steps to your first companion.</h2>
      <div className="landing-steps">
        <article><div className="landing-step-art landing-step-faces">{people.map(person => <CompanionAvatar key={person.name} {...person} size={84} />)}</div><span>1</span><h3>Name it</h3><p>Pick a face, a name, and one sentence about the job. That is the whole setup.</p></article>
        <article><div className="landing-step-art landing-app-grid">{[["linear", "Linear"], ["github", "GitHub"], ["slack", "Slack"], ["gmail", "Gmail"]].map(([provider, name]) => <span key={provider}><ProviderMark provider={provider} name={name} /></span>)}</div><span>2</span><h3>Hand over your tools</h3><p>Connect the accounts it may use. Choose each one, and take access back any time.</p></article>
        <article><div className="landing-step-art"><div className="landing-working"><CompanionAvatar name="Pip" avatar={{ shape: 2, color: 7, face: 1 }} size={30} />Pip is on it <i /><i /><i /></div></div><span>3</span><h3>Let it work</h3><p>Ask in chat or set a schedule. It can bring in specialists when a job needs more hands.</p></article>
      </div>
    </section>

    <section className="landing-stories" id="stories"><div>
      <h2>What you can ask a companion to do.</h2>
      <p>Three ways to set up one persistent teammate.</p>
      <div className="landing-story-grid">{stories.map(story => <article key={story.name}><CompanionAvatar name={story.name} avatar={story.avatar} size={72} /><div><h3>{story.name} <span>· {story.job}</span></h3><p>{story.did}</p></div><small>{story.who}</small></article>)}</div>
    </div></section>

    <section className="landing-control">
      <div><h2>You stay in charge.</h2><p>Companions work with the access you grant. You can follow durable activity, stop active work, and open the computer to see what is happening.</p></div>
      <div className="landing-question"><header><CompanionAvatar name="Bo" avatar={{ shape: 6, color: 4, face: 1 }} size={36} /><strong>Bo needs you</strong></header><p>Two customers asked for refunds this morning. Should I approve both, or do you want to look first?</p><div><span>Approve both</span><span>Let me look</span></div></div>
    </section>

    <section className="landing-faq" id="questions"><h2>Questions people ask first.</h2>{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</section>

    <footer className="landing-footer">
      <div className="landing-peek" aria-hidden="true">{stories.map(story => <CompanionAvatar key={story.name} name={story.name} avatar={story.avatar} size={96} />)}</div>
      <div><h2>Your first companion is waiting.</h2><p>Private beta · Invitation required</p><Cta onClick={onLogin} /><nav aria-label="Footer"><a href="#stories">Stories</a><a href="https://github.com/The-Vibe-Company/companions.build" target="_blank" rel="noreferrer">GitHub</a><a href="#questions">Help</a><a href="https://github.com/The-Vibe-Company/companions.build/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT license</a></nav></div>
    </footer>
  </main>;
}
