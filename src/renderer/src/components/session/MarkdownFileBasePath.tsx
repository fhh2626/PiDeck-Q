import { createContext } from "react";

/** A Markdown resource belongs to its session or document, regardless of UI focus. */
export const MarkdownFileBasePathContext = createContext<string | undefined>(undefined);
