import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@feltdb/feltkit/client";
import { FeltKitProvider } from "@feltdb/feltkit/react";
import { App } from "./App";
// Stack UI 0.9.0: tokens and component styles, before Ledger's own styles.
import "@stack-ui/tokens/tokens.css";
import "@stack-ui/core/core.css";
import "./styles.css";

// Same origin as the page: `feltkit dev` / `feltkit start` serve the app, its functions and AppPort together.
const client = createClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FeltKitProvider client={client}>
      <App />
    </FeltKitProvider>
  </StrictMode>,
);
