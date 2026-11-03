import { MESSAGE_EDIT_WINDOW_MS } from "../types";

/**
 * Whether a reaction/edit row counts, as its receiver sees it. The server checks the
 * label (relates_kind) it can see; only the receiver can see the encrypted type, so:
 *   - a label that doesn't match the encrypted type is ignored (a sender labelling an
 *     edit "reaction" to get round the 15-minute rule gets nothing);
 *   - an edit counts only from the message's own sender, within 15 minutes of it by the
 *     server's clock (rows from before labels existed are held to the same rule);
 *   - reactions count at any age.
 */
export function annotationKind(
  row: { sender_id: string; created_at: string; relates_kind?: "reaction" | "edit" | null },
  msgtype: string,
  target: { sender_id: string; created_at: string } | undefined,
): "reaction" | "edit" | null {
  const kind = msgtype === "amigo.reaction" ? "reaction" : msgtype === "amigo.edit" ? "edit" : null;
  if (!kind || (row.relates_kind && row.relates_kind !== kind)) return null;
  if (kind === "reaction") return kind;
  if (!target || target.sender_id !== row.sender_id) return null;
  return new Date(row.created_at).getTime() - new Date(target.created_at).getTime() <= MESSAGE_EDIT_WINDOW_MS ? kind : null;
}
