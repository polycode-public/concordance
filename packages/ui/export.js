// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The Export control in the header: posts the current session and thread, then shows the key
// the document was written under and a link that opens it in a new tab.

/**
 * @param {{ exportUrl?: string }} config
 * @param {{ token: () => string | null }} page
 * @returns {{ ready: (sessionId: string, thread: string) => void, reset: () => void }}
 */
export function mountExport(config, { token }) {
  const url = config.exportUrl;
  if (typeof url !== "string") throw new Error("config.json has no exportUrl");
  const button = document.getElementById("export");
  const status = document.getElementById("export-status");
  let target = null;

  const show = (...nodes) => status.replaceChildren(...nodes);
  const fail = (message) => {
    status.dataset.level = "error";
    show(message);
  };

  button.hidden = false;
  button.disabled = true;
  button.addEventListener("click", async () => {
    if (!target) return;
    button.disabled = true;
    delete status.dataset.level;
    show("Exporting");
    try {
      const bearer = token();
      const res = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(target),
      });
      if (!res.ok) {
        const { message } = await res.json().catch(() => ({}));
        throw new Error(message ?? `the export route answered ${res.status}`);
      }
      const { key, url: href } = await res.json();
      const link = Object.assign(document.createElement("a"), {
        href,
        target: "_blank",
        rel: "noopener",
        textContent: "Open",
      });
      show(`Written to ${key} `, link);
    } catch (err) {
      console.error(err);
      fail(`The document was not written (${err.message}); try again.`);
    } finally {
      button.disabled = !target;
    }
  });

  return {
    ready(sessionId, thread) {
      target = { sessionId, thread };
      button.disabled = false;
    },
    reset() {
      target = null;
      button.disabled = true;
      delete status.dataset.level;
      show();
    },
  };
}
