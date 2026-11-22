// A small PDF writer for the vehicle data export: A4 pages of wrapped text, headings, key/value lines and JPEG
// pictures, with a footer and page numbers. No libraries and no network: it builds the file in memory.
// Text is set in the standard Helvetica / Courier fonts that every PDF reader has, so nothing is embedded.
// Characters outside the Western European set those fonts cover are replaced with "?".
(function (root) {
  'use strict';

  var PAGE_W = 595.28;
  var PAGE_H = 841.89;
  var MARGIN = 42;
  var FOOTER_H = 30;

  // Character widths (in 1/1000 of the font size) for ASCII 32..126, from the Adobe font metrics.
  var HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  var HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

  var FONTS = {
    F1: { name: 'Helvetica', widths: HELV },
    F2: { name: 'Helvetica-Bold', widths: HELV_BOLD },
    F3: { name: 'Courier-Bold', widths: null }, // every character is 600 wide
  };

  // Unicode characters outside Latin-1 that the PDF "WinAnsi" encoding has, and the byte for each.
  var WIN_ANSI = { 0x20ac: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99 };

  /** The text as a string of single-byte characters in WinAnsi encoding; anything else becomes "?" (emoji are dropped). */
  function encode(text) {
    var out = '';
    var s = String(text === null || text === undefined ? '' : text);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 0x2192) { out += '->'; continue; }
      if (c >= 0xd800 && c <= 0xdbff) { i++; continue; } // an emoji or another character from outside the basic set: left out
      if (c === 0xfe0f || c === 0x200d) continue;
      if (c === 9) { out += ' '; continue; }
      if (c === 10) { out += '\n'; continue; }
      if (c >= 32 && c < 127) out += String.fromCharCode(c);
      else if (c >= 0xa0 && c <= 0xff) out += String.fromCharCode(c);
      else if (WIN_ANSI[c]) out += String.fromCharCode(WIN_ANSI[c]);
      else if (c >= 0x2000 && c <= 0x200a) out += ' ';
      else if (c < 32) continue;
      else out += '?';
    }
    return out;
  }

  function charWidth(code, font) {
    if (font === 'F3') return 600;
    var w = FONTS[font].widths;
    if (code >= 32 && code <= 126) return w[code - 32];
    return 556;
  }

  /** Width in points of already-encoded text. */
  function textWidth(encoded, font, size) {
    var w = 0;
    for (var i = 0; i < encoded.length; i++) w += charWidth(encoded.charCodeAt(i), font);
    return (w * size) / 1000;
  }

  function escapeText(encoded) {
    var out = '';
    for (var i = 0; i < encoded.length; i++) {
      var ch = encoded.charAt(i);
      var c = encoded.charCodeAt(i);
      if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
      else if (c < 32 || c > 126) out += '\\' + ('00' + c.toString(8)).slice(-3);
      else out += ch;
    }
    return out;
  }

  /** Read a JPEG's size and colour type without decoding it. Returns null if it is not a usable JPEG. */
  function jpegInfo(bytes) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    var i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      var marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      var len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        var height = (bytes[i + 5] << 8) | bytes[i + 6];
        var width = (bytes[i + 7] << 8) | bytes[i + 8];
        var comps = bytes[i + 9];
        if (!width || !height || (comps !== 1 && comps !== 3 && comps !== 4)) return null;
        return { width: width, height: height, components: comps };
      }
      i += 2 + len;
    }
    return null;
  }

  function create(opts) {
    opts = opts || {};
    var footerText = opts.footer || '';
    var pages = [];
    var images = []; // { bytes, info }
    var page = null;
    var y = 0; // distance down from the top of the page, in points

    function newPage() {
      page = { ops: [] };
      pages.push(page);
      y = MARGIN;
    }
    newPage();

    var bottom = PAGE_H - MARGIN - FOOTER_H;
    function ensure(height) {
      if (y + height > bottom && y > MARGIN + 1) newPage();
    }

    function color(c) {
      c = c || [0, 0, 0];
      return c[0] + ' ' + c[1] + ' ' + c[2] + ' rg\n';
    }

    function put(encoded, font, size, x, baseline, c) {
      page.ops.push(color(c) + 'BT /' + font + ' ' + size + ' Tf ' + x.toFixed(2) + ' ' + (PAGE_H - baseline).toFixed(2) + ' Td (' + escapeText(encoded) + ') Tj ET\n');
    }

    /** Break encoded text into lines that fit `width`. A word longer than a line (such as a long link) is split. */
    function wrap(encoded, font, size, width) {
      var lines = [];
      encoded.split('\n').forEach(function (para) {
        var words = para.split(' ');
        var line = '';
        words.forEach(function (word) {
          if (word === '' && line === '') return;
          var tryLine = line === '' ? word : line + ' ' + word;
          if (textWidth(tryLine, font, size) <= width) { line = tryLine; return; }
          if (line !== '') { lines.push(line); line = ''; }
          while (textWidth(word, font, size) > width) {
            var cut = word.length - 1;
            while (cut > 1 && textWidth(word.slice(0, cut), font, size) > width) cut--;
            lines.push(word.slice(0, cut));
            word = word.slice(cut);
          }
          line = word;
        });
        lines.push(line);
      });
      return lines;
    }

    var api = {
      /** Wrapped text. opts: size, bold, mono, color, indent, after (space after), width. */
      text: function (text, o) {
        o = o || {};
        var size = o.size || 10;
        var font = o.mono ? 'F3' : o.bold ? 'F2' : 'F1';
        var x = MARGIN + (o.indent || 0);
        var width = (o.width || PAGE_W - 2 * MARGIN - (o.indent || 0));
        var lh = size * 1.32;
        var lines = wrap(encode(text), font, size, width);
        lines.forEach(function (ln) {
          ensure(lh);
          put(ln, font, size, x, y + size, o.color);
          y += lh;
        });
        y += o.after === undefined ? 3 : o.after;
        return api;
      },
      heading: function (text, level) {
        var size = level === 1 ? 17 : level === 2 ? 13 : 11;
        ensure(level === 1 ? 100 : size * 1.32 + 40); // never leave a heading alone at the bottom of a page
        y += level === 1 ? 10 : 6;
        api.text(text, { size: size, bold: true, color: level === 1 ? [0.06, 0.24, 0.37] : [0.1, 0.1, 0.1], after: level === 1 ? 2 : 2 });
        if (level === 1) api.rule();
        return api;
      },
      rule: function () {
        ensure(8);
        page.ops.push('0.8 0.84 0.88 RG 0.7 w ' + MARGIN + ' ' + (PAGE_H - y - 2).toFixed(2) + ' m ' + (PAGE_W - MARGIN) + ' ' + (PAGE_H - y - 2).toFixed(2) + ' l S\n');
        y += 7;
        return api;
      },
      /** "Label   value" on one line (the value wraps beside the label). */
      kv: function (label, value, o) {
        o = o || {};
        var labelW = o.labelWidth || 120;
        var size = o.size || 10;
        var indent = o.indent || 0;
        var lh = size * 1.32;
        var lines = wrap(encode(value), o.mono ? 'F3' : 'F1', size, PAGE_W - 2 * MARGIN - indent - labelW);
        ensure(lh);
        put(encode(label), 'F2', size, MARGIN + indent, y + size, [0.3, 0.34, 0.38]);
        lines.forEach(function (ln, i) {
          if (i > 0) ensure(lh);
          put(ln, o.mono ? 'F3' : 'F1', size, MARGIN + indent + labelW, y + size);
          y += lh;
        });
        y += 1.5;
        return api;
      },
      spacer: function (h) { y += h; return api; },
      /** Is the next thing drawn at the very top of a page? */
      atTop: function () { return y <= MARGIN + 1; },
      /**
       * A heading band for one entry: a soft tint across the page, a darker stripe at its left edge, the title in bold and a
       * small label in capitals (the type) at the right. o: { text, label, tint, accent, size }. The label is words, so the
       * band still reads clearly on a black and white printout.
       */
      banner: function (o) {
        var size = o.size || 11.5;
        var labelSize = 8;
        var label = encode(String(o.label || '').toUpperCase());
        var labelW = label ? textWidth(label, 'F2', labelSize) : 0;
        var pad = 8;
        var lines = wrap(encode(o.text), 'F2', size, PAGE_W - 2 * MARGIN - pad - 12 - labelW - pad);
        var lh = size * 1.32;
        var h = lines.length * lh + 9;
        ensure(h + 4);
        var top = PAGE_H - y - h;
        page.ops.push(color(o.tint || [0.93, 0.94, 0.95]) + MARGIN + ' ' + top.toFixed(2) + ' ' + (PAGE_W - 2 * MARGIN) + ' ' + h.toFixed(2) + ' re f\n');
        page.ops.push(color(o.accent || [0.3, 0.3, 0.3]) + MARGIN + ' ' + top.toFixed(2) + ' 3.5 ' + h.toFixed(2) + ' re f\n');
        lines.forEach(function (ln, i) { put(ln, 'F2', size, MARGIN + pad + 3.5, y + 4.5 + size + i * lh - 1.5, [0.08, 0.08, 0.08]); });
        if (label) put(label, 'F2', labelSize, PAGE_W - MARGIN - pad - labelW, y + 4.5 + size - 1.5, o.accent || [0.3, 0.3, 0.3]);
        y += h + 4;
        return api;
      },
      /**
       * Draw something that should stay on one page. If it runs over onto the next page and it did not start at the top of a
       * page, it is drawn again on a fresh page instead (an entry longer than a whole page simply continues).
       */
      keepTogether: function (draw) {
        var startPage = pages.length - 1;
        var startOps = page.ops.length;
        var startY = y;
        var startImages = images.length;
        draw();
        if (pages.length - 1 > startPage && startY > MARGIN + 1) {
          pages.length = startPage + 1;
          page = pages[startPage];
          page.ops.length = startOps;
          images.length = startImages;
          y = startY;
          newPage();
          draw();
        }
        return api;
      },
      /** Start a new page now unless `h` points of space are left (keeps a heading with what follows it). */
      need: function (h) { ensure(h); return api; },
      /** One picture, scaled to fit within maxWidth x maxHeight, left aligned. */
      image: function (bytes, o) {
        o = o || {};
        var info = jpegInfo(bytes);
        if (!info) return api;
        var scale = Math.min((o.maxWidth || 240) / info.width, (o.maxHeight || 180) / info.height, 1);
        var w = info.width * scale;
        var h = info.height * scale;
        ensure(h + 6);
        images.push({ bytes: bytes, info: info });
        page.ops.push('q ' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + (MARGIN + (o.indent || 0)).toFixed(2) + ' ' + (PAGE_H - y - h).toFixed(2) + ' cm /Im' + images.length + ' Do Q\n');
        y += h + 6;
        return api;
      },
      /**
       * A row (wrapping onto more rows) of small pictures, each with a caption beneath it.
       * items: [{ bytes, caption }]. Pictures that are not usable JPEGs are skipped.
       */
      pictures: function (items, o) {
        o = o || {};
        var size = o.size || 84;
        var gap = 10;
        var x0 = MARGIN + (o.indent || 0);
        var perRow = Math.max(1, Math.floor((PAGE_W - 2 * MARGIN - (o.indent || 0) + gap) / (size + gap)));
        var usable = items.filter(function (it) { return jpegInfo(it.bytes); });
        for (var i = 0; i < usable.length; i += perRow) {
          var row = usable.slice(i, i + perRow);
          ensure(size + 22);
          var rowH = 0;
          row.forEach(function (it, k) {
            var info = jpegInfo(it.bytes);
            var scale = Math.min(size / info.width, size / info.height);
            var w = info.width * scale;
            var h = info.height * scale;
            rowH = Math.max(rowH, h);
            var x = x0 + k * (size + gap);
            images.push({ bytes: it.bytes, info: info });
            page.ops.push('q ' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + x.toFixed(2) + ' ' + (PAGE_H - y - h).toFixed(2) + ' cm /Im' + images.length + ' Do Q\n');
            if (it.caption) put(encode(it.caption), 'F3', 8, x, y + h + 11, [0.25, 0.25, 0.25]);
          });
          y += rowH + 18;
        }
        return api;
      },
      pageCount: function () { return pages.length; },

      /** The finished file as bytes. */
      finish: function (meta) {
        meta = meta || {};
        var total = pages.length;
        pages.forEach(function (p, i) {
          var left = encode(footerText);
          var right = 'Page ' + (i + 1) + ' of ' + total;
          p.ops.push(color([0.4, 0.4, 0.4]) + 'BT /F1 8 Tf ' + MARGIN + ' ' + (MARGIN - 4).toFixed(2) + ' Td (' + escapeText(left) + ') Tj ET\n');
          p.ops.push(color([0.4, 0.4, 0.4]) + 'BT /F1 8 Tf ' + (PAGE_W - MARGIN - textWidth(right, 'F1', 8)).toFixed(2) + ' ' + (MARGIN - 4).toFixed(2) + ' Td (' + escapeText(right) + ') Tj ET\n');
        });

        var chunks = [];
        var length = 0;
        function str(s) {
          var u = new Uint8Array(s.length);
          for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
          chunks.push(u);
          length += u.length;
        }
        function bytes(u) { chunks.push(u); length += u.length; }

        var firstImage = 6;
        var firstPage = firstImage + images.length;
        var infoId = firstPage + pages.length * 2;
        var offsets = [];
        function begin(id) { offsets[id] = length; str(id + ' 0 obj\n'); }
        function end() { str('endobj\n'); }

        str('%PDF-1.4\n%âãÏÓ\n');
        begin(1); str('<< /Type /Catalog /Pages 2 0 R >>\n'); end();
        var kids = [];
        for (var k = 0; k < pages.length; k++) kids.push((firstPage + k * 2 + 1) + ' 0 R');
        begin(2); str('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>\n'); end();
        ['F1', 'F2', 'F3'].forEach(function (f, i) {
          begin(3 + i); str('<< /Type /Font /Subtype /Type1 /BaseFont /' + FONTS[f].name + ' /Encoding /WinAnsiEncoding >>\n'); end();
        });
        images.forEach(function (im, i) {
          var cs = im.info.components === 1 ? '/DeviceGray' : im.info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
          begin(firstImage + i);
          str('<< /Type /XObject /Subtype /Image /Width ' + im.info.width + ' /Height ' + im.info.height + ' /ColorSpace ' + cs +
            (im.info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '') + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n');
          bytes(im.bytes);
          str('\nendstream\n');
          end();
        });
        var xobjects = images.map(function (im, i) { return '/Im' + (i + 1) + ' ' + (firstImage + i) + ' 0 R'; }).join(' ');
        pages.forEach(function (p, i) {
          var content = p.ops.join('');
          var contentId = firstPage + i * 2;
          begin(contentId);
          str('<< /Length ' + content.length + ' >>\nstream\n');
          str(content);
          str('endstream\n');
          end();
          begin(contentId + 1);
          str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>' +
            (xobjects ? ' /XObject << ' + xobjects + ' >>' : '') + ' >> /Contents ' + contentId + ' 0 R >>\n');
          end();
        });
        var now = meta.date || new Date();
        var stamp = 'D:' + now.getUTCFullYear() + ('0' + (now.getUTCMonth() + 1)).slice(-2) + ('0' + now.getUTCDate()).slice(-2) +
          ('0' + now.getUTCHours()).slice(-2) + ('0' + now.getUTCMinutes()).slice(-2) + ('0' + now.getUTCSeconds()).slice(-2) + 'Z';
        begin(infoId);
        str('<< /Title (' + escapeText(encode(meta.title || 'Vehicle data export')) + ') /Producer (Fleet Manager by Potentia Motus) /CreationDate (' + stamp + ') >>\n');
        end();

        var xrefAt = length;
        var count = infoId + 1;
        str('xref\n0 ' + count + '\n0000000000 65535 f \n');
        for (var n = 1; n < count; n++) str(('0000000000' + offsets[n]).slice(-10) + ' 00000 n \n');
        str('trailer\n<< /Size ' + count + ' /Root 1 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');

        var out = new Uint8Array(length);
        var at = 0;
        chunks.forEach(function (c) { out.set(c, at); at += c.length; });
        return out;
      },
    };
    return api;
  }

  root.PdfKit = { create: create, encode: encode, textWidth: textWidth, jpegInfo: jpegInfo, PAGE_W: PAGE_W, PAGE_H: PAGE_H };
})(typeof window !== 'undefined' ? window : globalThis);
