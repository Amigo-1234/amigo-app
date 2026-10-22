import type { LucideIcon } from "lucide-react";
import { ScreenHeader } from "../shell/ScreenHeader";
import { StateMessage } from "../ui/StateMessage";

/** Honest placeholder for routes that exist in the shell but are built in later phases. */
export function ComingSoonScreen({ title, icon: Icon, body }: { title: string; icon: LucideIcon; body: string }) {
  return (
    <>
      <ScreenHeader title={title} />
      <StateMessage icon={<Icon size={24} />} title={`${title} is on the way`} body={body} />
    </>
  );
}
