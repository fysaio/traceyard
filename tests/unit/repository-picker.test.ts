import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RepositoryPicker, type RepositoryChoices } from "../../src/components/repository-picker";

const data: RepositoryChoices = {
  configured: true,
  installationCount: 0,
  manageUrl: null,
  installUrl: "https://github.com/apps/traceyard-test/installations/new",
  items: [],
};
function render(overrides: Partial<Parameters<typeof RepositoryPicker>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(RepositoryPicker, {
      data,
      loading: false,
      refreshing: false,
      error: null,
      onConnect: () => {},
      onRefresh: () => {},
      ...overrides,
    }),
  );
}
describe("repository connection states", () => {
  it("offers installation only when no installation has been received", () => {
    const html = render();
    expect(html).toContain("Install on GitHub");
    expect(html).toContain(data.installUrl);
    expect(html).not.toContain("Manage access");
  });
  it("opens existing repository access settings without sending installed users through setup again", () => {
    const html = render({
      data: {
        ...data,
        installationCount: 1,
        manageUrl: "https://github.com/settings/installations/7",
        items: [{ id: 99, installationId: 7, name: "fysaio/somni" }],
      },
    });
    expect(html).toContain("fysaio/somni");
    expect(html).toContain("https://github.com/settings/installations/7");
    expect(html).not.toContain(data.installUrl);
    expect(html).not.toContain("Install on GitHub");
  });
  it("distinguishes an installed app with no shared repos from a missing installation", () => {
    const html = render({ data: { ...data, installationCount: 1 } });
    expect(html).toContain("No repositories shared yet");
    expect(html).not.toContain("Install on GitHub");
  });
  it("retains installation state when receiving a response from an older server", () => {
    expect(
      render({ data: { ...data, items: [{ id: 99, installationId: 7, name: "fysaio/somni" }] } }),
    ).not.toContain("Install on GitHub");
  });
  it("shows only the selected repository as connecting", () => {
    const html = render({
      connectingId: 99,
      data: {
        ...data,
        items: [
          { id: 99, installationId: 7, name: "fysaio/somni" },
          { id: 100, installationId: 7, name: "fysaio/traceyard" },
        ],
      },
    });
    expect(html.match(/Connecting…/g)).toHaveLength(1);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain('aria-busy="true"');
  });
  it("treats a failed lookup as retryable instead of saying the server is unconfigured", () => {
    const html = render({ data: undefined, error: Error("GitHub is temporarily unavailable.") });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    expect(html).not.toContain("needs server setup");
    expect(html).not.toContain("Install on GitHub");
  });
  it("keeps loading accessible without flashing an install action", () => {
    const html = render({ data: undefined, loading: true, refreshing: true });
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Install on GitHub");
  });
});
