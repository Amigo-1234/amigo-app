import { useState } from "react";
import { useParams } from "react-router";
import { MessagesSquare, SquarePen } from "lucide-react";
import { ConversationList } from "../features/messages/ConversationList";
import { ConversationPane } from "../features/messages/ConversationPane";
import { DeviceGate } from "../features/messages/DeviceGate";
import { NewMessageSheet } from "../features/messages/NewMessageSheet";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useSecurity } from "../state/security";
import { Button, IconButton } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import { StateMessage } from "../ui/StateMessage";
import "../features/messages/Messages.css";

/**
 * /messages and /messages/:conversationId.
 * Wide screens: conversation list and the open conversation side by side.
 * Phones and narrow tablets: one at a time.
 */
export default function MessagesScreen() {
  const { conversationId } = useParams();
  const [composing, setComposing] = useState(false);
  const { setup } = useSecurity();

  // A device that isn't approved yet can't read or send: ask it to confirm first.
  if (setup && !setup.deviceVerified) {
    return (
      <>
        <ScreenHeader title="Messages" />
        <DeviceGate />
      </>
    );
  }

  return (
    <div className={`messages${conversationId ? " messages--open" : ""}`}>
      <section className="messages__list" aria-label="Conversations">
        <ScreenHeader
          title="Messages"
          actions={
            <IconButton label="New message" onClick={() => setComposing(true)}>
              <SquarePen size={21} />
            </IconButton>
          }
        />
        <ConversationList onNew={() => setComposing(true)} />
      </section>

      <section className="messages__pane" aria-label="Conversation">
        {conversationId ? (
          <ConversationPane key={conversationId} conversationId={conversationId} />
        ) : (
          <div className="messages__placeholder">
            <StateMessage
              icon={<MessagesSquare size={24} />}
              title="Your messages"
              body="Pick a conversation, or start a new one."
              action={<Button onClick={() => setComposing(true)} icon={<SquarePen size={18} aria-hidden="true" />}>New message</Button>}
            />
          </div>
        )}
      </section>

      <Sheet open={composing} onClose={() => setComposing(false)} label="New message">
        <NewMessageSheet onClose={() => setComposing(false)} />
      </Sheet>
    </div>
  );
}
