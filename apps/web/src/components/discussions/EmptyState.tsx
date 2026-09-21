import type { Companion } from "@/api";

const STARTERS = ["Plan a new project", "Research a decision", "Turn an idea into a draft"];

export function EmptyState({ direct, onStarter }: { direct: Companion | null | undefined; onStarter: (value: string) => void }) {
  return <div className="discussion-empty">
    <div className="central-mark">c.</div>
    <h2>{direct ? `Start a conversation with ${direct.name}` : "What are we working on?"}</h2>
    <p>{direct ? `A private history with ${direct.name}.` : "Describe the outcome. Companions in this chat pick up the work you address to them."}</p>
    {!direct && <div className="discussion-starters">{STARTERS.map(value => <button key={value} onClick={() => onStarter(value)}>{value}</button>)}</div>}
  </div>;
}
