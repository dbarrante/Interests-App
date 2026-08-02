// core/notion.js — pure Notion API request-body builder. No I/O here (see
// createPage in this same file for the actual outbound call, added in Task 3) —
// kept separate so the block-shaping logic is testable without a network mock,
// same split core/safebrowse.js uses for its lookup-body builder vs its fetch call.
"use strict";

const RICH_TEXT_LIMIT = 2000;

// Notion's rich_text array holds multiple {type:"text", text:{content}} segments
// per block, each capped at 2000 chars — this hard-splits a long string into
// segments without ever cutting a segment mid-way through by anything other than
// length (no attempt at word-boundary splitting; a mid-word split is harmless in
// a Notion block, and word-boundary logic isn't worth the edge cases for v1).
function splitIntoRichText(text) {
  const s = String(text || "");
  const segments = [];
  for (let i = 0; i < s.length; i += RICH_TEXT_LIMIT) {
    segments.push({ type: "text", text: { content: s.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return segments.length ? segments : [{ type: "text", text: { content: "" } }];
}

function paragraphBlock(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: splitIntoRichText(text) } };
}

function heading3Block(text) {
  return { object: "block", type: "heading_3", heading_3: { rich_text: splitIntoRichText(text) } };
}

// Coerces like splitIntoRichText does: a sources array is caller-supplied data
// (it comes back from an AI provider), so a non-string entry — an object, a
// number — must not nest verbatim into the outbound Notion request body.
function bulletBlock(url) {
  const u = String(url || "");
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: u, link: { url: u } } }] } };
}

function sourceListBlocks(sources) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  return list.map(bulletBlock);
}

// payload = { title, url, article: {text, sources} | null, qa: [{question, answer, sources}] }
function buildPageBody(parentPageId, payload) {
  const p = payload || {};
  const children = [];
  if (p.url) children.push(paragraphBlock("Source: " + p.url));
  if (p.article && p.article.text) {
    const paragraphs = p.article.text.split(/\n\s*\n/).filter(x => x.trim());
    paragraphs.forEach(para => children.push(paragraphBlock(para)));
    children.push(...sourceListBlocks(p.article.sources));
  }
  (p.qa || []).forEach(entry => {
    children.push(heading3Block(entry.question || ""));
    const answerParagraphs = String(entry.answer || "").split(/\n\s*\n/).filter(x => x.trim());
    (answerParagraphs.length ? answerParagraphs : [""]).forEach(para => children.push(paragraphBlock(para)));
    children.push(...sourceListBlocks(entry.sources));
  });
  return {
    parent: { page_id: parentPageId },
    // The title is the one string that does NOT go through splitIntoRichText, so
    // it needs its own coercion + 2000-char cap — Notion rejects the whole
    // request if any rich_text segment is over the limit.
    properties: { title: { title: [{ text: { content: String(p.title || "Untitled").slice(0, RICH_TEXT_LIMIT) } }] } },
    children: children
  };
}

const NOTION_VERSION = "2022-06-28";

// Actual outbound call — separated from buildPageBody so the shaping logic
// (Task 2) stays testable without a network mock. Never throws (and never
// returns a rejected promise): any failure — a malformed payload that makes
// buildPageBody itself throw (e.g. a garbage entry in payload.qa), an HTTP
// error, or a network exception — resolves {ok:false, error}, matching this
// project's fail-soft convention for third-party calls (see
// core/safebrowse.js). buildPageBody is deliberately called INSIDE this try
// block, not before it, so a throw there is caught the same way as a fetch
// failure. The caller (core/server.js's /api/notion/export route) has its own
// try/catch as well and deliberately does NOT depend on this guarantee — belt
// and braces, matching every other async route in that file.
async function createPage(token, parentPageId, payload) {
  try {
    const body = buildPageBody(parentPageId, payload);
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "Notion-Version": NOTION_VERSION
      },
      body: JSON.stringify(body),
      // Fail closed on any redirect. The default ("follow") would leave it to the
      // JS runtime to decide whether the Authorization: Bearer <token> header
      // survives a cross-origin hop — verified stripped on recent Node, but not
      // verified on every Electron/Node build this app ships against. Notion's
      // API does not redirect, so "error" costs nothing and removes the question.
      redirect: "error"
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (json && json.message) || ("Notion API error " + res.status) };
    return { ok: true, pageUrl: json.url || "" };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = { buildPageBody, splitIntoRichText, createPage };
