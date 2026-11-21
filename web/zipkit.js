// A small ZIP writer for the vehicle data export. Files are stored as they are (no compression: photos and PDFs are
// already compressed), with their folder names, so every unzip tool opens the result. Names are saved as UTF-8.
(function (root) {
  'use strict';

  var table = null;
  function crcTable() {
    if (table) return table;
    table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    var t = crcTable();
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [];
    var str = unescape(encodeURIComponent(s));
    for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i));
    return new Uint8Array(out);
  }

  /** A file name that is safe inside a zip: no folders, no characters that Windows or phones refuse. */
  function safeName(name, fallback) {
    var n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
    return n.slice(0, 120) || fallback || 'file';
  }

  function create(date) {
    var d = date || new Date();
    var dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
    var dosDate = (((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
    var entries = []; // { name, crc, size, offset }
    var parts = [];
    var length = 0;

    function u16(v) { return [v & 255, (v >>> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    function push(u8) { parts.push(u8); length += u8.length; }

    return {
      /** Add a file. `path` may contain folders, e.g. "A-0002/policy.pdf". */
      add: function (path, bytes) {
        var name = utf8(path);
        var crc = crc32(bytes);
        entries.push({ name: name, crc: crc, size: bytes.length, offset: length });
        push(new Uint8Array([0x50, 0x4b, 0x03, 0x04].concat(u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(bytes.length), u32(bytes.length), u16(name.length), u16(0))));
        push(name);
        push(bytes);
      },
      count: function () { return entries.length; },
      /** The finished zip file as bytes. */
      finish: function () {
        var start = length;
        entries.forEach(function (e) {
          push(new Uint8Array([0x50, 0x4b, 0x01, 0x02].concat(u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(e.crc), u32(e.size), u32(e.size),
            u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset))));
          push(e.name);
        });
        var size = length - start;
        push(new Uint8Array([0x50, 0x4b, 0x05, 0x06].concat(u16(0), u16(0), u16(entries.length), u16(entries.length), u32(size), u32(start), u16(0))));
        var out = new Uint8Array(length);
        var at = 0;
        parts.forEach(function (p) { out.set(p, at); at += p.length; });
        return out;
      },
    };
  }

  root.ZipKit = { create: create, crc32: crc32, safeName: safeName };
})(typeof window !== 'undefined' ? window : globalThis);
