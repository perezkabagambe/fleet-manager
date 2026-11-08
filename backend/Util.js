/** Shared helpers: errors, time, hashing, random tokens, rate limiting, validation. */

// Public address of the web app (not a secret).
const SITE_URL = 'https://perezkabagambe.github.io/fleet-manager/';
const TZ = 'Europe/London';
const LOGIN_MINUTES = 15;
const SESSION_DAYS = 30;
const MAX_CODE_FAILS = 5;

/** Stop the current request with an error code the front end understands. */
function fail_(code) {
  throw { apiError: code };
}

function nowIso_() {
  return new Date().toISOString();
}

function isoIn_(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function esc_(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return map[c]; });
}

function props_() {
  return PropertiesService.getScriptProperties();
}

/** 64 hex characters (about 244 bits of randomness). */
function randomToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** Uniform-enough 6-digit numeric code. */
function randomCode_() {
  const n = parseInt(randomToken_().slice(0, 12), 16);
  return ('000000' + (n % 1000000)).slice(-6);
}

/** Secret salt kept in Script Properties (never in the repo). Created on first use. */
function salt_() {
  let s = props_().getProperty('HASH_SALT');
  if (!s) {
    s = randomToken_();
    props_().setProperty('HASH_SALT', s);
  }
  return s;
}

/** Salted SHA-256, hex. Tokens and codes are only ever stored in this form. */
function hash_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt_() + '|' + value,
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function cacheGetJson_(key) {
  const raw = CacheService.getScriptCache().get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function cachePutJson_(key, obj, ttlSec) {
  CacheService.getScriptCache().put(key, JSON.stringify(obj), ttlSec);
}

function cacheRemove_(key) {
  CacheService.getScriptCache().remove(key);
}

/**
 * Fixed-window counter. Returns true if this call is within the limit.
 * windowSec must be under 6 hours (the cache maximum).
 */
function rateLimit_(key, max, windowSec) {
  const cache = CacheService.getScriptCache();
  const bucket = 'rl:' + key + ':' + Math.floor(Date.now() / (windowSec * 1000));
  const n = Number(cache.get(bucket) || 0) + 1;
  cache.put(bucket, String(n), windowSec + 60);
  return n <= max;
}

/** Global per-day counter (London day). Returns false once the cap is reached. */
function dailyCap_(name, max) {
  const day = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const key = 'cap:' + name;
  const parts = (props_().getProperty(key) || '').split('|');
  const n = parts[0] === day ? Number(parts[1]) : 0;
  if (n >= max) return false;
  props_().setProperty(key, day + '|' + (n + 1));
  return true;
}

/** Trim, drop control characters, and cap the length. */
function cleanStr_(v, max) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Like cleanStr_ but keeps line breaks (for notes). */
function cleanText_(v, max) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** Lower-cased email, or '' if it doesn't look like one. */
function normEmail_(v) {
  const e = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  if (e.length > 254 || e.length < 5) return '';
  if (!/^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(e)) return '';
  return e;
}

function sleep_(ms) {
  Utilities.sleep(ms);
}
