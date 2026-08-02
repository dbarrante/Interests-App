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

function bulletBlock(url) {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: url, link: { url: url } } }] } };
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
    properties: { title: { title: [{ text: { content: p.title || "Untitled" } }] } },
    children: children
  };
}

module.exports = { buildPageBody, splitIntoRichText };
