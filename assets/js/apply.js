/*
 * Smart Grid Lab – private JDP application page (front end, data contract v2).
 *
 * Vanilla JavaScript, no dependencies, no build step. This file is a generic engine: the
 * application form (its markup and wording) and the question bank are NOT part of the public
 * website. The server sends them, together with the applicant's verified name and email,
 * only to holders of a valid personal link (/join/apply/?t=<64 hex characters>):
 *
 *   1. read the token from ?t= (then kept for this tab in sessionStorage and removed from the
 *      address bar) and GET the invite: {endpoint}?action=invite&t=… or, on localhost /
 *      127.0.0.1, the same-origin /api/invite?t=… of local_server.py;
 *   2. inject the served form template (parsed with DOMParser; <script>, <iframe>, <object>,
 *      <embed>, … elements, on* attributes and javascript: URLs are dropped as defense in
 *      depth) and render the served question bank into it;
 *   3. prefill the name and the verified, read-only email address; restore the draft this
 *      browser saved for this link (localStorage "sgl-jdp-draft-v2-<8 hex>", kept at most
 *      30 days); validate; check the PDFs; and submit the "sgl-jdp-application" v2 payload
 *      as text/plain JSON (a CORS "simple request", required by Google Apps Script) to
 *      {endpoint}?action=submit or /api/submit.
 *
 * Safety rules followed throughout: no innerHTML, no inline handlers; every text that comes
 * from the applicant or the server is inserted with textContent / createTextNode.
 */
(() => {
  'use strict';

  const CFG = window.JDP_APPLY_CONFIG || null;
  let Q = null; // question bank, served with the invite

  const SCHEMA = 'sgl-jdp-application';
  const SCHEMA_VERSION = 2;
  const DRAFT_PREFIX = 'sgl-jdp-draft-v2-';
  const LEGACY_DRAFT_KEYS = ['sgl-jdp-draft-v1']; // the old public form; removed on sight
  const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const TOKEN_RE = /^[0-9a-f]{64}$/;
  // Decimal megabytes: never more permissive than a server that counts 1 MB = 1,048,576 bytes.
  const MB = 1000 * 1000;
  const MAX_INTERESTS = 3;
  const MIN_STATEMENT = 100;
  const LIMITS = { statement: 3000, why_lab: 2000, code_links: 1000, other_courses: 1000, grad_thesis_title: 1000 };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const URL_FIELDS = ['linkedin', 'scholar', 'github', 'website'];
  const DECIMAL_FIELDS = ['ug_gpa', 'grad_gpa', 'english_score', 'gre_awa'];
  const XHR_TIMEOUT_MS = 5 * 60 * 1000;
  const LOAD_TIMEOUT_MS = 60 * 1000;
  // The servers quietly ignore applications sent less than 10 s after the form was opened (a
  // bot signal); a real submission that fast is held back instead of being dropped.
  const MIN_SUBMIT_ELAPSED_MS = 11 * 1000;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

  // Score rules per English test (the field labels come from the served template).
  // TOEFL iBT has two scales: 0–120 (whole numbers) and, for tests taken from January 21, 2026,
  // band scores 1–6 in steps of 0.5. A value of 6 or less is read as a band score.
  const ENGLISH = {
    TOEFL: { name: 'TOEFL iBT', toefl: true },
    IELTS: { name: 'IELTS', min: 0, max: 9, half: true },
    PTE: { name: 'PTE Academic', min: 10, max: 90, half: false },
    Duolingo: { name: 'Duolingo English Test', min: 10, max: 160, half: false }
  };

  const FILES = [
    { key: 'cv', missing: 'Upload your CV as a PDF.', required: () => true },
    { key: 'transcript_undergrad', missing: 'Upload your undergraduate transcript as a PDF.', required: () => true },
    { key: 'transcript_grad', missing: 'Upload your graduate transcript as a PDF.', required: () => needsGrad() },
    { key: 'writing_sample', missing: '', required: () => false },
    { key: 'english_report', missing: '', required: () => false }
  ];

  // When the first field changes, these fields are re-checked (only if they already show an error).
  const LINKED = {
    ug_gpa_scale: ['ug_gpa'],
    grad_gpa_scale: ['grad_gpa'],
    grad_gpa: ['grad_gpa_scale'],
    journal_papers: ['journal_first_author'],
    conference_papers: ['conference_first_author'],
    english_type: ['english_score'],
    gre_taken: ['gre_quant', 'gre_verbal', 'gre_awa'],
    highest_degree: ['grad_institution', 'grad_major', 'grad_grad_year', 'grad_gpa', 'grad_gpa_scale', 'file_transcript_grad']
  };

  const positive = (v, d) => {
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : d;
  };
  const MAX_FILE_MB = CFG ? positive(CFG.maxFileMB, 5) : 5;
  const MAX_TOTAL_MB = CFG ? positive(CFG.maxTotalMB, 15) : 15;

  const state = {
    token: '',
    invite: null,
    draftKey: '',
    owner: '',            // short hash of the verified email (moves a draft to a newer link)
    startedAt: new Date().toISOString(),
    submitAttempted: false,
    sending: false,
    submitted: false,
    closed: false,
    files: {},            // key -> File that passed all checks
    fileErrors: {},       // key -> message from the last failed check
    fileTokens: {},       // key -> counter, discards results of stale async checks
    fileChecks: {},       // key -> pending Promise
    errors: new Map(),    // validation key -> message currently shown
    saveTimer: 0
  };

  let form = null;
  let validators = {};
  let scaleWords = [];    // short description of each rating 0..10 (from the template)

  /* ------------------------------------------------------------------
     Small helpers
  ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  // createElement helper: attrs.text -> textContent, attrs.className -> class,
  // true -> boolean attribute, false/null/undefined -> omitted.
  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'className') node.className = String(v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (children) {
      children.forEach((c) => {
        if (c === null || c === undefined || c === '') return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function str(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
  }

  // The name in the invitation was typed by whoever requested the link - anyone can request one
  // for any address - so it is shown and prefilled only if it looks like a name. Same rule as
  // the servers (displayName_ / display_name), which already filter it; checked again here in
  // case an older back end is still deployed: at most 40 letters (with accents), spaces,
  // hyphens and apostrophes, a dot only after a one-letter initial; no digits, links or symbols.
  const NAME_MAX = 40;
  const NAME_CHARS = (() => {
    try {
      return { letter: new RegExp('\\p{L}', 'u'), mark: new RegExp('\\p{M}', 'u') };
    } catch (e) {
      return null; // no Unicode property escapes in this browser: show no name at all
    }
  })();

  function plainName(value) {
    const name = str(value, 200);
    if (!name || !NAME_CHARS) return '';
    const chars = Array.from(name);
    if (chars.length > NAME_MAX) return '';
    let letters = 0;
    let previous = ''; // 'L' letter (or its accent), 'D' dot, 'S' space, hyphen or apostrophe
    let run = 0;
    let afterDot = false;
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      if (NAME_CHARS.letter.test(ch)) {
        if (previous === 'L') run += 1;
        else {
          run = 1;
          afterDot = previous === 'D';
        }
        if (afterDot && run > 1) return '';
        letters += 1;
        previous = 'L';
      } else if (NAME_CHARS.mark.test(ch)) {
        if (previous !== 'L') return '';
      } else if (ch === '.') {
        if (previous !== 'L' || run !== 1) return '';
        previous = 'D';
      } else if (" '\u2019-".indexOf(ch) >= 0) {
        previous = 'S';
      } else {
        return '';
      }
    }
    return letters ? name : '';
  }

  function formatBytes(n) {
    if (n < MB) return Math.max(1, Math.round(n / 1000)) + ' KB';
    return (n / MB).toFixed(1) + ' MB';
  }

  function formatInt(n) {
    return Number(n).toLocaleString('en-US');
  }

  function smooth() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    } catch (e) {
      return 'auto';
    }
  }

  function focusEl(el) {
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      el.focus();
    }
  }

  function field(name) {
    return form.elements.namedItem(name);
  }

  // Trimmed value of a control (radio groups return the checked value).
  function val(name) {
    const f = field(name);
    return f && f.value !== undefined && f.value !== null ? String(f.value).trim() : '';
  }

  function rawVal(name) {
    const f = field(name);
    return f && typeof f.value === 'string' ? f.value : '';
  }

  function radioVal(name) {
    const c = form.querySelector('input[type="radio"][name="' + name + '"]:checked');
    return c ? c.value : '';
  }

  function isChecked(id) {
    const el = $(id);
    return !!(el && el.checked);
  }

  function isBS() {
    return val('highest_degree') === 'BS';
  }

  // Graduate fields are shown unless the degree is "BS", but they are only flagged as missing once a
  // degree has been chosen (until then the "Select your highest degree" error already blocks submission).
  function needsGrad() {
    const d = val('highest_degree');
    return d !== '' && d !== 'BS';
  }

  function interestBoxes() {
    return Array.prototype.slice.call(form.querySelectorAll('input[type="checkbox"][name="interests"]'));
  }

  function checkedInterests() {
    return interestBoxes().filter((b) => b.checked).map((b) => b.value);
  }

  function confidenceItems() {
    const out = [];
    Q.confidenceGroups.forEach((g) => {
      g.items.forEach((it) => out.push({ id: it.id, label: it.label, group: g.id }));
    });
    return out;
  }

  function clampInt(v, lo, hi) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  function setShown(id, shown) {
    const el = $(id);
    if (el) el.hidden = !shown;
  }

  function tokens(el, attr) {
    return (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
  }

  function addToken(el, attr, value) {
    const list = tokens(el, attr);
    if (list.indexOf(value) < 0) list.push(value);
    el.setAttribute(attr, list.join(' '));
  }

  function removeToken(el, attr, value) {
    const list = tokens(el, attr).filter((t) => t !== value);
    if (list.length) el.setAttribute(attr, list.join(' '));
    else el.removeAttribute(attr);
  }

  /* ------------------------------------------------------------------
     SHA-256 (synchronous, so draft keys are identical in every browser context;
     crypto.subtle is missing on plain-http LAN addresses)
  ------------------------------------------------------------------ */

  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    const s = unescape(encodeURIComponent(text));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
    return out;
  }

  function sha256Hex(text) {
    const bytes = utf8(String(text));
    const total = Math.ceil((bytes.length + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const view = new DataView(buf.buffer);
    const bits = bytes.length * 8;
    view.setUint32(total - 8, Math.floor(bits / 0x100000000));
    view.setUint32(total - 4, bits >>> 0);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i += 1) W[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
      for (let i = 0; i < 64; i += 1) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + hh) >>> 0;
    }
    return H.map((x) => ('00000000' + x.toString(16)).slice(-8)).join('');
  }

  /* ------------------------------------------------------------------
     Configuration: endpoints and the deadline (keep in sync with join-request.js)
  ------------------------------------------------------------------ */

  function isLocalHost() {
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1';
  }

  function actionUrl(action) {
    if (isLocalHost()) return '/api/' + action;
    const ep = String((CFG && CFG.endpoint) || '').trim();
    if (!ep) return '';
    return ep + (ep.indexOf('?') >= 0 ? '&' : '?') + 'action=' + encodeURIComponent(action);
  }

  function inviteUrl(token) {
    if (isLocalHost()) return '/api/invite?t=' + encodeURIComponent(token);
    const base = actionUrl('invite');
    return base ? base + '&t=' + encodeURIComponent(token) : '';
  }

  function deadlineZone() {
    return String((CFG && CFG.deadlineTimeZone) || 'America/Los_Angeles');
  }

  function zoneLabel() {
    return deadlineZone() === 'America/Los_Angeles' ? 'Pacific Time' : deadlineZone().replace(/_/g, ' ') + ' time';
  }

  function parseDeadline() {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String((CFG && CFG.deadline) || '').trim());
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  }

  // Offset (ms) of a time zone from UTC at a given instant, e.g. -8 h for Pacific standard time.
  function zoneOffset(ts, zone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric'
      }).formatToParts(new Date(ts));
      const get = (type) => Number((parts.filter((p) => p.type === type)[0] || {}).value);
      const hour = get('hour') % 24;
      const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
      const offset = asUtc - Math.floor(ts / 1000) * 1000;
      return isFinite(offset) ? offset : null;
    } catch (e) {
      return null;
    }
  }

  // Applications close at 23:59:59.999 on the deadline day in the configured time zone (Pacific
  // time by default) for every applicant, wherever they are. Returns a UTC timestamp or null.
  function deadlineEnd() {
    const d = parseDeadline();
    if (!d) return null;
    const wall = Date.UTC(d.y, d.m - 1, d.d, 23, 59, 59, 999);
    let ts = wall;
    for (let i = 0; i < 3; i += 1) {
      const offset = zoneOffset(ts, deadlineZone());
      if (offset === null) {
        // No time-zone support in this browser: Pacific standard time in winter, daylight time otherwise.
        return wall + ((d.m >= 11 || d.m <= 3) ? 8 : 7) * 3600 * 1000;
      }
      const next = wall - offset;
      if (next === ts) break;
      ts = next;
    }
    return ts;
  }

  function isPastDeadline() {
    const end = deadlineEnd();
    return end !== null && Date.now() > end;
  }

  function deadlineLabel() {
    const d = parseDeadline();
    return d ? MONTHS[d.m - 1] + ' ' + d.d + ', ' + d.y : '';
  }

  // "November 6, 2026" for an ISO timestamp, as a date in the deadline's time zone.
  function formatDate(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: deadlineZone(), year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(t));
    } catch (e) {
      const d = new Date(t);
      return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    }
  }

  /* ------------------------------------------------------------------
     Page states: loading / invalid link / closed / could not load / application
  ------------------------------------------------------------------ */

  const STATE_IDS = ['ap-loading', 'ap-state-invalid', 'ap-state-closed', 'ap-state-error', 'ap-app'];

  function showState(id) {
    STATE_IDS.forEach((s) => setShown(s, s === id));
  }

  // The closing date is named only once it has passed: the server can also close intake early
  // (ACCEPTING=false), and the page must not claim it closed on a day still to come.
  function closedDateLabel() {
    return isPastDeadline() ? deadlineLabel() : '';
  }

  function showClosedState() {
    state.closed = true;
    const label = closedDateLabel();
    const p = document.querySelector('#ap-state-closed p');
    if (p) {
      p.textContent = '';
      p.appendChild(h('strong', { text: 'Applications are closed.' }));
      p.appendChild(document.createTextNode((label ? ' The Smart Grid Lab application for ' + ((CFG && CFG.cycle) || 'Fall 2027') +
        ' closed on ' + label + '.' : '') + ' Thank you for your interest.'));
    }
    showState('ap-state-closed');
  }

  // retry: show the "Try again" button (only useful when the invite request itself failed).
  function showLoadError(title, text, retry) {
    const p = $('ap-state-error-text');
    if (p) {
      p.textContent = '';
      p.appendChild(h('strong', { text: title }));
      p.appendChild(document.createTextNode(' ' + text));
    }
    const button = $('ap-retry');
    if (button && button.parentElement) button.parentElement.hidden = !retry;
    showState('ap-state-error');
  }

  /* ------------------------------------------------------------------
     The served form: sanitizing and injecting the template
  ------------------------------------------------------------------ */

  const BLOCKED_ELEMENTS = 'script, iframe, frame, frameset, object, embed, applet, base, meta, link, style, template, noscript, portal';
  const URL_ATTRIBUTES = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster', 'background', 'srcset'];

  // Parse the template without running anything, drop active content, and return a copy of its <form>.
  function buildForm(html) {
    let doc = null;
    try {
      doc = new DOMParser().parseFromString(String(html), 'text/html');
    } catch (e) {
      doc = null;
    }
    if (!doc || !doc.body) return null;
    Array.prototype.forEach.call(doc.querySelectorAll(BLOCKED_ELEMENTS), (n) => n.remove());
    Array.prototype.forEach.call(doc.body.querySelectorAll('*'), (el) => {
      Array.prototype.slice.call(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || '').replace(/[\u0000- \u007f]/g, '').toLowerCase();
        if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'action' || name === 'formaction' ||
            (URL_ATTRIBUTES.indexOf(name) >= 0 && /^(javascript|vbscript|data):/.test(value))) {
          el.removeAttribute(attr.name);
        }
      });
    });
    const source = doc.body.querySelector('form');
    if (!source) return null;
    const node = document.importNode(source, true);
    if (!node.id) node.id = 'jdp-form';
    return node;
  }

  function isItemList(list, keys) {
    return Array.isArray(list) && list.length > 0 && list.every((it) => it && typeof it === 'object' &&
      keys.every((k) => typeof it[k] === 'string' && it[k] !== ''));
  }

  function validBank(q) {
    return !!q && typeof q === 'object' &&
      isItemList(q.yesno, ['id', 'label']) &&
      isItemList(q.courses, ['id', 'label']) &&
      isItemList(q.interests, ['id', 'label']) &&
      isItemList(q.confidenceGroups, ['id', 'title']) &&
      q.confidenceGroups.every((g) => isItemList(g.items, ['id', 'label']));
  }

  /* ------------------------------------------------------------------
     Rendering of the question-bank sections
  ------------------------------------------------------------------ */

  function renderInterests() {
    const list = $('interests-list');
    Q.interests.forEach((it) => {
      const id = 'interest-' + it.id;
      const box = h('input', { type: 'checkbox', id: id, name: 'interests', value: it.id });
      list.appendChild(h('label', { className: 'ap-interest', for: id }, [box, h('span', { text: it.label })]));
    });
    const count = $('interests-count');
    if (count) count.textContent = '0 of ' + MAX_INTERESTS + ' selected';
  }

  function renderYesNo() {
    const list = $('yesno-list');
    Q.yesno.forEach((q, i) => {
      const name = 'yn_' + q.id;
      const choices = h('div', { className: 'ap-choices' });
      [['yes', 'Yes'], ['no', 'No']].forEach((pair) => {
        const input = h('input', { type: 'radio', id: name + '-' + pair[0], name: name, value: pair[0], required: true, 'aria-invalid': 'false' });
        choices.appendChild(h('label', { className: 'ap-choice' }, [input, h('span', { text: pair[1] })]));
      });
      list.appendChild(h('fieldset', { className: 'ap-yn', id: name + '-group' }, [
        h('legend', null, [h('span', { className: 'ap-yn-num', text: (i + 1) + '.' }), ' ' + q.label]),
        choices,
        h('p', { className: 'ap-error', id: name + '-error', hidden: true })
      ]));
    });
  }

  function readScaleWords() {
    const words = Array.prototype.map.call(form.querySelectorAll('#ap-scale-words li'), (li) => li.textContent.trim());
    return words.length === 11 ? words : [];
  }

  function renderConfidence() {
    const groups = $('confidence-groups');
    Q.confidenceGroups.forEach((g) => {
      const titleId = 'conf-group-' + g.id;
      const block = h('div', { className: 'ap-conf-group', role: 'group', 'aria-labelledby': titleId }, [
        h('h3', { className: 'ap-conf-group-title', id: titleId, text: g.title })
      ]);
      g.items.forEach((it) => {
        const id = 'conf-' + it.id;
        const input = h('input', {
          type: 'range', id: id, name: 'conf_' + it.id, min: 0, max: 10, step: 1, value: 0,
          'data-group': g.id
        });
        const shown = h('span', { className: 'ap-conf-val', id: id + '-val', 'aria-hidden': 'true' }, [
          h('span', { className: 'ap-conf-num', text: '0' }),
          h('span', { className: 'ap-conf-desc', text: scaleWords[0] || '' })
        ]);
        block.appendChild(h('div', { className: 'ap-conf-item' }, [
          h('label', { className: 'ap-conf-label', for: id, text: it.label }),
          h('div', { className: 'ap-conf-control' }, [input, shown])
        ]));
      });
      groups.appendChild(block);
    });
  }

  function renderCourses() {
    const list = $('course-list');
    Q.courses.forEach((c) => {
      const base = 'course_' + c.id;
      const box = h('input', { type: 'checkbox', id: base, name: base, value: 'yes' });
      const level = h('select', { id: base + '_level', name: base + '_level', 'aria-invalid': 'false' });
      [['', 'Select…'], ['UG', 'Undergraduate'], ['Grad', 'Graduate'], ['Both', 'Both']].forEach((pair) => {
        level.appendChild(h('option', { value: pair[0], text: pair[1] }));
      });
      const grade = h('input', {
        type: 'text', id: base + '_grade', name: base + '_grade', maxlength: 20,
        autocomplete: 'off', placeholder: 'e.g., A or 3.7'
      });
      const details = h('div', { className: 'ap-course-details', id: base + '-details', hidden: true }, [
        h('div', null, [
          h('label', { for: base + '_level' }, [
            'Level', h('span', { className: 'ap-vh', text: ' for ' + c.label }),
            ' ', h('span', { className: 'ap-req', 'aria-hidden': 'true', text: '*' })
          ]),
          level
        ]),
        h('div', null, [
          h('label', { for: base + '_grade' }, [
            'Grade', h('span', { className: 'ap-vh', text: ' for ' + c.label }), ' (optional)'
          ]),
          grade
        ]),
        h('p', { className: 'ap-error', id: base + '_level-error', hidden: true })
      ]);
      list.appendChild(h('div', { className: 'ap-course', 'data-course': c.id }, [
        h('label', { className: 'ap-course-main', for: base }, [box, h('span', { text: c.label })]),
        details
      ]));
    });
  }

  function fillStaticText() {
    form.querySelectorAll('[data-ap-max-file]').forEach((n) => { n.textContent = MAX_FILE_MB + ' MB'; });
    form.querySelectorAll('[data-ap-max-total]').forEach((n) => { n.textContent = MAX_TOTAL_MB + ' MB'; });
    FILES.forEach((f) => {
      const status = $('file_' + f.key + '-status');
      if (status) status.setAttribute('aria-live', 'polite');
    });
  }

  // Native `required` makes browsers report untouched controls as "invalid" to screen readers;
  // an explicit aria-invalid="false" keeps that until a check has actually failed.
  function initAriaInvalid() {
    Array.prototype.forEach.call(form.querySelectorAll('input, select, textarea'), (el) => {
      if (!el.hasAttribute('aria-invalid') && el.type !== 'hidden') el.setAttribute('aria-invalid', 'false');
    });
  }

  /* ------------------------------------------------------------------
     Conditional parts of the form
  ------------------------------------------------------------------ */

  function updateDegreeUI(fromUser) {
    const bs = isBS();
    setShown('grad-block', !bs);
    setShown('file-field-transcript_grad', !bs);
    ['grad_institution', 'grad_major', 'grad_grad_year'].forEach((n) => { $(n).required = !bs; });
    $('file_transcript_grad').required = !bs;
    if (bs) {
      if (fromUser && (state.files.transcript_grad || state.fileErrors.transcript_grad)) removeFile('transcript_grad', true);
      clearErrors(['grad_institution', 'grad_major', 'grad_grad_year', 'grad_gpa', 'grad_gpa_scale', 'grad_thesis_title', 'file_transcript_grad']);
    }
    updateFilesTotal();
  }

  function updateThesisUI() {
    setShown('grad-thesis-title-field', radioVal('grad_thesis') === 'yes');
  }

  function updateEnglishUI() {
    const t = val('english_type');
    const spec = hasOwn(ENGLISH, t) ? ENGLISH[t] : null;
    setShown('english-score-field', !!spec);
    const input = $('english_score');
    input.required = !!spec;
    if (spec) {
      const select = $('english_type');
      const option = select && select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
      const label = (option && option.getAttribute('data-score-label')) || spec.name + ' score';
      const placeholder = option && option.getAttribute('data-score-placeholder');
      $('english_score-label').textContent = label;
      if (placeholder) input.setAttribute('placeholder', placeholder);
      else input.removeAttribute('placeholder');
    } else {
      clearErrors(['english_score']);
    }
  }

  function updateGreUI() {
    const taken = radioVal('gre_taken') === 'yes';
    setShown('gre-scores', taken);
    $('gre_quant').required = taken;
    $('gre_verbal').required = taken;
    if (!taken) clearErrors(['gre_quant', 'gre_verbal', 'gre_awa']);
  }

  function updateSlider(input) {
    const v = clampInt(input.value, 0, 10);
    const desc = scaleWords[v] || '';
    input.style.setProperty('--pct', (v * 10) + '%');
    input.setAttribute('aria-valuetext', v + ' out of 10' + (desc ? ': ' + desc : ''));
    const shown = $(input.id + '-val');
    if (!shown) return;
    shown.querySelector('.ap-conf-num').textContent = String(v);
    shown.querySelector('.ap-conf-desc').textContent = desc;
    shown.classList.toggle('is-set', v > 0);
  }

  function updateCourse(courseId) {
    const base = 'course_' + courseId;
    const box = $(base);
    if (!box) return;
    const on = box.checked;
    const card = box.closest('.ap-course');
    if (card) card.classList.toggle('is-checked', on);
    setShown(base + '-details', on);
    $(base + '_level').required = on;
    if (!on) clearErrors([base + '_level']);
  }

  function updateInterests() {
    const boxes = interestBoxes();
    const n = boxes.filter((b) => b.checked).length;
    const full = n >= MAX_INTERESTS;
    boxes.forEach((b) => {
      b.disabled = full && !b.checked;
      const row = b.closest('.ap-interest');
      if (row) {
        row.classList.toggle('is-checked', b.checked);
        row.classList.toggle('is-disabled', b.disabled);
      }
    });
    const count = $('interests-count');
    if (count) count.textContent = n + ' of ' + MAX_INTERESTS + ' selected';
  }

  function updateCounter(ta) {
    const out = $(ta.id + '-count');
    if (!out) return;
    const max = Number(ta.getAttribute('data-max')) || 0;
    const len = ta.value.length;
    let text = formatInt(len) + ' / ' + formatInt(max) + ' characters';
    if (ta.hasAttribute('data-words')) {
      const words = (ta.value.trim().match(/\S+/g) || []).length;
      text += ' · ' + formatInt(words) + (words === 1 ? ' word' : ' words') + ' (suggested 250–400)';
    }
    out.textContent = text;
    out.classList.toggle('is-over', max > 0 && len > max);
  }

  function refreshAll() {
    updateDegreeUI(false);
    updateThesisUI();
    updateEnglishUI();
    updateGreUI();
    form.querySelectorAll('input[type="range"]').forEach(updateSlider);
    Q.courses.forEach((c) => updateCourse(c.id));
    updateInterests();
    form.querySelectorAll('textarea[data-max]').forEach(updateCounter);
    FILES.forEach((f) => renderFileStatus(f.key));
    updateFilesTotal();
  }

  function updateUIFor(t) {
    if (t.type === 'range') {
      updateSlider(t);
      return;
    }
    switch (t.name) {
      case 'highest_degree': updateDegreeUI(true); break;
      case 'grad_thesis': updateThesisUI(); break;
      case 'english_type': updateEnglishUI(); break;
      case 'gre_taken': updateGreUI(); break;
      case 'interests': updateInterests(); break;
      default: break;
    }
    if (t.type === 'checkbox' && t.name.indexOf('course_') === 0) updateCourse(t.name.slice(7));
    if (t.tagName === 'TEXTAREA' && t.hasAttribute('data-max')) updateCounter(t);
  }

  /* ------------------------------------------------------------------
     Validation
  ------------------------------------------------------------------ */

  function requiredText(name, message) {
    return () => (val(name) ? '' : message);
  }

  function lengthCheck(name, max, what) {
    const len = rawVal(name).trim().length;
    return len > max ? 'Shorten ' + what + ' to ' + formatInt(max) + ' characters or fewer (currently ' + formatInt(len) + ').' : '';
  }

  function validateYear(name, which) {
    const v = val(name);
    if (!v) return 'Enter your ' + which + ' graduation year.';
    if (!/^\d{4}$/.test(v)) return 'Enter your ' + which + ' graduation year as four digits, e.g., 2025.';
    const y = Number(v);
    const max = new Date().getFullYear() + 8;
    if (y < 1960 || y > max) return 'Enter a ' + which + ' graduation year between 1960 and ' + max + '.';
    return '';
  }

  function validateGpa(name, scaleName, which, required) {
    const raw = val(name);
    if (!raw) return required ? 'Enter your ' + which + ' GPA.' : '';
    const v = raw.replace(',', '.');
    if (!/^\d{1,3}(\.\d{1,3})?$/.test(v)) return 'Enter your ' + which + ' GPA as a number, e.g., 3.72 or 17.5.';
    const n = Number(v);
    if (n <= 0) return 'Enter your ' + which + ' GPA as a number greater than 0.';
    const scale = Number(val(scaleName));
    if (scale && n > scale) return 'Your ' + which + ' GPA (' + v + ') is higher than the selected scale (out of ' + scale + '). Please check the scale.';
    return '';
  }

  function validateCount(name, label) {
    const el = $(name);
    if (el.validity && el.validity.badInput) return label + ': enter a whole number (0 or more).';
    const raw = el.value.trim();
    if (raw === '') return '';
    const n = Number(raw);
    if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return label + ': enter a whole number (0 or more).';
    if (n > 200) return label + ': enter a number no greater than 200.';
    return '';
  }

  function validateFirstAuthor(name, totalName, label, totalLabel) {
    const basic = validateCount(name, label);
    if (basic) return basic;
    const n = Number($(name).value || 0);
    const total = Number($(totalName).value || 0);
    if (isFinite(total) && n > total) return label + ' cannot be more than your total number of ' + totalLabel + '.';
    return '';
  }

  function validateYears(name, label) {
    const el = $(name);
    if (el.validity && el.validity.badInput) return label + ': enter a number of years, e.g., 1.5.';
    const raw = el.value.trim();
    if (raw === '') return '';
    const n = Number(raw);
    if (!isFinite(n) || n < 0 || n > 50) return label + ': enter a number between 0 and 50.';
    return '';
  }

  function validateUrl(name, label) {
    const v = val(name);
    if (!v) return '';
    let u = null;
    try {
      u = new URL(v);
    } catch (e) {
      u = null;
    }
    if (!u || !/^https?:$/.test(u.protocol) || u.hostname.indexOf('.') < 0) {
      return label + ': enter a full web address starting with https://';
    }
    return '';
  }

  function normalizeUrl(el) {
    const v = el.value.trim();
    let out = v;
    if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s/]+\.[^\s]+$/.test(v)) out = 'https://' + v;
    if (out !== el.value) el.value = out;
  }

  function validateEnglish() {
    const t = val('english_type');
    if (!hasOwn(ENGLISH, t)) return '';
    const spec = ENGLISH[t];
    const raw = val('english_score').replace(',', '.');
    if (!raw) return 'Enter your ' + spec.name + ' score.';
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return 'Enter your ' + spec.name + ' score as a number.';
    const n = Number(raw);
    if (spec.toefl) {
      if (n <= 6) {
        if (n < 1 || Math.round(n * 2) !== n * 2) return 'TOEFL iBT band scores go from 1 to 6 in steps of 0.5, e.g., 4.5.';
        return '';
      }
      if (n > 120) return 'TOEFL iBT scores range from 0 to 120 (or 1 to 6 on the band scale).';
      if (Math.floor(n) !== n) return 'Enter your TOEFL iBT score as a whole number from 0 to 120, or a band score from 1 to 6.';
      return '';
    }
    if (n < spec.min || n > spec.max) return spec.name + ' scores range from ' + spec.min + ' to ' + spec.max + '.';
    if (spec.half && Math.round(n * 2) !== n * 2) return spec.name + ' band scores go in steps of 0.5, e.g., 7.5.';
    if (!spec.half && Math.floor(n) !== n) return 'Enter your ' + spec.name + ' score as a whole number.';
    return '';
  }

  function validateGre(name, label, lo, hi, required, half) {
    if (radioVal('gre_taken') !== 'yes') return '';
    const raw = val(name);
    if (!raw) return required ? 'Enter your GRE ' + label + ' score.' : '';
    if (!/^\d{1,3}(\.\d)?$/.test(raw)) return 'GRE ' + label + ': enter a number from ' + lo + ' to ' + hi + '.';
    const n = Number(raw);
    if (n < lo || n > hi) return 'GRE ' + label + ' scores range from ' + lo + ' to ' + hi + '.';
    if (half && Math.round(n * 2) !== n * 2) return 'GRE ' + label + ' scores go in steps of 0.5.';
    if (!half && Math.floor(n) !== n) return 'GRE ' + label + ': enter a whole number.';
    return '';
  }

  function validateFile(f) {
    const key = f.key;
    if (key === 'transcript_grad' && isBS()) return '';
    if (state.fileErrors[key]) return state.fileErrors[key];
    if (f.required() && !state.files[key]) return f.missing;
    return '';
  }

  // Built in the same order as the fields appear on the page (the summary follows it).
  function buildValidators() {
    const V = {};
    V.first_name = requiredText('first_name', 'Enter your first name.');
    V.last_name = requiredText('last_name', 'Enter your last name.');
    V.email = () => {
      const v = val('email');
      if (!v) return 'Your email address is missing. Please open the link from your email again.';
      if (v.length > 254 || !EMAIL_RE.test(v)) return 'Enter a valid email address, like name@example.com.';
      return '';
    };
    V.phone = () => {
      const v = val('phone');
      if (!v) return '';
      const digits = v.replace(/\D/g, '').length;
      if (digits < 7 || digits > 20 || /[^0-9+().\-\s/xX]/.test(v)) return 'Enter a valid phone number, including the country code.';
      return '';
    };
    V.country = requiredText('country', 'Enter the country where you currently live.');
    V.linkedin = () => validateUrl('linkedin', 'LinkedIn');
    V.scholar = () => validateUrl('scholar', 'Google Scholar');
    V.github = () => validateUrl('github', 'GitHub');
    V.website = () => validateUrl('website', 'Personal website');
    V.start_term = requiredText('start_term', 'Select your intended start term.');
    V.highest_degree = requiredText('highest_degree', 'Select your highest degree.');
    V.ug_institution = requiredText('ug_institution', 'Enter your undergraduate institution.');
    V.ug_major = requiredText('ug_major', 'Enter your undergraduate major.');
    V.ug_grad_year = () => validateYear('ug_grad_year', 'undergraduate');
    V.ug_gpa = () => validateGpa('ug_gpa', 'ug_gpa_scale', 'undergraduate', true);
    V.ug_gpa_scale = requiredText('ug_gpa_scale', 'Select the scale of your undergraduate GPA.');
    V.grad_institution = () => (!needsGrad() || val('grad_institution') ? '' : 'Enter your graduate institution.');
    V.grad_major = () => (!needsGrad() || val('grad_major') ? '' : 'Enter your graduate major or field.');
    V.grad_grad_year = () => (!needsGrad() ? '' : validateYear('grad_grad_year', 'graduate'));
    V.grad_gpa = () => (!needsGrad() ? '' : validateGpa('grad_gpa', 'grad_gpa_scale', 'graduate', false));
    V.grad_gpa_scale = () => (!needsGrad() || !val('grad_gpa') || val('grad_gpa_scale') ? '' : 'Select the scale of your graduate GPA.');
    V.grad_thesis_title = () => (!needsGrad() || radioVal('grad_thesis') !== 'yes' ? '' : lengthCheck('grad_thesis_title', LIMITS.grad_thesis_title, 'the thesis title'));
    V.english_type = requiredText('english_type', 'Select your English proficiency.');
    V.english_score = validateEnglish;
    V.gre_quant = () => validateGre('gre_quant', 'Quantitative', 130, 170, true, false);
    V.gre_verbal = () => validateGre('gre_verbal', 'Verbal', 130, 170, true, false);
    V.gre_awa = () => validateGre('gre_awa', 'Analytical Writing', 0, 6, false, true);
    V.journal_papers = () => validateCount('journal_papers', 'Journal papers');
    V.journal_first_author = () => validateFirstAuthor('journal_first_author', 'journal_papers', 'First-author journal papers', 'journal papers');
    V.conference_papers = () => validateCount('conference_papers', 'Conference papers');
    V.conference_first_author = () => validateFirstAuthor('conference_first_author', 'conference_papers', 'First-author conference papers', 'conference papers');
    V.research_years = () => validateYears('research_years', 'Years of research experience');
    V.industry_years = () => validateYears('industry_years', 'Years of industry experience');
    V.interests = () => {
      const n = checkedInterests().length;
      if (n === 0) return 'Choose at least one research interest.';
      if (n > MAX_INTERESTS) return 'Choose no more than ' + MAX_INTERESTS + ' research interests.';
      return '';
    };
    V.statement = () => {
      const v = rawVal('statement').trim();
      if (!v) return 'Write a short research statement.';
      if (v.length < MIN_STATEMENT) return 'Please write a little more in your research statement (at least ' + MIN_STATEMENT + ' characters).';
      return lengthCheck('statement', LIMITS.statement, 'your research statement');
    };
    V.why_lab = () => lengthCheck('why_lab', LIMITS.why_lab, 'your answer to “Why the Smart Grid Lab?”');
    V.code_links = () => lengthCheck('code_links', LIMITS.code_links, 'your list of links');
    Q.yesno.forEach((q) => {
      V['yn_' + q.id] = () => (radioVal('yn_' + q.id) ? '' : 'Select Yes or No.');
    });
    Q.courses.forEach((c) => {
      const base = 'course_' + c.id;
      V[base + '_level'] = () => (isChecked(base) && !val(base + '_level') ? 'Select the level for ' + c.label + '.' : '');
    });
    V.other_courses = () => lengthCheck('other_courses', LIMITS.other_courses, 'your list of other courses');
    FILES.forEach((f) => {
      V['file_' + f.key] = () => validateFile(f);
    });
    V.consent_accurate = () => (isChecked('consent_accurate') ? '' : 'Confirm that the information in your application is accurate.');
    V.consent_privacy = () => (isChecked('consent_privacy') ? '' : 'Agree that your information may be used to evaluate your application.');
    return V;
  }

  // Which validation key a control belongs to.
  function keyFor(el) {
    const name = el.name || '';
    if (name === 'interests') return 'interests';
    if (el.type === 'checkbox' && name.indexOf('course_') === 0) return name + '_level';
    return hasOwn(validators, name) ? name : '';
  }

  // Elements involved in showing an error for a validation key.
  function targetsFor(key) {
    if (key.indexOf('yn_') === 0) {
      const radios = Array.prototype.slice.call(form.querySelectorAll('input[name="' + key + '"]'));
      const group = $(key + '-group');
      return { focus: radios[0], error: $(key + '-error'), invalid: radios, described: [group], box: group };
    }
    if (key === 'interests') {
      const boxes = interestBoxes();
      const group = $('interests-group');
      return { focus: boxes.filter((b) => !b.disabled)[0] || boxes[0], error: $('interests-error'), invalid: boxes, described: [group], box: group };
    }
    if (key.indexOf('file_') === 0) {
      const input = $(key);
      return { focus: input, error: $(key + '-error'), invalid: [input], described: [input], box: $('file-field-' + key.slice(5)) };
    }
    const el = $(key);
    return { focus: el, error: $(key + '-error'), invalid: el ? [el] : [], described: el ? [el] : [], box: el ? el.closest('.ap-course, .ap-file, .ap-field') : null };
  }

  function summaryText(key, msg) {
    if (key.indexOf('yn_') === 0) {
      const i = Q.yesno.findIndex((q) => 'yn_' + q.id === key);
      return 'Background question ' + (i + 1) + ': select Yes or No.';
    }
    return msg;
  }

  function setFieldError(key, msg) {
    const t = targetsFor(key);
    if (!t.error) return;
    if (msg) {
      state.errors.set(key, msg);
      t.error.textContent = '';
      t.error.appendChild(h('span', { className: 'ap-error-label', text: 'Error:' }));
      t.error.appendChild(document.createTextNode(' ' + msg));
      t.error.hidden = false;
      t.invalid.forEach((el) => el.setAttribute('aria-invalid', 'true'));
      t.described.forEach((el) => { if (el) addToken(el, 'aria-describedby', t.error.id); });
      if (t.box) t.box.classList.add('has-error');
      updateSummaryItem(key, msg);
    } else {
      state.errors.delete(key);
      t.error.textContent = '';
      t.error.hidden = true;
      t.invalid.forEach((el) => el.setAttribute('aria-invalid', 'false'));
      t.described.forEach((el) => { if (el) removeToken(el, 'aria-describedby', t.error.id); });
      if (t.box) t.box.classList.remove('has-error');
      removeSummaryItem(key);
    }
  }

  function clearErrors(keys) {
    keys.forEach((k) => {
      if (state.errors.has(k)) setFieldError(k, '');
    });
  }

  function validateKey(key) {
    if (!hasOwn(validators, key)) return '';
    const msg = validators[key]();
    setFieldError(key, msg);
    return msg;
  }

  // A field is validated when it loses focus. When that happens because the mouse was just
  // pressed on another control, showing (or removing) the field's error message right away
  // would move that control before the button is released, and the click would be lost.
  // Such validation therefore waits until the click has been delivered (pointerup, or 1 s at
  // the latest). Keyboard and touch input are validated immediately.
  const press = { at: -1e9, keys: [], timer: 0 };

  function onPointerDown(e) {
    if (e.target && e.target.tagName === 'SELECT') return; // its menu opens on press
    press.at = Date.now();
  }

  function flushPressValidation() {
    clearTimeout(press.timer);
    press.timer = 0;
    press.at = -1e9;
    const keys = press.keys;
    press.keys = [];
    if (!state.submitted) keys.forEach(validateKey);
  }

  function onPointerUp() {
    if (press.keys.length) setTimeout(flushPressValidation, 0); // runs after the click event
    else press.at = -1e9;
  }

  function validateOnBlur(key) {
    if (Date.now() - press.at > 500) {
      validateKey(key);
      return;
    }
    if (press.keys.indexOf(key) < 0) press.keys.push(key);
    if (!press.timer) press.timer = setTimeout(flushPressValidation, 1000);
  }

  function validateAll() {
    const problems = [];
    Object.keys(validators).forEach((key) => {
      const msg = validateKey(key);
      if (msg) problems.push({ key: key, msg: msg });
    });
    return problems;
  }

  function summaryTitle(n) {
    return n === 1 ? 'Please fix 1 problem before submitting:' : 'Please fix ' + n + ' problems before submitting:';
  }

  function renderSummary(problems) {
    const box = $('ap-error-summary');
    box.textContent = '';
    box.appendChild(h('h3', { className: 'ap-summary-title', text: summaryTitle(problems.length) }));
    const list = h('ul');
    problems.forEach((p) => {
      const target = targetsFor(p.key).focus;
      list.appendChild(h('li', { 'data-key': p.key }, [
        h('a', { href: '#' + (target ? target.id : 'jdp-form'), 'data-key': p.key, text: summaryText(p.key, p.msg) })
      ]));
    });
    box.appendChild(list);
    box.hidden = false;
  }

  function hideSummary() {
    const box = $('ap-error-summary');
    box.hidden = true;
    box.textContent = '';
  }

  function updateSummaryItem(key, msg) {
    const box = $('ap-error-summary');
    if (box.hidden) return;
    const link = box.querySelector('a[data-key="' + key + '"]');
    if (link) link.textContent = summaryText(key, msg);
  }

  function removeSummaryItem(key) {
    const box = $('ap-error-summary');
    if (box.hidden) return;
    const item = box.querySelector('li[data-key="' + key + '"]');
    if (item) item.remove();
    const left = box.querySelectorAll('li').length;
    if (!left) {
      hideSummary();
      return;
    }
    const title = box.querySelector('h3');
    if (title) title.textContent = summaryTitle(left);
  }

  function focusKey(key) {
    const t = targetsFor(key);
    if (!t.focus) return;
    focusEl(t.focus);
    const anchor = t.box || t.focus;
    if (anchor.scrollIntoView) anchor.scrollIntoView({ block: 'center', behavior: smooth() });
  }

  /* ------------------------------------------------------------------
     Documents (PDF uploads)
  ------------------------------------------------------------------ */

  function includedFileKeys() {
    const bs = isBS();
    return FILES.map((f) => f.key).filter((k) => !(k === 'transcript_grad' && bs));
  }

  function totalBytes(exceptKey) {
    return includedFileKeys().reduce((sum, k) => (k !== exceptKey && state.files[k] ? sum + state.files[k].size : sum), 0);
  }

  function readMagic(file) {
    return new Promise((resolve) => {
      let reader;
      try {
        reader = new FileReader();
      } catch (e) {
        resolve(false);
        return;
      }
      reader.onload = () => {
        const b = new Uint8Array(reader.result || new ArrayBuffer(0));
        // "%PDF-"
        resolve(b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d);
      };
      reader.onerror = () => resolve(false);
      reader.readAsArrayBuffer(file.slice(0, 5));
    });
  }

  function checkFile(file, key) {
    const name = file.name || 'This file';
    const quoted = '“' + name + '”';
    if (!/\.pdf$/i.test(name)) return Promise.resolve(quoted + ' is not a PDF. Please upload a .pdf file.');
    const type = (file.type || '').toLowerCase();
    if (type && type.indexOf('pdf') < 0 && type !== 'application/octet-stream') {
      return Promise.resolve(quoted + ' is not a PDF. Please upload a .pdf file.');
    }
    if (!file.size) return Promise.resolve(quoted + ' is empty. Please choose another file.');
    if (file.size > MAX_FILE_MB * MB) {
      return Promise.resolve(quoted + ' is ' + formatBytes(file.size) + '. Each file must be ' + MAX_FILE_MB + ' MB or smaller.');
    }
    const total = totalBytes(key) + file.size;
    if (total > MAX_TOTAL_MB * MB) {
      return Promise.resolve('Adding ' + quoted + ' would bring your documents to ' + formatBytes(total) + '. All files together must be ' + MAX_TOTAL_MB + ' MB or less.');
    }
    return readMagic(file).then((ok) => (ok ? '' : quoted + ' does not appear to be a valid PDF. Please save or export it as a PDF and try again.'));
  }

  function handleFile(input) {
    const key = input.name.replace(/^file_/, '');
    const file = input.files && input.files[0];
    const token = (state.fileTokens[key] || 0) + 1;
    state.fileTokens[key] = token;
    state.files[key] = null;
    delete state.fileErrors[key];
    if (!file) {
      renderFileStatus(key);
      updateFilesTotal();
      if (state.errors.has('file_' + key) || state.submitAttempted) validateKey('file_' + key);
      return;
    }
    renderFileStatus(key, 'Checking “' + file.name + '”…');
    const check = checkFile(file, key).catch(() => '“' + file.name + '” could not be read. Please choose it again.').then((err) => {
      if (state.fileTokens[key] !== token) return;
      if (err) {
        input.value = '';
        state.fileErrors[key] = err;
      } else {
        state.files[key] = file;
      }
      renderFileStatus(key);
      updateFilesTotal();
      validateKey('file_' + key);
    });
    state.fileChecks[key] = check;
    const done = () => {
      if (state.fileChecks[key] === check) delete state.fileChecks[key];
    };
    check.then(done, done);
  }

  function removeFile(key, silent) {
    const input = $('file_' + key);
    state.fileTokens[key] = (state.fileTokens[key] || 0) + 1;
    state.files[key] = null;
    delete state.fileErrors[key];
    delete state.fileChecks[key];
    if (input) input.value = '';
    renderFileStatus(key);
    updateFilesTotal();
    if (state.errors.has('file_' + key) || state.submitAttempted) validateKey('file_' + key);
    if (!silent && input) input.focus();
  }

  function renderFileStatus(key, pendingText) {
    const status = $('file_' + key + '-status');
    const box = $('file-field-' + key);
    const remove = form.querySelector('[data-remove="' + key + '"]');
    if (!status || !box) return;
    const file = state.files[key];
    box.classList.toggle('has-file', !!file);
    if (pendingText) {
      status.textContent = pendingText;
      if (remove) remove.hidden = true;
      return;
    }
    if (file) {
      status.textContent = file.name + ' · ' + formatBytes(file.size);
    } else if (state.fileErrors[key]) {
      // The status is a live region: a rejected file is announced together with the reason
      // (shown on screen in the error line below, so it is visually hidden here).
      status.textContent = 'Not attached';
      status.appendChild(h('span', { className: 'ap-vh', text: ': ' + state.fileErrors[key] }));
    } else {
      status.textContent = 'No file selected';
    }
    if (remove) {
      remove.hidden = !file && !state.fileErrors[key];
      remove.textContent = file ? 'Remove' : 'Clear';
      remove.setAttribute('aria-label', (file ? 'Remove ' : 'Clear ') + fileTitle(key));
    }
  }

  function fileTitle(key) {
    const title = $('file_' + key + '-title');
    const first = title && title.firstChild;
    return first && first.nodeType === 3 ? first.textContent.trim() : 'file';
  }

  function updateFilesTotal() {
    const out = $('ap-files-total');
    if (!out) return;
    const total = totalBytes(null);
    out.textContent = 'Total: ' + (total ? formatBytes(total) : '0 MB') + ' of ' + MAX_TOTAL_MB + ' MB';
    out.classList.toggle('is-over', total > MAX_TOTAL_MB * MB);
  }

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || '');
        const comma = s.indexOf(',');
        const data = comma >= 0 ? s.slice(comma + 1) : '';
        // Base64 of "%PDF-" starts with "JVBERi0".
        if (data.indexOf('JVBERi0') !== 0) reject(new Error('not a pdf'));
        else resolve(data);
      };
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  function readAllFiles() {
    const included = includedFileKeys();
    const jobs = FILES.map((f) => {
      const file = state.files[f.key];
      if (!file || included.indexOf(f.key) < 0) return Promise.resolve([f.key, null]);
      return readBase64(file).then((data) => [f.key, { name: file.name, type: 'application/pdf', size: file.size, data: data }]);
    });
    return Promise.all(jobs).then((pairs) => {
      const out = {};
      pairs.forEach((p) => { out[p[0]] = p[1]; });
      return out;
    });
  }

  /* ------------------------------------------------------------------
     Draft autosave: one draft per link (localStorage; every access in try/catch).
     Drafts never hold files or the email address and expire after 30 days.
  ------------------------------------------------------------------ */

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      /* storage unavailable: nothing to remove */
    }
  }

  function storageKeys() {
    const out = [];
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k) out.push(k);
      }
    } catch (e) {
      /* storage unavailable */
    }
    return out;
  }

  function readDraftAt(key) {
    const raw = storageGet(key);
    if (!raw) return null;
    try {
      const d = JSON.parse(raw);
      return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
    } catch (e) {
      return null;
    }
  }

  function isFresh(draft) {
    const t = Date.parse(draft && draft.saved_at);
    return !isNaN(t) && Date.now() - t <= DRAFT_MAX_AGE_MS;
  }

  // Remove the old public form's draft and every expired draft (on a shared computer the next
  // person must not find an earlier applicant's answers).
  function purgeDrafts() {
    LEGACY_DRAFT_KEYS.forEach(storageRemove);
    storageKeys().forEach((k) => {
      if (k.indexOf(DRAFT_PREFIX) === 0 && !isFresh(readDraftAt(k))) storageRemove(k);
    });
  }

  // The draft for this link; or, if the applicant requested a new link, the newest draft saved
  // under an earlier link for the same verified email (it is moved to this link's key).
  function loadDraft() {
    const own = readDraftAt(state.draftKey);
    if (own && isFresh(own)) return own;
    if (own) storageRemove(state.draftKey);
    const mine = storageKeys().filter((k) => k.indexOf(DRAFT_PREFIX) === 0 && k !== state.draftKey)
      .map((k) => ({ key: k, draft: readDraftAt(k) }))
      .filter((x) => x.draft && isFresh(x.draft) && x.draft.owner === state.owner);
    if (!mine.length) return null;
    mine.sort((a, b) => Date.parse(b.draft.saved_at) - Date.parse(a.draft.saved_at));
    mine.forEach((x) => storageRemove(x.key));
    storageSet(state.draftKey, JSON.stringify(mine[0].draft));
    return mine[0].draft;
  }

  function defaultOf(el) {
    if (el.tagName !== 'SELECT') return el.defaultValue;
    const opts = Array.prototype.slice.call(el.options);
    const def = opts.filter((o) => o.defaultSelected)[0] || opts[0];
    return def ? def.value : '';
  }

  function draftable(el) {
    if (!el.name || el.readOnly) return false; // the verified email is never stored
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return false;
    const type = el.type;
    return type !== 'file' && type !== 'submit' && type !== 'button' && type !== 'reset' && type !== 'hidden';
  }

  function collectDraft() {
    const fields = {};
    Array.prototype.forEach.call(form.elements, (el) => {
      if (!draftable(el)) return;
      if (el.type === 'checkbox') fields['cb:' + el.name + ':' + el.value] = el.checked;
      else if (el.type === 'radio') {
        if (el.checked) fields['r:' + el.name] = el.value;
      } else fields[el.name] = el.value;
    });
    return { v: 2, saved_at: new Date().toISOString(), started_at: state.startedAt, owner: state.owner, fields: fields };
  }

  function restoreDraft() {
    const draft = loadDraft();
    if (!draft) return null;
    if (typeof draft.started_at === 'string' && !isNaN(Date.parse(draft.started_at))) state.startedAt = draft.started_at;
    const fields = draft.fields && typeof draft.fields === 'object' ? draft.fields : {};
    let restored = 0;
    Array.prototype.forEach.call(form.elements, (el) => {
      if (!draftable(el)) return;
      if (el.type === 'checkbox') {
        const k = 'cb:' + el.name + ':' + el.value;
        if (hasOwn(fields, k)) {
          el.checked = fields[k] === true;
          if (el.checked) restored += 1;
        }
      } else if (el.type === 'radio') {
        const k = 'r:' + el.name;
        if (hasOwn(fields, k)) el.checked = fields[k] === el.value;
      } else if (hasOwn(fields, el.name) && typeof fields[el.name] === 'string') {
        const v = fields[el.name];
        if (el.tagName === 'SELECT') {
          if (Array.prototype.some.call(el.options, (o) => o.value === v)) el.value = v;
        } else {
          el.value = v;
        }
        if (v !== defaultOf(el)) restored += 1;
      }
    });
    // Never more than the allowed number of interests, even from an edited draft.
    let seen = 0;
    interestBoxes().forEach((b) => {
      if (b.checked) {
        seen += 1;
        if (seen > MAX_INTERESTS) b.checked = false;
      }
    });
    return restored > 0 ? draft : null;
  }

  function scheduleSave() {
    if (state.submitted) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveDraft, 400);
  }

  function saveDraft() {
    state.saveTimer = 0;
    if (state.submitted || !state.draftKey) return;
    const ok = storageSet(state.draftKey, JSON.stringify(collectDraft()));
    const status = $('ap-draft-status');
    if (!status) return;
    if (ok) {
      const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      status.textContent = 'Draft saved in this browser at ' + time + ' (uploaded files are not saved).';
    } else {
      status.textContent = 'This browser is not allowing drafts to be saved, so please complete the form in one sitting.';
    }
  }

  function flushDraft() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      saveDraft();
    }
  }

  function clearDraftAndReset() {
    if (!window.confirm('Clear your saved draft and reset every answer on this form?')) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    press.keys = []; // nothing left to validate on the emptied form
    storageRemove(state.draftKey);
    form.reset(); // names go back to the invitation's values; the verified email stays
    FILES.forEach((f) => {
      state.fileTokens[f.key] = (state.fileTokens[f.key] || 0) + 1;
      state.files[f.key] = null;
      delete state.fileErrors[f.key];
      delete state.fileChecks[f.key];
    });
    Array.from(state.errors.keys()).forEach((k) => setFieldError(k, ''));
    hideSummary();
    state.submitAttempted = false;
    state.startedAt = new Date().toISOString();
    refreshAll();
    removeNotice('ap-restored');
    setShown('ap-files-reattach', false);
    const status = $('ap-draft-status');
    if (status) status.textContent = 'Saved draft cleared. Your answers are saved in this browser as you type (uploaded files are not saved).';
    focusEl($('first_name'));
  }

  /* ------------------------------------------------------------------
     Notices above the form
  ------------------------------------------------------------------ */

  // attrs: extra attributes, set before the notice enters the page (e.g. role="alert", which
  // screen readers announce when such an element appears).
  function showNotice(kind, id, paragraphs, attrs) {
    const box = $('ap-notices');
    removeNotice(id);
    const notice = h('div', Object.assign({ className: 'ap-notice ap-notice-' + kind, id: id }, attrs || {}));
    paragraphs.forEach((parts) => notice.appendChild(h('p', null, parts)));
    box.appendChild(notice);
    return notice;
  }

  function removeNotice(id) {
    const old = $(id);
    if (old) old.remove();
  }

  // The deadline passed (or the server closed intake) while the form was open. The notice is an
  // alert and takes the focus, so that screen-reader users hear why the button does nothing.
  function showClosedNotice() {
    state.closed = true;
    const label = closedDateLabel();
    const notice = showNotice('warn', 'ap-availability', [
      [h('strong', { text: 'Applications are closed.' }), ' The Smart Grid Lab application for ' + ((CFG && CFG.cycle) || 'Fall 2027') +
        ' closed' + (label ? ' on ' + label : '') + ', so this form can no longer be submitted. Thank you for your interest.']
    ], { role: 'alert', tabindex: '-1' });
    const note = $('ap-submit-note');
    note.textContent = 'Applications are closed; this form can no longer be submitted.';
    note.hidden = false;
    $('ap-submit').setAttribute('aria-disabled', 'true');
    focusEl(notice);
    if (notice.scrollIntoView) notice.scrollIntoView({ block: 'center', behavior: smooth() });
  }

  /* ------------------------------------------------------------------
     Payload (data contract "sgl-jdp-application" v2)
  ------------------------------------------------------------------ */

  function countValue(name) {
    const n = Number(rawVal(name).trim() || 0);
    return isFinite(n) ? Math.min(200, Math.max(0, Math.round(n))) : 0;
  }

  function yearsValue(name) {
    const n = Number(rawVal(name).trim() || 0);
    return isFinite(n) ? Math.min(50, Math.max(0, Math.round(n * 10) / 10)) : 0;
  }

  function elapsedMs() {
    const started = Date.parse(state.startedAt);
    return isNaN(started) ? 0 : Math.max(0, Date.now() - started);
  }

  function buildPayload(files) {
    const bs = isBS();
    const now = new Date();
    const englishType = val('english_type');
    const scored = hasOwn(ENGLISH, englishType);
    const greTaken = radioVal('gre_taken') === 'yes' ? 'yes' : 'no';
    const thesis = bs ? '' : radioVal('grad_thesis');
    const decimal = (s) => s.replace(',', '.');

    return {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      invite: state.token,
      cycle: String((CFG && CFG.cycle) || ''),
      client: {
        started_at: state.startedAt,
        submitted_at: now.toISOString(),
        elapsed_seconds: Math.round(elapsedMs() / 1000),
        user_agent: String(navigator.userAgent || '')
      },
      hp: '',
      applicant: {
        first_name: val('first_name'),
        last_name: val('last_name'),
        email: val('email'),
        phone: val('phone'),
        city: val('city'),
        country: val('country'),
        current_position: val('current_position'),
        current_institution: val('current_institution'),
        linkedin: val('linkedin'),
        scholar: val('scholar'),
        github: val('github'),
        website: val('website'),
        start_term: val('start_term'),
        heard_from: val('heard_from')
      },
      education: {
        highest_degree: val('highest_degree'),
        undergrad: {
          institution: val('ug_institution'),
          major: val('ug_major'),
          grad_year: val('ug_grad_year'),
          gpa: decimal(val('ug_gpa')),
          gpa_scale: val('ug_gpa_scale')
        },
        grad: bs
          ? { institution: '', major: '', grad_year: '', gpa: '', gpa_scale: '', thesis: '', thesis_title: '' }
          : {
            institution: val('grad_institution'),
            major: val('grad_major'),
            grad_year: val('grad_grad_year'),
            gpa: decimal(val('grad_gpa')),
            gpa_scale: val('grad_gpa_scale'),
            thesis: thesis,
            thesis_title: thesis === 'yes' ? val('grad_thesis_title') : ''
          },
        english_test: { type: englishType, score: scored ? decimal(val('english_score')) : '' },
        gre: {
          taken: greTaken,
          quant: greTaken === 'yes' ? val('gre_quant') : '',
          verbal: greTaken === 'yes' ? val('gre_verbal') : '',
          awa: greTaken === 'yes' ? val('gre_awa') : ''
        }
      },
      research: {
        journal_papers: countValue('journal_papers'),
        journal_first_author: countValue('journal_first_author'),
        conference_papers: countValue('conference_papers'),
        conference_first_author: countValue('conference_first_author'),
        research_years: yearsValue('research_years'),
        industry_years: yearsValue('industry_years'),
        interests: checkedInterests().slice(0, MAX_INTERESTS),
        statement: val('statement'),
        why_lab: val('why_lab'),
        code_links: val('code_links')
      },
      yesno: Q.yesno.map((q) => ({ id: q.id, label: q.label, value: radioVal('yn_' + q.id) })),
      confidence: confidenceItems().map((it) => ({
        id: it.id,
        label: it.label,
        group: it.group,
        value: clampInt($('conf-' + it.id).value, 0, 10)
      })),
      courses: Q.courses.map((c) => {
        const base = 'course_' + c.id;
        const taken = isChecked(base);
        return {
          id: c.id,
          label: c.label,
          taken: taken,
          level: taken ? val(base + '_level') : '',
          grade: taken ? val(base + '_grade') : ''
        };
      }),
      other_courses: val('other_courses'),
      consent: { accurate: isChecked('consent_accurate'), privacy: isChecked('consent_privacy') },
      files: files
    };
  }

  /* ------------------------------------------------------------------
     Sending
  ------------------------------------------------------------------ */

  function isSameOrigin(url) {
    try {
      return new URL(url, window.location.href).origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }

  function showProgress(text, fraction) {
    const box = $('ap-progress');
    const bar = $('ap-progress-bar');
    const track = $('ap-progress-track');
    box.hidden = false;
    if (fraction === null || fraction === undefined) {
      box.classList.add('is-indeterminate');
      bar.style.width = '';
      track.removeAttribute('aria-valuenow');
    } else {
      const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      box.classList.remove('is-indeterminate');
      bar.style.width = pct + '%';
      track.setAttribute('aria-valuenow', String(pct));
    }
    if (text !== null && text !== undefined) $('ap-progress-text').textContent = text;
  }

  // While sending, the button is marked aria-disabled instead of disabled so that keyboard
  // focus stays on it (a disabled button drops focus to <body>); state.sending blocks clicks.
  function setSending(on) {
    state.sending = on;
    const btn = $('ap-submit');
    if (on || state.closed) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
    btn.textContent = on ? 'Submitting…' : 'Submit application';
    form.setAttribute('aria-busy', on ? 'true' : 'false');
    if (!on) $('ap-progress').hidden = true;
  }

  function post(url, body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
      xhr.timeout = XHR_TIMEOUT_MS;
      const size = formatBytes(body.length);
      // Upload-progress listeners make browsers send a CORS preflight, which Apps Script cannot
      // answer, so real progress is only shown for same-origin endpoints (local_server.py).
      if (isSameOrigin(url) && xhr.upload) {
        let lastStep = -1;
        showProgress('Uploading your application (' + size + ')… 0%', 0);
        xhr.upload.addEventListener('progress', (ev) => {
          if (!ev.lengthComputable || !ev.total) return;
          const f = ev.loaded / ev.total;
          const step = Math.floor(f * 10);
          showProgress(step !== lastStep ? 'Uploading your application (' + size + ')… ' + Math.round(f * 100) + '%' : null, f);
          lastStep = step;
        });
      } else {
        showProgress('Uploading your application (' + size + ')… Please keep this page open.', null);
      }
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 2) showProgress('Upload complete. Waiting for confirmation…', null);
      };
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new Error('network'));
      xhr.ontimeout = () => reject(new Error('timeout'));
      xhr.onabort = () => reject(new Error('abort'));
      xhr.send(body);
    });
  }

  function showSubmitError(message, joinLink) {
    const box = $('ap-submit-error');
    box.textContent = '';
    box.appendChild(h('p', null, [h('strong', { text: 'Error: your application was not submitted.' }), ' ' + message]));
    if (joinLink) {
      box.appendChild(h('p', null, [
        'Your answers are still saved in this browser. ',
        h('a', { href: '/join/#request_your_application_link', text: 'Request a new link on the Join page' }),
        ' and open it in this browser to continue.'
      ]));
    }
    box.hidden = false;
    if (box.scrollIntoView) box.scrollIntoView({ block: 'center', behavior: smooth() });
  }

  function handleResponse(res) {
    let data = null;
    try {
      data = JSON.parse(res.text);
    } catch (e) {
      data = null;
    }
    if (res.status >= 200 && res.status < 300 && data && data.ok === true) {
      showSuccess(typeof data.id === 'string' || typeof data.id === 'number' ? String(data.id) : '');
      return;
    }
    let message;
    if (data && typeof data.error === 'string' && data.error.trim()) message = data.error.trim().slice(0, 300);
    else if (res.status === 413) message = 'Your files are too large to upload. Please reduce their size and try again.';
    else if (!data) message = 'The server sent an unexpected response (HTTP ' + res.status + '). Please try again later.';
    else message = 'The server could not accept your application. Please try again later.';
    if (message && !/[.!?]$/.test(message)) message += '.';
    setSending(false);
    if (/\bclosed\b/i.test(message)) {
      showClosedNotice();
      return;
    }
    flushDraft();
    showSubmitError(message, /\blink\b/i.test(message) && /invalid|expired/i.test(message));
  }

  function handleFailure(err) {
    const kind = err && err.message;
    let message = 'We could not reach the server. Please check your internet connection and try again later.';
    if (kind === 'timeout') message = 'The upload took too long and timed out. Please check your connection and try again later.';
    setSending(false);
    flushDraft();
    showSubmitError(message, false);
  }

  function showSuccess(id) {
    state.submitted = true;
    clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    storageRemove(state.draftKey);
    setSending(false);
    const first = val('first_name');
    $('ap-confirm-name').textContent = first ? ', ' + first : '';
    $('ap-confirm-id').textContent = id || 'not provided';
    form.hidden = true;
    setShown('ap-app', false);
    state.files = {};
    const panel = $('ap-confirmation');
    panel.hidden = false;
    focusEl(panel);
    if (panel.scrollIntoView) panel.scrollIntoView({ block: 'start', behavior: smooth() });
  }

  function onSubmit(e) {
    e.preventDefault();
    if (state.sending || state.submitted) return;
    if (state.closed || isPastDeadline()) {
      showClosedNotice();
      return;
    }
    $('ap-submit-error').hidden = true;
    state.submitAttempted = true;

    const send = () => {
      showProgress('Preparing your files…', null);
      readAllFiles().then((files) => {
        const body = JSON.stringify(buildPayload(files));
        return post(actionUrl('submit'), body).then(handleResponse, handleFailure);
      }, () => {
        throw new Error('file-read');
      }).catch((err) => {
        // Never leave the form stuck in the "Submitting…" state.
        setSending(false);
        showSubmitError(err && err.message === 'file-read'
          ? 'One of your files could not be read. Please attach it again.'
          : 'Something went wrong while preparing your application. Please try again later.', false);
      });
    };

    const proceed = () => {
      const problems = validateAll();
      if (problems.length) {
        renderSummary(problems);
        focusKey(problems[0].key);
        return;
      }
      hideSummary();
      if (!actionUrl('submit')) {
        showSubmitError('Online submission is not available right now. Please try again later.', false);
        return;
      }
      setSending(true);
      const wait = MIN_SUBMIT_ELAPSED_MS - elapsedMs();
      if (wait > 0) {
        showProgress('Preparing your application…', null);
        setTimeout(send, wait);
      } else {
        send();
      }
    };

    // Let any PDF checks that are still running finish first.
    const pending = Object.keys(state.fileChecks).map((k) => state.fileChecks[k]);
    if (!pending.length) {
      proceed();
      return;
    }
    setSending(true);
    showProgress('Checking your files…', null);
    Promise.all(pending).catch(() => null).then(() => {
      setSending(false);
      proceed();
    });
  }

  /* ------------------------------------------------------------------
     Events
  ------------------------------------------------------------------ */

  function onFieldEvent(e) {
    const t = e.target;
    if (!t || !t.name || state.submitted || t.readOnly) return;
    if (t.type === 'file') {
      if (e.type === 'change') handleFile(t);
      return;
    }
    if (e.type === 'change' && URL_FIELDS.indexOf(t.name) >= 0) normalizeUrl(t);
    if (e.type === 'change' && DECIMAL_FIELDS.indexOf(t.name) >= 0 && /^\d+,\d+$/.test(t.value.trim())) {
      t.value = t.value.trim().replace(',', '.');
    }
    updateUIFor(t);
    // A text field's "change" fires when it loses focus (see validateOnBlur).
    const validate = e.type === 'change' ? validateOnBlur : validateKey;
    const key = keyFor(t);
    if (key && (state.errors.has(key) || (state.submitAttempted && e.type === 'change'))) validate(key);
    (LINKED[t.name] || []).forEach((k) => {
      if (state.errors.has(k)) validate(k);
    });
    scheduleSave();
  }

  function onFocusOut(e) {
    const t = e.target;
    if (!t || !t.name || state.submitted || t.readOnly) return;
    const type = t.type;
    if (type === 'file' || type === 'radio' || type === 'checkbox' || type === 'range' || t.tagName === 'TEXTAREA') {
      if (!(state.submitAttempted && t.tagName === 'TEXTAREA')) return;
    }
    const key = keyFor(t);
    if (!key) return;
    if (state.submitAttempted || String(t.value).trim() !== '') validateOnBlur(key);
  }

  // Pressing Enter in a text box should not submit this long form by accident.
  function onKeyDown(e) {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t && t.tagName === 'INPUT' && ['submit', 'button', 'file', 'reset'].indexOf(t.type) < 0) e.preventDefault();
  }

  function onClick(e) {
    const target = e.target;
    if (!target || !target.closest) return;
    const remove = target.closest('[data-remove]');
    if (remove) {
      e.preventDefault();
      removeFile(remove.getAttribute('data-remove'), false);
      return;
    }
    if (target.closest('#ap-clear-draft')) {
      e.preventDefault();
      clearDraftAndReset();
    }
  }

  function onSummaryClick(e) {
    const link = e.target && e.target.closest ? e.target.closest('a[data-key]') : null;
    if (!link) return;
    e.preventDefault();
    focusKey(link.getAttribute('data-key'));
  }

  /* ------------------------------------------------------------------
     Start-up: token -> invite -> form
  ------------------------------------------------------------------ */

  // The personal link's token is kept for this tab only (sessionStorage, gone when the tab is
  // closed) and taken out of the address bar and of this page's history entry, so it does not
  // sit in the URL for screenshots, the back button or the next person at a shared computer.
  // A reload of the tab still finds it.
  const TOKEN_KEY = 'sgl-jdp-link';

  function sessionGet(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function sessionSet(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
      return window.sessionStorage.getItem(key) === value;
    } catch (e) {
      return false;
    }
  }

  function sessionRemove(key) {
    try {
      window.sessionStorage.removeItem(key);
    } catch (e) {
      /* storage unavailable: nothing to remove */
    }
  }

  function readToken() {
    let fromUrl = null;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has('t')) fromUrl = params.get('t') || '';
    } catch (e) {
      fromUrl = null;
    }
    if (fromUrl === null) { // opened without ?t=: a reload after the address bar was cleaned
      const saved = String(sessionGet(TOKEN_KEY) || '').trim().toLowerCase();
      return TOKEN_RE.test(saved) ? saved : '';
    }
    const t = fromUrl.trim().toLowerCase();
    if (!TOKEN_RE.test(t)) return '';
    // Only drop it from the URL once it is safely stored, or a reload would lose the link.
    if (sessionSet(TOKEN_KEY, t)) {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      } catch (e) {
        /* the address bar keeps the link */
      }
    }
    return t;
  }

  function getJson(url) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0;
    const request = fetch(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then((res) => res.text().then((text) => {
      try {
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    }));
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (ctrl) ctrl.abort();
        reject(new Error('timeout'));
      }, LOAD_TIMEOUT_MS);
    });
    return Promise.race([request, timeout]).then((data) => {
      clearTimeout(timer);
      return data;
    }, (err) => {
      clearTimeout(timer);
      throw err;
    });
  }

  function loadInvite() {
    showState('ap-loading');
    getJson(inviteUrl(state.token)).then((data) => {
      if (data && data.ok === true && data.invite && typeof data.invite === 'object' && data.form && typeof data.form === 'object') {
        start(data);
        return;
      }
      const error = data && typeof data.error === 'string' ? data.error : '';
      if (data && data.ok === false && /\bclosed\b/i.test(error)) showClosedState();
      else if (data && data.ok === false && /invalid|expired/i.test(error)) {
        if (sessionGet(TOKEN_KEY) === state.token) sessionRemove(TOKEN_KEY);
        showState('ap-state-invalid');
      } else showLoadError('We could not load your application right now.', 'Please check your internet connection and try again later.', true);
    }, () => {
      showLoadError('We could not load your application right now.', 'Please check your internet connection and try again later.', true);
    });
  }

  function applyInvite(invite) {
    const first = plainName(invite.first_name);
    const prefill = (id, value) => {
      const el = $(id);
      if (!el) return;
      // defaultValue as well, so "Clear saved draft" (form.reset) returns to the invitation's values.
      el.defaultValue = value;
      el.value = value;
    };
    prefill('first_name', first);
    prefill('last_name', plainName(invite.last_name));
    prefill('email', str(invite.email, 254));
    const email = $('email');
    if (email) email.readOnly = true; // verified address; the server uses the invitation's email anyway
    $('ap-welcome-name').textContent = first ? ', ' + first : '';
    const until = formatDate(invite.expires_at);
    $('ap-expiry').textContent = until ? ', valid until ' + until + ' (' + zoneLabel() + ')' : '';
  }

  function start(data) {
    try {
      if (!validBank(data.form.questions) || typeof data.form.template !== 'string') throw new Error('bad form data');
      Q = data.form.questions;
      const node = buildForm(data.form.template);
      if (!node) throw new Error('no form in the template');
      const slot = $('ap-form-slot');
      slot.textContent = '';
      slot.appendChild(node);
      form = node;
      state.invite = data.invite;

      scaleWords = readScaleWords();
      renderInterests();
      renderYesNo();
      renderConfidence();
      renderCourses();
      fillStaticText();
      initAriaInvalid();
      validators = buildValidators();
      applyInvite(data.invite);

      state.draftKey = DRAFT_PREFIX + sha256Hex(state.token).slice(0, 8);
      state.owner = sha256Hex('sgl-jdp-owner:' + val('email').toLowerCase()).slice(0, 16);
      const draft = restoreDraft();
      refreshAll();
      if (draft) {
        const when = typeof draft.saved_at === 'string' && !isNaN(Date.parse(draft.saved_at))
          ? ' on ' + new Date(draft.saved_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : '';
        showNotice('info', 'ap-restored', [
          ['We restored the answers you saved in this browser' + when + '. Uploaded files are not saved, so please attach them again.']
        ]);
        setShown('ap-files-reattach', true);
      }

      form.addEventListener('input', onFieldEvent);
      form.addEventListener('change', onFieldEvent);
      form.addEventListener('focusout', onFocusOut);
      form.addEventListener('keydown', onKeyDown);
      form.addEventListener('click', onClick);
      form.addEventListener('submit', onSubmit);
      $('ap-error-summary').addEventListener('click', onSummaryClick);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('pointercancel', onPointerUp, true);
      window.addEventListener('pagehide', flushDraft);

      showState('ap-app');
      form.hidden = false;
    } catch (err) {
      if (form) form.hidden = true;
      const slot = $('ap-form-slot');
      if (slot) slot.textContent = '';
      showLoadError('We could not load your application right now.', 'Please try again later.');
      if (window.console && console.warn) console.warn('JDP application failed to start:', err);
    }
  }

  function init() {
    if (!$('ap-form-slot')) return;
    purgeDrafts();
    const retry = $('ap-retry');
    if (retry) retry.addEventListener('click', () => {
      if (state.token && inviteUrl(state.token)) loadInvite();
    });
    if (!CFG) {
      showLoadError('We could not load your application right now.', 'Please try again later.');
      return;
    }
    if (isPastDeadline()) {
      showClosedState();
      return;
    }
    state.token = readToken();
    if (!state.token) {
      showState('ap-state-invalid');
      return;
    }
    if (!inviteUrl(state.token)) {
      showLoadError('The online application is not open yet.', 'Please try again later.');
      return;
    }
    loadInvite();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
