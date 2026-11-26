import { Conversation, type Callbacks } from "@elevenlabs/client";

/** The only file that talks to the ElevenLabs SDK; everything else sees this shape. */
export interface ElevenLabsConversation {
  end(): Promise<void>;
  /** What is playing right now. The SDK keeps answering after the socket closes. */
  outputSpectrum(): Uint8Array | null;
}

export interface StartOptions {
  token: string;
  prompt: string;
  callbacks: Callbacks;
}

export async function startConversation({
  token,
  prompt,
  callbacks,
}: StartOptions): Promise<ElevenLabsConversation> {
  const conversation = await Conversation.startSession({
    conversationToken: token,
    // The role travels with the handshake: the server applies it only at start.
    overrides: { agent: { prompt: { prompt } } },
    ...callbacks,
  });

  return {
    end: () => conversation.endSession(),
    outputSpectrum: () => conversation.getOutputByteFrequencyData() ?? null,
  };
}
