import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { readPreference } from "./lib/workspace";
import "./styles/font.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/polish.css";
import "./styles/connected.css";
import "./styles/product-restoration.css";
import "./styles/project-experience.css";
import "./styles/repository-connection.css";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import "@fortawesome/fontawesome-free/css/brands.min.css";

// Restore appearance before the first render, including system changes outside Settings.
const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyAppearance = () => {
  const theme = readPreference("theme", "system");
  document.documentElement.dataset.theme =
    theme === "system" ? (scheme.matches ? "dark" : "light") : theme;
};
applyAppearance();
scheme.addEventListener("change", applyAppearance);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

const root = document.getElementById("root");
if (root === null) throw new Error("Root element is missing.");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
