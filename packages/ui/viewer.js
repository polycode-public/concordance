// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The PDF viewer panel. PDF.js loads from cdnjs on first use; when the CDN is
// unreachable the panel says so and links to the original.

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.4.299";

const $ = (id) => document.getElementById(id);
const panel = $("viewer");
const titleEl = $("viewer-title");
const pageEl = $("viewer-page");
const messageEl = $("viewer-message");
const canvas = $("viewer-canvas");
const prev = $("viewer-prev");
const next = $("viewer-next");

let pdfjs = null;
let current = { url: null, doc: null, page: 1 };
let renderTask = null;

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  const lib = await import(`${PDFJS}/pdf.min.mjs`);
  lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
  pdfjs = lib;
  return lib;
}

function message(text, link) {
  messageEl.replaceChildren(text);
  if (link) {
    messageEl.append(
      " ",
      Object.assign(document.createElement("a"), {
        href: link,
        target: "_blank",
        rel: "noopener",
        textContent: "Open the original",
      }),
    );
  }
}

async function renderPage(n) {
  const { doc } = current;
  const page = Math.min(Math.max(1, n), doc.numPages);
  current.page = page;
  pageEl.textContent = `p. ${page} of ${doc.numPages}`;
  prev.disabled = page <= 1;
  next.disabled = page >= doc.numPages;
  const pdfPage = await doc.getPage(page);
  const width = canvas.parentElement.clientWidth || 600;
  const base = pdfPage.getViewport({ scale: 1 });
  const viewport = pdfPage.getViewport({ scale: width / base.width });
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  renderTask?.cancel();
  renderTask = pdfPage.render({
    canvas,
    viewport,
    transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
  });
  try {
    await renderTask.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") throw err;
  }
}

/** Shows a message in the panel, for example an error from the server. */
export function showViewerMessage(text) {
  panel.hidden = false;
  message(text);
}

/**
 * Opens a PDF at a page.
 * @param {{ url: string, page: number, title: string }} target
 */
export async function openPdf({ url, page, title }) {
  panel.hidden = false;
  titleEl.textContent = title;
  const fallback = `${url}#page=${page}`;
  message("Loading…");
  let lib;
  try {
    lib = await loadPdfjs();
  } catch {
    canvas.hidden = true;
    message("The PDF viewer could not load from cdnjs.", fallback);
    return;
  }
  try {
    if (current.url !== url) {
      await current.doc?.destroy();
      current = { url, doc: await lib.getDocument({ url }).promise, page: 1 };
    }
    canvas.hidden = false;
    await renderPage(page);
    message("");
  } catch (err) {
    current = { url: null, doc: null, page: 1 };
    canvas.hidden = true;
    message(`The PDF could not be shown: ${err.message}.`, fallback);
  }
}

prev.addEventListener("click", () => current.doc && renderPage(current.page - 1));
next.addEventListener("click", () => current.doc && renderPage(current.page + 1));
$("viewer-close").addEventListener("click", () => (panel.hidden = true));
