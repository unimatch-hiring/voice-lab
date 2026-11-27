import type { Transport } from "../transport";
import { reviewTurns } from "./reviewTurns";

export async function openChildReview(transport: Transport, childId: string, rulesVersion: number) {
  const { conversationId } = await transport.startChildConversation(childId, rulesVersion);
  const reviews = reviewTurns((turn) => {
    void transport.reviewTurn({ ...turn, childId, conversationId }).catch(() => {
      console.warn("[voice-lab] Turn review failed");
    });
  });
  let closed = false;
  return {
    ...reviews,
    close(status: "ended" | "failed") {
      if (closed) return;
      closed = true;
      reviews.close();
      void transport.endChildConversation(childId, conversationId, status).catch(() => {
        console.warn("[voice-lab] Could not close the conversation record");
      });
    },
  };
}
