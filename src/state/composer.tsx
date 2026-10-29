import { createContext, useContext, useState, type ReactNode } from "react";

/** Lets the sidebar, bottom nav and keyboard shortcut open the same composer sheet. */
const ComposerContext = createContext<{ open: boolean; setOpen: (o: boolean) => void }>({ open: false, setOpen: () => {} });

export function ComposerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <ComposerContext.Provider value={{ open, setOpen }}>{children}</ComposerContext.Provider>;
}

export const useComposer = () => useContext(ComposerContext);
