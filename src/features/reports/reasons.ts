import type { MessageReportReason } from "../../data";

/** The reasons people can report something for (messages, Moments). */
export const REPORT_REASONS: { id: MessageReportReason; label: string }[] = [
  { id: "spam", label: "Spam or scam" },
  { id: "harassment", label: "Harassment or bullying" },
  { id: "inappropriate", label: "Inappropriate content" },
  { id: "other", label: "Something else" },
];

export const reportReasonLabel = (id: MessageReportReason) => REPORT_REASONS.find((r) => r.id === id)?.label ?? id;
