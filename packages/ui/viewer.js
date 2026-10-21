// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The PDF viewer panel. PDF.js loads from the site's own /vendor/ on first use; when it
// does not load the panel says so, and the link to the original stays either way.

import { firstSentence, itemBox, matchSpan } from "./spanMatch.mjs";

const $ = (id) => document.getElementById(id);
const panel = $("viewer");
const titleEl = $("viewer-title");
const pageEl = $("viewer-page");
const messageEl = $("viewer-message");
const original = $("viewer-original");
const canvas = $("viewer-canvas");
const marks = $("viewer-marks");
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
  marks.replaceChildren();
  linkOriginal(current.url, pages);
  message(`The locator names page ${page}; the document has ${pages} pages.`);
}

/** Marks the first sentence of the cited block on the page and scrolls the mark into view. */
async function markSentence(pdfPage, viewport, sentence) {
  marks.replaceChildren();
  if (!sentence) return;
  const { items } = await pdfPage.getTextContent();
  const hit = matchSpan(items, sentence);
  if (!hit.length) return;
  const boxes = hit.map((i) => itemBox(viewport.transform, items[i], viewport.scale));
  marks.replaceChildren(
    ...boxes.map((box) => {
      const mark = document.createElement("div");
      mark.className = "viewer-mark";
      mark.style.left = `${box.left}px`;
      mark.style.top = `${box.top}px`;
      mark.style.width = `${box.width}px`;
      mark.style.height = `${box.height}px`;
      return mark;
    }),
  );
  marks.firstChild.scrollIntoView({ block: "center", behavior: "instant" });
}

async function renderPage(n, sentence = "") {
  const { doc, url } = current;
  const page = Math.max(1, n);
  current.page = page;
  pageEl.classList.remove("defect");
  marks.replaceChildren();
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
    return;
  }
  await markSentence(pdfPage, viewport, sentence);
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
 * @param {{ url: string, page: number, title: string, text?: string }} target `text` is the cited
 *   block's text; its first sentence is marked on the page when the page's text holds it.
 */
export async function openPdf({ url, page, title, text }) {
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
    await renderPage(page, firstSentence(text));
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
