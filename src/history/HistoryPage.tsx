import type { HistoryApi } from "../lib/historyApi";
import { ConversationView } from "./ConversationView";
import { HistoryList } from "./HistoryList";
import "../scene/tokens.css";
import "../history.css";

/**
 * `?history` lists the visitor's conversations; `?history=<id>` opens one. `api` is null
 * where no history server is configured (the published site, previews) or the browser has
 * no user id.
 */
export function HistoryPage({
  api,
  conversationId,
  navigate = (href) => window.location.assign(href),
  timeZone,
}: {
  api: HistoryApi | null;
  conversationId: string | null;
  navigate?: (href: string) => void;
  /** For tests; the page shows the viewer's own time zone. */
  timeZone?: string;
}) {
  const inConversation = conversationId !== null;

  return (
    <main className="shell history-shell">
      <header className="masthead">
        <a className="history-back" href={inConversation ? "?history" : "./"}>
          {inConversation ? "← History" : "← voice-lab"}
        </a>
        {/* A conversation's own title is its date, set by the page below. */}
        {!inConversation && (
          <>
            <h1>Conversation history</h1>
            <p>
              Every conversation you held here, newest first: when it ran, how long it lasted
              and whether it ended normally.
            </p>
          </>
        )}
      </header>

      {!api ? (
        <p className="history-note">
          History is kept only where a history server runs: locally, next to{" "}
          <code>npm run dev</code>, with <code>npm run server</code>.
        </p>
      ) : inConversation ? (
        <ConversationView
          api={api}
          conversationId={conversationId}
          navigate={navigate}
          timeZone={timeZone}
        />
      ) : (
        <HistoryList api={api} timeZone={timeZone} />
      )}
    </main>
  );
}
