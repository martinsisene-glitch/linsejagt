'use strict';

/**
 * Minimal XML -> plain-object parser, enough for Tradera's SOAP responses.
 *
 * Deliberately dependency-free: this project must build with a bare `node`, with
 * no `npm install` step, both in CI and on a machine behind a firewall that
 * blocks the registry. SOAP responses here are simple — no attributes we care
 * about, no mixed content — so a 60-line parser is entirely adequate and avoids
 * pulling a dependency tree in for one call site.
 *
 * Rules:
 *   - namespace prefixes are stripped (`soap:Body` -> `Body`)
 *   - repeated sibling tags collapse into an array
 *   - text-only elements become a coerced scalar (number / boolean / string / null)
 */

function parseXml(xml) {
  const clean = String(xml || '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;'));

  const root = {};
  const stack = [{ name: null, obj: root, text: '' }];
  const re = /<([^>]+)>|([^<]+)/g;
  let m;

  while ((m = re.exec(clean)) !== null) {
    // Text node
    if (m[2] != null) {
      stack[stack.length - 1].text += m[2];
      continue;
    }

    const tag = m[1].trim();

    if (tag.startsWith('/')) {
      if (stack.length < 2) continue; // stray close tag — ignore rather than throw
      const frame = stack.pop();
      const value = Object.keys(frame.obj).length ? frame.obj : coerce(decodeEntities(frame.text.trim()));
      addChild(stack[stack.length - 1].obj, frame.name, value);
    } else if (tag.endsWith('/')) {
      addChild(stack[stack.length - 1].obj, localName(tag.slice(0, -1)), null);
    } else {
      stack.push({ name: localName(tag), obj: {}, text: '' });
    }
  }

  return root;
}

function localName(tag) {
  const name = tag.split(/[\s/>]/)[0];
  const colon = name.lastIndexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function addChild(parent, name, value) {
  if (!(name in parent)) {
    parent[name] = value;
  } else if (Array.isArray(parent[name])) {
    parent[name].push(value);
  } else {
    parent[name] = [parent[name], value];
  }
}

function coerce(text) {
  if (text === '') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  // Only plain integers/decimals — never touch anything that could be an ID with
  // leading zeros, a date, or a version string.
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (String(n) === text) return n;
  }
  return text;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

module.exports = { parseXml };
