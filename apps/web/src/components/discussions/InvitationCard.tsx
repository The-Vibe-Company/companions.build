import { Check, UserPlus } from "lucide-react";
import { discussionApi, type Companion, type DiscussionProposal } from "@/api";
import { Button } from "../ui/button";

export function InvitationCard({ discussionId, proposal, companion, onRefresh, onError }: {
  discussionId: string; proposal: DiscussionProposal; companion?: Companion;
  onRefresh: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  async function answer(accept: boolean) {
    try { await discussionApi.answerProposal(discussionId, proposal.id, accept); await onRefresh(); }
    catch (cause) { onError(cause); }
  }
  return <section className="invitation-proposal" aria-label={`Invite ${companion?.name ?? "companion"}`}><UserPlus aria-hidden="true" /><div className="invitation-copy">
    <p><strong>Invite {companion?.name ?? "this companion"}?</strong> {proposal.reason}</p>
    {proposal.prompt && <p className="invitation-prompt">{proposal.prompt}</p>}
  </div><div className="invitation-actions"><Button size="sm" onClick={() => void answer(true)}><Check />Accept</Button><Button size="sm" variant="ghost" onClick={() => void answer(false)}>Decline</Button></div></section>;
}
