import { useEffect, useRef } from "react";
import type { AuthSession } from "../lib/api";
import landingBody from "./landing-template-body.html?raw";
import landingCss from "./landing-template.css?raw";
import landingScript from "./landing-template.js?raw";

export function Welcome({ session }: { session: AuthSession }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    root.innerHTML = landingBody;

    const style = document.createElement("style");
    style.dataset.traceyardLanding = "true";
    style.textContent = landingCss;
    document.head.appendChild(style);

    const hostedLinks = root.querySelectorAll<HTMLAnchorElement>(
      'a[href="https://traceyard.pilotsaviour229.workers.dev/"]',
    );
    hostedLinks.forEach((link) => {
      if (session.githubSignInAvailable) {
        link.href = "/api/auth/github/start";
        link.removeAttribute("target");
        link.removeAttribute("rel");
        const label = link.querySelector("span");
        if (label) label.textContent = "Start with GitHub";
      }
    });

    const script = document.createElement("script");
    script.dataset.traceyardLanding = "true";
    script.textContent = landingScript;
    document.body.appendChild(script);

    return () => {
      script.remove();
      style.remove();
      root.replaceChildren();
    };
  }, [session.githubSignInAvailable]);

  return <div ref={rootRef} className="traceyard-html-landing" />;
}
