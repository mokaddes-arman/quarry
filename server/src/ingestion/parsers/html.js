'use strict';

const cheerio = require('cheerio');
const { block } = require('./util');

/**
 * HTML parser for uploaded files.
 *
 * Real-world HTML is rarely a neat sequence of <p> tags: most pages wrap their
 * text in <div>/<section>/<article> containers (and often <span>s inside those).
 * The parser therefore walks the whole body and flushes text at every
 * block-level boundary, instead of only looking at a fixed list of semantic
 * tags. That way container-based markup is indexed just as reliably as <p>.
 */

const DROP = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'template',
  'iframe',
  'object',
  'embed',
  'canvas',
  'head',
]);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const LIST_CONTAINERS = new Set(['ul', 'ol', 'dl']);
const LIST_ITEMS = new Set(['li', 'dt', 'dd']);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'center',
  'details',
  'div',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'li',
  'dt',
  'dd',
  'main',
  'nav',
  'p',
  'section',
  'summary',
  'td',
  'th',
  'tr',
  'tfoot',
  'thead',
]);

const DROP_SELECTOR = [...DROP].join(', ');

/**
 * Decode the raw file. Most HTML is UTF-8, but saved pages and exports from
 * Windows tools often declare another charset (or carry a BOM). Decoding the
 * bytes correctly is the difference between readable text and mojibake.
 */
function decodeHtml(input) {
  if (!Buffer.isBuffer(input)) return String(input ?? '');
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return input.subarray(3).toString('utf8');
  }
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(input.subarray(2));
  }
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(input.subarray(2));
  }

  const head = input.subarray(0, 2048).toString('latin1');
  const declared =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ||
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1] ||
    'utf-8';
  const charset = declared.toLowerCase();
  if (charset === 'utf-8' || charset === 'utf8') return input.toString('utf8');
  try {
    return new TextDecoder(charset).decode(input);
  } catch {
    return input.toString('utf8');
  }
}

/** Collapse source whitespace while keeping explicit line breaks (<br>). */
function normalise(text) {
  return String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function tableToMarkdown($, el) {
  const rows = [];
  $(el)
    .find('tr')
    .each((_, tr) => {
      const cells = [];
      $(tr)
        .find('th,td')
        .each((__, cell) => {
          cells.push(
            $(cell)
              .text()
              .replace(/\s+/g, ' ')
              .replace(/\|/g, '\\|')
              .trim(),
          );
        });
      if (cells.length) rows.push(cells);
    });
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const out = [pad(rows[0]).join(' | ')];
  out.push(Array(width).fill('---').join(' | '));
  for (const r of rows.slice(1)) out.push(pad(r).join(' | '));
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Embedded application data                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Many exported pages (mind maps, dashboards, generated reports) contain no
 * readable text at all: the real content lives in a JS/JSON payload that is
 * rendered client-side. Dropping <script> is right for executable code, but it
 * must not throw away structured data. We parse only valid JSON - never eval -
 * and turn the values into normal blocks so the whole tree is searchable.
 */

const JSON_SCRIPT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/vnd.api+json',
  'text/json',
]);
const MAX_EMBEDDED_JSON_CHARS = 2_000_000;
const TREE_KEYS = new Set(['name', 'title', 'label', 'heading', 'children', 'description']);

/** Read one balanced JSON object/array starting at (or after) `start`. */
function readJsonValue(source, start) {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const first = source[i];
  if (first !== '{' && first !== '[') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let end = i; end < source.length; end += 1) {
    const ch = source[end];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const slice = source.slice(i, end + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Extract `const DATA = {...}`, `window.DATA = [...]`, ... from inline JS. */
function extractAssignedJson(source) {
  const patterns = [
    /(?:^|[^\w$.])(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*/g,
    /(?:window|globalThis|self)\.[A-Za-z_$][\w$]*\s*=\s*/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source))) {
      const value = readJsonValue(source, match.index + match[0].length);
      if (value !== null && typeof value === 'object') return value;
    }
  }
  return null;
}

function scriptDataValues($) {
  const values = [];
  const seen = new Set();
  $('script').each((_, el) => {
    const raw = $(el).text();
    if (!raw || raw.length > MAX_EMBEDDED_JSON_CHARS) return;
    const type = String($(el).attr('type') || '').trim().toLowerCase();
    let value = null;

    if (JSON_SCRIPT_TYPES.has(type)) {
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          value = JSON.parse(trimmed);
        } catch {
          value = null;
        }
      }
    } else if (!type || type === 'text/javascript' || type === 'module') {
      value = extractAssignedJson(raw);
    }

    if (value === null || typeof value !== 'object') return;
    // The same payload is sometimes emitted for both a config <script> and a
    // JSON-LD block; index it once.
    let key;
    try {
      key = JSON.stringify(value);
    } catch {
      key = '';
    }
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    values.push(value);
  });
  return values;
}

function scalarText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return normalise(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function treeLabel(node) {
  for (const key of ['name', 'title', 'label', 'heading']) {
    const text = scalarText(node[key]);
    if (text) return text;
  }
  return '';
}

function flattenData(value, path, lines, depth = 0) {
  // Depth guards against pathologically nested payloads (and runaway
  // recursion); ordinary mind maps, configs and exports are far shallower.
  // There is deliberately no line/item cap: dropping values would make the
  // indexed document incomplete.
  if (depth > 64) return;
  if (value === null || typeof value !== 'object') {
    const text = scalarText(value);
    if (text) lines.push(`${path || 'value'}: ${text}`);
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) return;
    const scalarOnly = value.every((v) => v === null || typeof v !== 'object');
    if (scalarOnly) {
      lines.push(`${path || 'items'}: ${value.map((v) => scalarText(v)).filter(Boolean).join(', ')}`);
      return;
    }
    value.forEach((v, i) => flattenData(v, `${path}[${i}]`, lines, depth + 1));
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    flattenData(val, path ? `${path}.${key}` : key, lines, depth + 1);
  }
}

/**
 * Turn a mind-map style tree into headings and list items. The parent path is
 * kept as the section so a leaf such as "Lead name" is still retrievable in
 * context ("Phase 1 - Lead Capture > Core Data > Lead name").
 */
function treeToBlocks(node, out, depth = 0, parentPath = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const label = treeLabel(node);
  const path = label ? [...parentPath, label] : parentPath;
  const section = (path.length > 1 ? path.slice(0, -1) : path).join(' > ') || undefined;

  if (label) {
    if (depth === 0) {
      out.push(block('heading', label, { level: 1, location: { section: label } }));
    } else if (depth <= 2) {
      out.push(block('heading', label, { level: Math.min(6, depth + 1), location: { section } }));
    } else {
      out.push(block('list', label, { location: { section } }));
    }
  }

  for (const key of ['description', 'subtitle', 'summary', 'note', 'text', 'value', 'detail']) {
    const text = scalarText(node[key]);
    if (text) out.push(block('paragraph', text, { location: { section: path.join(' > ') || undefined } }));
  }

  // Any other scalar properties are still content (ids, prices, dates, ...).
  const extra = [];
  for (const [key, val] of Object.entries(node)) {
    if (TREE_KEYS.has(key) || ['subtitle', 'summary', 'note', 'text', 'value', 'detail'].includes(key)) continue;
    if (val === null || typeof val !== 'object') {
      const text = scalarText(val);
      if (text) extra.push(`${key}: ${text}`);
    } else {
      flattenData(val, key, extra);
    }
  }
  if (extra.length) {
    out.push(block('paragraph', extra.join('\n'), { location: { section: path.join(' > ') || undefined } }));
  }

  for (const child of Array.isArray(node.children) ? node.children : []) {
    treeToBlocks(child, out, depth + 1, path);
  }
}

function blocksFromData(value, nameHint) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.children) && treeLabel(value)) {
    const out = [];
    treeToBlocks(value, out);
    if (out.length) return out;
  }

  // Generic JSON: readable key paths, grouped so one huge payload does not
  // become a single un-chunkable paragraph.
  const lines = [];
  flattenData(value, '', lines);
  if (!lines.length) return [];
  const out = [];
  const GROUP = 40;
  for (let i = 0; i < lines.length; i += GROUP) {
    const slice = lines.slice(i, i + GROUP);
    out.push(
      block('code', slice.join('\n'), {
        location: { label: nameHint ? `${nameHint} (fields ${i + 1}-${i + slice.length})` : `fields ${i + 1}-${i + slice.length}` },
      }),
    );
  }
  return out;
}

function parseHtml(buffer) {
  const html = decodeHtml(buffer);
  const $ = cheerio.load(html);
  // Read the title before dropping <head> (wholesale, since it only holds
  // metadata/scripts and would otherwise leak into the body fallback).
  const title = ($('title').first().text() || '').trim();
  // Extract structured payloads before <script> is dropped.
  const embedded = scriptDataValues($);
  $(DROP_SELECTOR).remove();

  const blocks = [];
  for (const value of embedded) {
    blocks.push(...blocksFromData(value, title || 'embedded data'));
  }
  let section = title || null;
  let textBuffer = '';
  let listDepth = 0;

  const flush = (kind) => {
    const text = normalise(textBuffer);
    textBuffer = '';
    if (!text) return;
    const resolved = kind || (listDepth > 0 ? 'list' : 'paragraph');
    blocks.push(block(resolved, text, { location: section ? { section } : {} }));
  };

  const walk = (node) => {
    if (node.type === 'text') {
      // Collapse source formatting whitespace; <br> adds a real line break.
      textBuffer += node.data.replace(/\s+/g, ' ');
      return;
    }
    if (node.type !== 'tag') return;

    const tag = (node.name || '').toLowerCase();
    if (DROP.has(tag)) return;

    if (HEADINGS.has(tag)) {
      flush();
      const text = normalise($(node).text());
      if (text) {
        const level = Number(tag[1]);
        section = text;
        blocks.push(block('heading', text, { level, location: { section } }));
      }
      return;
    }

    if (tag === 'table') {
      flush();
      const md = tableToMarkdown($, node);
      if (md) blocks.push(block('table', md, { location: section ? { section } : {} }));
      return;
    }

    if (tag === 'pre') {
      flush();
      const text = $(node).text().replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
      if (text.trim()) blocks.push(block('code', text, { location: section ? { section } : {} }));
      return;
    }

    if (tag === 'br') {
      textBuffer += '\n';
      return;
    }

    if (tag === 'img') {
      const alt = normalise($(node).attr('alt'));
      if (alt) {
        textBuffer += `${textBuffer && !textBuffer.endsWith(' ') ? ' ' : ''}${alt}`;
      }
      return;
    }

    const isList = LIST_CONTAINERS.has(tag) || LIST_ITEMS.has(tag);
    const isBlock = isList || BLOCK_TAGS.has(tag);

    if (isBlock) flush();
    if (LIST_CONTAINERS.has(tag)) listDepth += 1;
    for (const child of node.children || []) walk(child);
    if (LIST_CONTAINERS.has(tag)) listDepth -= 1;
    if (isBlock) flush();
  };

  const root = $('body').get(0) || $.root().get(0);
  walk(root);
  flush();

  return {
    parser: 'html',
    blocks,
    metadata: { title: title || undefined, characters: html.length },
    warnings: [],
    ocrLikely: false,
  };
}

module.exports = { parseHtml };
