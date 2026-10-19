/*
 * Smart Grid Lab – "Request your application link" form on the Join page.
 *
 * Vanilla JavaScript, no dependencies, no build step. Reads window.JDP_APPLY_CONFIG
 * (apply-config.js), validates the name / email / consent fields and sends a
 * "sgl-jdp-request" v2 request. The server answers every valid request with the same
 * generic message (it never reveals whether an address is known) and emails a personal
 * link to the private application page.
 *
 * Endpoint rule (identical to apply.js and the servers): on localhost / 127.0.0.1 the
 * request goes to the same-origin /api/request of local_server.py; everywhere else to
 * {endpoint}?action=request (POST, text/plain JSON = a CORS "simple request", which Google
 * Apps Script requires).
 *
 * Safety rules: no innerHTML, no inline handlers; text from the server or the applicant is
 * inserted with textContent only.
 */
(() => {
  'use strict';

  const CFG = window.JDP_APPLY_CONFIG || null;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // The server quietly ignores requests sent less than 3 s after the page was opened (a bot
  // signal). A person whose browser autofills everything could be that fast, so the request
  // is held back until this much time has passed instead of being silently dropped.
  const MIN_ELAPSED_MS = 3500;
  const REQUEST_TIMEOUT_MS = 60 * 1000;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const loadedAt = Date.now();

  const $ = (id) => document.getElementById(id);
  let form = null;
  let sending = false;

  /* ------------------------------------------------------------------
     Configuration helpers (keep in sync with apply.js)
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

  // The deadline closes at 23:59:59.999 on the deadline day in CFG.deadlineTimeZone (Pacific
  // time by default), for every applicant wherever they are. Returns a UTC timestamp or null.
  function deadlineEnd() {
    const d = parseDeadline();
    if (!d) return null;
    const zone = String((CFG && CFG.deadlineTimeZone) || 'America/Los_Angeles');
    const wall = Date.UTC(d.y, d.m - 1, d.d, 23, 59, 59, 999);
    let ts = wall;
    for (let i = 0; i < 3; i += 1) {
      const offset = zoneOffset(ts, zone);
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

  /* ------------------------------------------------------------------
     Page states
  ------------------------------------------------------------------ */

  // The invitation to request a link and the closing-date line only make sense while the form
  // is offered; they are hidden when it is not.
  function hideRequestIntro() {
    ['ap-request-intro', 'ap-request-meta'].forEach((id) => {
      const el = $(id);
      if (el) el.hidden = true;
    });
  }

  // announce: the state follows the applicant's own action (a submit), so focus moves to the
  // notice and screen readers read it; on page load nothing is focused.
  function showNoticeBox(box, announce) {
    box.hidden = false;
    if (!announce) return;
    box.setAttribute('tabindex', '-1');
    try {
      box.focus({ preventScroll: true });
    } catch (e) {
      box.focus();
    }
    if (box.scrollIntoView) box.scrollIntoView({ block: 'center', behavior: smooth() });
  }

  function showClosed(announce) {
    if (form) form.hidden = true;
    $('ap-request-unavailable').hidden = true;
    hideRequestIntro();
    const step = $('ap-step-request');
    if (step) {
      step.textContent = '';
      const strongStep = document.createElement('strong');
      strongStep.textContent = 'The online application is closed.';
      step.appendChild(strongStep);
    }
    // Name the closing date only once it has passed: the server can also close intake early
    // (ACCEPTING=false), and the page must not claim it closed on a day still to come.
    const label = isPastDeadline() ? deadlineLabel() : '';
    const box = $('ap-request-closed');
    const p = box.querySelector('p');
    if (p) {
      p.textContent = '';
      const strong = document.createElement('strong');
      strong.textContent = 'Applications are closed.';
      p.appendChild(strong);
      p.appendChild(document.createTextNode((label ? ' The online application for ' + ((CFG && CFG.cycle) || 'Fall 2027') +
        ' closed on ' + label + '.' : '') + ' Thank you for your interest in the Smart Grid Lab.'));
    }
    showNoticeBox(box, announce);
  }

  function showUnavailable(announce) {
    if (form) form.hidden = true;
    hideRequestIntro();
    showNoticeBox($('ap-request-unavailable'), announce);
  }

  /* ------------------------------------------------------------------
     Validation
  ------------------------------------------------------------------ */

  const FIELDS = ['rq_first_name', 'rq_last_name', 'rq_email', 'rq_email_confirm', 'rq_consent'];

  function value(id) {
    const el = $(id);
    return el ? String(el.value || '').trim() : '';
  }

  function validate(id) {
    switch (id) {
      case 'rq_first_name':
        return value(id) ? '' : 'Enter your first name.';
      case 'rq_last_name':
        return value(id) ? '' : 'Enter your last name.';
      case 'rq_email': {
        const v = value(id);
        if (!v) return 'Enter your email address.';
        if (v.length > 254 || !EMAIL_RE.test(v)) return 'Enter a valid email address, like name@example.com.';
        return '';
      }
      case 'rq_email_confirm': {
        const v = value(id);
        if (!v) return 'Enter your email address again.';
        const first = value('rq_email');
        if (first && v.toLowerCase() !== first.toLowerCase()) return 'The two email addresses do not match. Please check them.';
        return '';
      }
      case 'rq_consent':
        return $(id).checked ? '' : 'Check this box so that we can email you your application link.';
      default:
        return '';
    }
  }

  function setError(id, message) {
    const el = $(id);
    const box = $(id + '-error');
    if (!el || !box) return;
    const describedBy = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .filter((token) => token !== box.id);
    box.textContent = '';
    if (message) {
      const label = document.createElement('span');
      label.className = 'ap-error-label';
      label.textContent = 'Error:';
      box.appendChild(label);
      box.appendChild(document.createTextNode(' ' + message));
      box.hidden = false;
      el.setAttribute('aria-invalid', 'true');
      describedBy.push(box.id);
    } else {
      box.hidden = true;
      el.setAttribute('aria-invalid', 'false');
    }
    if (describedBy.length) el.setAttribute('aria-describedby', describedBy.join(' '));
    else el.removeAttribute('aria-describedby');
  }

  function check(id) {
    const message = validate(id);
    setError(id, message);
    return message;
  }

  function hasError(id) {
    const box = $(id + '-error');
    return !!(box && !box.hidden);
  }

  // A field is checked when it loses focus. When that happens because the mouse was just
  // pressed on another control (the submit button, the consent box), showing the error right
  // away would move that control before the button is released, and the click would be lost.
  // Such checks therefore wait until the click has been delivered (pointerup, or 1 s at the
  // latest), like on the application page. Keyboard and touch input are checked immediately.
  const press = { at: -1e9, ids: [], timer: 0 };

  function onPointerDown() {
    press.at = Date.now();
  }

  function flushPressChecks() {
    clearTimeout(press.timer);
    press.timer = 0;
    press.at = -1e9;
    const ids = press.ids;
    press.ids = [];
    if (!form.hidden) ids.forEach(check);
  }

  function onPointerUp() {
    if (press.ids.length) setTimeout(flushPressChecks, 0); // runs after the click event
    else press.at = -1e9;
  }

  function checkOnBlur(id) {
    if (Date.now() - press.at > 500) {
      check(id);
      return;
    }
    if (press.ids.indexOf(id) < 0) press.ids.push(id);
    if (!press.timer) press.timer = setTimeout(flushPressChecks, 1000);
  }

  /* ------------------------------------------------------------------
     Sending
  ------------------------------------------------------------------ */

  function setSending(on) {
    sending = on;
    const btn = $('ap-request-submit');
    // aria-disabled (not disabled) keeps keyboard focus on the button while sending.
    if (on) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
    btn.textContent = on ? 'Sending…' : 'Email me my application link';
    $('ap-request-status').textContent = on ? 'Sending your request…' : '';
    form.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function showError(message) {
    const box = $('ap-request-error');
    box.textContent = '';
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = 'Error: your request was not sent.';
    p.appendChild(strong);
    p.appendChild(document.createTextNode(' ' + message));
    box.appendChild(p);
    box.hidden = false;
  }

  function hideError() {
    const box = $('ap-request-error');
    box.hidden = true;
    box.textContent = '';
  }

  function showDone(firstName, email) {
    $('ap-request-done-name').textContent = firstName;
    $('ap-request-done-email').textContent = email;
    form.hidden = true;
    const panel = $('ap-request-done');
    panel.hidden = false;
    try {
      panel.focus({ preventScroll: true });
    } catch (e) {
      panel.focus();
    }
    if (panel.scrollIntoView) panel.scrollIntoView({ block: 'center', behavior: smooth() });
  }

  function smooth() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    } catch (e) {
      return 'auto';
    }
  }

  function postText(url, body) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0;
    const request = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then((res) => res.text().then((text) => ({ status: res.status, text: text })));
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (ctrl) ctrl.abort();
        reject(new Error('timeout'));
      }, REQUEST_TIMEOUT_MS);
    });
    return Promise.race([request, timeout]).then((res) => {
      clearTimeout(timer);
      return res;
    }, (err) => {
      clearTimeout(timer);
      throw err;
    });
  }

  function handleReply(res, firstName, email) {
    let data = null;
    try {
      data = JSON.parse(res.text);
    } catch (e) {
      data = null;
    }
    setSending(false);
    if (data && data.ok === true && res.status >= 200 && res.status < 300) {
      showDone(firstName, email);
      return;
    }
    const error = data && typeof data.error === 'string' ? data.error.trim().slice(0, 300) : '';
    if (error && /\bclosed\b/i.test(error)) {
      showClosed(true);
      return;
    }
    if (error) showError(/[.!?]$/.test(error) ? error : error + '.');
    else showError('We could not process your request right now. Please try again later.');
  }

  function onSubmit(e) {
    e.preventDefault();
    if (sending) return;
    hideError();
    if (isPastDeadline()) {
      showClosed(true);
      return;
    }
    const problems = FIELDS.filter((id) => check(id));
    if (problems.length) {
      $(problems[0]).focus();
      return;
    }
    const url = actionUrl('request');
    if (!url) {
      showUnavailable(true);
      return;
    }
    const firstName = value('rq_first_name');
    const email = value('rq_email');
    setSending(true);
    const send = () => {
      const payload = {
        schema: 'sgl-jdp-request',
        version: 2,
        first_name: firstName,
        last_name: value('rq_last_name'),
        email: email,
        consent: $('rq_consent').checked === true,
        hp: String(($('ap_hp_field') || {}).value || ''),
        client: {
          elapsed_seconds: Math.max(0, Math.round((Date.now() - loadedAt) / 1000)),
          user_agent: String(navigator.userAgent || '')
        }
      };
      postText(url, JSON.stringify(payload)).then((res) => handleReply(res, firstName, email), (err) => {
        setSending(false);
        showError(err && err.message === 'timeout'
          ? 'The server took too long to answer. Please try again later.'
          : 'We could not reach the server. Please check your internet connection and try again later.');
      });
    };
    const wait = MIN_ELAPSED_MS - (Date.now() - loadedAt);
    if (wait > 0) setTimeout(send, wait);
    else send();
  }

  function onInput(e) {
    const id = e.target && e.target.id;
    if (FIELDS.indexOf(id) < 0) return;
    if (hasError(id)) check(id);
    if (id === 'rq_email' && hasError('rq_email_confirm')) check('rq_email_confirm');
  }

  function onFocusOut(e) {
    const t = e.target;
    const id = t && t.id;
    if (FIELDS.indexOf(id) < 0 || t.type === 'checkbox') return;
    if (String(t.value || '').trim()) checkOnBlur(id);
    if (id === 'rq_email' && value('rq_email_confirm')) checkOnBlur('rq_email_confirm');
  }

  function requestAgain() {
    $('ap-request-done').hidden = true;
    ['rq_email', 'rq_email_confirm'].forEach((id) => {
      $(id).value = '';
      setError(id, '');
    });
    hideError();
    form.hidden = false;
    $('rq_email').focus();
  }

  /* ------------------------------------------------------------------
     Start-up
  ------------------------------------------------------------------ */

  function init() {
    form = $('ap-request-form');
    if (!form) return;
    if (!CFG) {
      showUnavailable(false);
      return;
    }
    if (isPastDeadline()) {
      showClosed(false);
      return;
    }
    if (!actionUrl('request')) {
      showUnavailable(false);
      return;
    }
    form.addEventListener('submit', onSubmit);
    form.addEventListener('input', onInput);
    form.addEventListener('change', onInput);
    form.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    $('ap-request-again').addEventListener('click', requestAgain);
    form.hidden = false;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
