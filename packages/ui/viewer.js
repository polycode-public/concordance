// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The PDF viewer panel. PDF.js loads from the site's own /vendor/ on first use; when it
// does not load the panel says so, and the link to the original stays either way.

const $ = (id) => document.getElementById(id);
const panel = $("viewer");
const titleEl = $("viewer-title");
const pageEl = $("viewer-page");
const messageEl = $("viewer-message");
const original = $("viewer-original");
const canvas = $("viewer-canvas");
const prev = $("viewer-prev");
const next = $("viewer-next");

let pdfjs = null;
let current = { url: null, doc: null, page: 1 };
let renderTask = null;

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  const lib = await import("/vendor/pdf.min.mjs");
  lib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  pdfjs = lib;
  return lib;
}

function show() {
  panel.hidden = false;
  document.body.dataset.viewer = "open";
}

function message(text) {
  messageEl.textContent = text;
}

function linkOriginal(url, page) {
  original.href = `${url}#page=${page}`;
  original.hidden = false;
}

function pastTheEnd(page, pages) {
  current.page = page;
  pageEl.textContent = `p.${page} of ${pages}: past the end`;
  pageEl.classList.add("defect");
  prev.disabled = false;
  next.disabled = true;
  canvas.hidden = true;
  linkOriginal(current.url, pages);
  message(`The locator names page ${page}; the document has ${pages} pages.`);
}

async function renderPage(n) {
  const { doc, url } = current;
  const page = Math.max(1, n);
  current.page = page;
  pageEl.classList.remove("defect");
  canvas.hidden = false;
  pageEl.textContent = `p.${page} of ${doc.numPages}`;
  prev.disabled = page <= 1;
  next.disabled = page >= doc.numPages;
  linkOriginal(url, page);
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
  show();
  message(text);
}

/** Hides the panel; the document stays loaded for the next open. */
export function closeViewer() {
  panel.hidden = true;
  delete document.body.dataset.viewer;
}

/**
 * Opens a PDF at a page.
 * @param {{ url: string, page: number, title: string }} target
 */
export async function openPdf({ url, page, title }) {
  show();
  titleEl.textContent = title;
  linkOriginal(url, page);
  message("Loading the page.");
  let lib;
  try {
    lib = await loadPdfjs();
  } catch {
    canvas.hidden = true;
    message("The PDF viewer could not load. Open the original instead.");
    return;
  }
  try {
    if (current.url !== url) {
      await current.doc?.destroy();
      current = {
        url,
        doc: await lib.getDocument({ url, wasmUrl: "/vendor/wasm/" }).promise,
        page: 1,
      };
    }
    if (page > current.doc.numPages) {
      pastTheEnd(page, current.doc.numPages);
      return;
    }
    await renderPage(page);
    message("");
  } catch (err) {
    current = { url: null, doc: null, page: 1 };
    canvas.hidden = true;
    message(`The PDF could not be shown: ${err.message}. Open the original instead.`);
  }
}

prev.addEventListener("click", () => current.doc && renderPage(current.page - 1));
next.addEventListener("click", () => current.doc && renderPage(current.page + 1));
$("viewer-close").addEventListener("click", closeViewer);
