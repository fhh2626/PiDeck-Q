import React from "react";
import { createRoot } from "react-dom/client";
import { WebChatApp } from "@/web/WebChatApp";
import { TooltipProvider } from "@/components/ui-shadcn/tooltip";

/** Run the real Web composition root; Playwright controls HTTP/SSE arrival order. */
const root = document.getElementById("root");
if (root) createRoot(root).render(<TooltipProvider><WebChatApp /></TooltipProvider>);
