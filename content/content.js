/**
 * content.js — main activity tracker injected into every tracked page.
 *
 * Captures mouse, keyboard, scroll, touch, navigation, form, error, focus and
 * performance signals; attributes them to DOM elements; batches them over a
 * long-lived port to the background service worker. Also hosts the heatmap
 * overlay renderer and the on-demand page scan responder.
 */
(function () {
  'use strict';
  const VAIA = globalThis.VAIA || {};
  const tools = VAIA.tools || {};

  // ---- config (sent by background over the port) --------------------------
  let cfg = {
    enabled: true,
    tracking: {},
    privacy: { redactKeystrokeValues: true },
    insights: { rageClickThreshold: 3, rageClickWindowMs: 4000, deadClickDelayMs: 2000, idleThresholdMs: 45000 },
    heatmaps: { enabled: true, showClicks: true, showScroll: true, opacity: 0.45 },
  };

  const pageUrl = () => (location && location.href) || '';
  const safeUrl = (u) => {
    try {
      const x = new URL(u);
      if (cfg.privacy.stripQueryParams) x.search = '';
      return x.href;
    } catch {
      return String(u).slice(0, 2048);
    }
  };

  // ---- port to background -------------------------------------------------
  let port = null;
  let portRetry = 0;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'vaia-port' });
      port.onMessage.addListener(onPortMessage);
      port.onDisconnect.addListener(() => {
        port = null;
        if (document.visibilityState !== 'hidden' && portRetry < 20) {
          setTimeout(connect, 1000 + portRetry * 500);
          portRetry++;
        }
      });
      port.postMessage({ type: 'vaia:hello', url: pageUrl(), title: document.title });
    } catch (e) {
      port = null;
    }
  }

  function onPortMessage(msg) {
    if (!msg) return;
    if (msg.type === 'vaia:config') {
      cfg = msg.config || cfg;
      if (cfg.heatmaps && cfg.heatmaps.enabled && heatmap && heatmap.mode) heatmap.render();
    }
  }

  // ---- batching -----------------------------------------------------------
  const pending = [];
  let flushTimer = null;
  let lastFlush = 0;

  function emit(type, data, opts = {}) {
    if (!cfg.enabled) return;
    const t = Date.now();
    const ev = {
      id: genId(),
      ts: t,
      type,
      url: safeUrl(pageUrl()),
      title: document.title || '',
      data,
    };
    pending.push(ev);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    const ms = 500;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, ms);
    if (Date.now() - lastFlush > 10000 && pending.length >= 50) flush();
  }

  function flush() {
    if (!pending.length) return;
    lastFlush = Date.now();
    const batch = pending.splice(0, pending.length);
    if (!port) connect();
    try {
      port.postMessage({ type: 'vaia:event_batch', batch });
    } catch (e) {
      // SW asleep — retry shortly
      pending.unshift(...batch);
    }
  }

  let idCounter = 0;
  function genId() {
    idCounter = (idCounter + 1) % 1e6;
    return (
      (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'e-' + Date.now().toString(36)) +
      '-' + idCounter
    );
  }

  // ---- element descriptors ------------------------------------------------
  function describe(target, opts) {
    try {
      return tools.describeElement(target, opts) || null;
    } catch {
      return null;
    }
  }

  function isSensitive(el) {
    try {
      return !!(VAIA.privacy && VAIA.privacy.isSensitive(el));
    } catch {
      return false;
    }
  }

  // ---- mouse --------------------------------------------------------------
  let lastX = 0;
  let lastY = 0;
  let lastMoveTs = 0;
  const clickLog = new Map(); // fingerprint -> [timestamps]

  function onMouseMove(e) {
    const ms = cfg.tracking.mouseMoveSampleMs || 50;
    const dist = cfg.tracking.mouseMoveMinDistance || 4;
    const t = Date.now();
    if (t - lastMoveTs < ms) return;
    const dx = Math.abs(e.clientX - lastX);
    const dy = Math.abs(e.clientY - lastY);
    if (dx < dist && dy < dist && lastMoveTs) return;
    lastX = e.clientX;
    lastY = e.clientY;
    lastMoveTs = t;
    emit('mouse_move', { x: e.clientX, y: e.clientY, target: describe(e.target) }, { highVolume: true });
  }

  function onPointerDown(e) {
    lastX = e.clientX;
    lastY = e.clientY;
    lastMoveTs = Date.now();
    if (!cfg.tracking.trackClicks) return;
    emit('mouse_down', { x: e.clientX, y: e.clientY, button: e.button, target: describe(e.target) });
  }

  function onPointerUp(e) {
    emit('mouse_up', { x: e.clientX, y: e.clientY, button: e.button, target: describe(e.target) });
  }

  function onClick(e) {
    if (!cfg.tracking.trackClicks) return;
    const t = Date.now();
    const target = describe(e.target, { targetIsInteractive: true, a11y: true });
    emit('click', { x: e.clientX, y: e.clientY, button: e.button, target });
    trackRage(e, t, target);
    trackDeadClick(e, t, target);
    if (cfg.heatmaps && cfg.heatmaps.enabled && cfg.heatmaps.showClicks) heatmap.recordClick(e.clientX, e.clientY);
  }

  function onDblClick(e) {
    emit('double_click', { x: e.clientX, y: e.clientY, target: describe(e.target) });
  }

  function onContextMenu(e) {
    emit('right_click', { x: e.clientX, y: e.clientY, target: describe(e.target) });
  }

  function trackRage(e, t, target) {
    if (!cfg.insights || !cfg.insights.rageClickThreshold) return;
    const fp = (target && target.fingerprint) || '';
    if (!fp) return;
    const list = clickLog.get(fp) || [];
    list.push(t);
    const cutoff = t - (cfg.insights.rageClickWindowMs || 4000);
    while (list.length && list[0] < cutoff) list.shift();
    clickLog.set(fp, list);
    if (list.length >= (cfg.insights.rageClickThreshold || 3)) {
      emit('rage_click', {
        count: list.length,
        windowMs: cfg.insights.rageClickWindowMs,
        x: e.clientX,
        y: e.clientY,
        target,
      });
      list.length = 0; // reset to avoid re-firing storm
    }
    if (clickLog.size > 500) {
      const first = clickLog.keys().next().value;
      clickLog.delete(first);
    }
  }

  // ---- dead click detection ----------------------------------------------
  let mutationCount = 0;
  let deadCheckPending = false;
  const deadCheckWindow = new WeakMap(); // element -> {ts, url, started}

  function trackDeadClick(e, t, target) {
    if (!cfg.insights || !cfg.insights.deadClickDelayMs) return;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    // only consider elements that LOOK interactive
    if (!tools.isLikelyInteractive(el)) return;
    // links and submit buttons have obvious actions; skip those candidates that navigate
    if (deadCheckPending) return;
    deadCheckPending = true;
    const url = pageUrl();
    const key = el;
    deadCheckWindow.set(key, { ts: t, url, muts: mutationCount });
    setTimeout(() => {
      deadCheckPending = false;
      const rec = deadCheckWindow.get(key);
      if (!rec) return;
      deadCheckWindow.delete(key);
      const now = Date.now();
      const navigated = pageUrl() !== rec.url;
      const mutated = mutationCount > rec.muts + 2;
      if (!navigated && !mutated) {
        emit('dead_click', {
          delayMs: now - rec.ts,
          target: describe(el, { targetIsInteractive: true }),
        });
      }
    }, cfg.insights.deadClickDelayMs || 2000);
  }

  // ---- drag ---------------------------------------------------------------
  let dragStart = null;
  function onDragStart(e) {
    if (!cfg.tracking.trackDrag) return;
    dragStart = { x: e.clientX, y: e.clientY, t: Date.now(), el: e.target };
  }
  function onDragEnd(e) {
    if (!cfg.tracking.trackDrag || !dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 15) {
      emit('drag', {
        dx,
        dy,
        distance: Math.round(Math.hypot(dx, dy)),
        durationMs: Date.now() - dragStart.t,
        from: describe(dragStart.el),
        to: describe(e.target),
      });
    }
    dragStart = null;
  }

  // ---- keyboard -----------------------------------------------------------
  function keyInfo(e) {
    let key = e.key || '';
    if (key.length === 1 && !/[\x00-\x1f]/.test(key)) key = key.toLowerCase();
    else if (key.length > 1) key = key.toLowerCase().replace(/\s+/g, '_');
    return {
      key,
      code: e.code || '',
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
      repeat: e.repeat,
    };
  }

  function onKeyDown(e) {
    if (!cfg.tracking.trackKeyboard) return;
    const k = keyInfo(e);
    const target = e.target && e.target.nodeType === 1 ? e.target : null;
    const sensitive = target ? isSensitive(target) : false;
    const data = { ...k, target: describe(target) };
    if (sensitive || cfg.privacy.redactKeystrokeValues) data.key = k.key.length === 1 ? '•' : k.key; // keep modifier keys meaningful
    data.sensitive = sensitive;
    emit('key_down', data);
  }

  function onKeyUp(e) {
    if (!cfg.tracking.trackKeyboard) return;
    const k = keyInfo(e);
    emit('key_up', { key: k.key.length === 1 ? '•' : k.key, code: k.code, sensitive: e.target ? isSensitive(e.target) : false });
  }

  // ---- text input / paste / copy ------------------------------------------
  const inputValueMap = new WeakMap();

  function onInput(e) {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) return;
    const sensitive = isSensitive(el);
    const prevLen = inputValueMap.get(el) || 0;
    const len = el.value ? el.value.length : 0;
    inputValueMap.set(el, len);
    const added = len - prevLen;
    const data = {
      tag,
      type: (el.getAttribute && el.getAttribute('type')) || '',
      sensitive,
      added,
      len,
      target: describe(el),
    };
    if (!sensitive && !cfg.privacy.redactKeystrokeValues) {
      data.value = String(el.value || '').slice(0, 200);
    }
    emit('text_input', data);
  }

  function clipboardEvent(type) {
    return function (e) {
      const sel = safeSelectionText();
      emit(type, {
        length: sel ? sel.length : 0,
        target: describe(e.target),
        sensitive: e.target ? isSensitive(e.target) : false,
        snippet: sel ? tools.sanitizeText(sel.slice(0, 80)) : '',
      });
    };
  }

  let lastSelection = '';
  function safeSelectionText() {
    try {
      const s = window.getSelection();
      return s ? s.toString() : '';
    } catch {
      return '';
    }
  }

  function onSelectionChange() {
    if (!cfg.tracking.trackSelection) return;
    const t = Date.now();
    if (t - (onSelectionChange.last || 0) < 300) return;
    onSelectionChange.last = t;
    const text = safeSelectionText();
    if (!text || text === lastSelection) return;
    lastSelection = text;
    emit('selection', { length: text.length, snippet: tools.sanitizeText(text.slice(0, 60)) });
  }

  // ---- focus --------------------------------------------------------------
  function onFocusIn(e) {
    if (!cfg.tracking.trackFocus) return;
    emit('focus', { target: describe(e.target) });
  }
  function onFocusOut(e) {
    if (!cfg.tracking.trackFocus) return;
    emit('blur', { target: describe(e.target) });
  }

  // ---- scroll / wheel ------------------------------------------------------
  let lastScrollTs = 0;
  let lastScrollY = window.scrollY || 0;
  function onScroll() {
    if (!cfg.tracking.trackScroll) return;
    const t = Date.now();
    const throttleMs = cfg.tracking.scrollThrottleMs || 120;
    if (t - lastScrollTs < throttleMs) return;
    lastScrollTs = t;
    const y = window.scrollY || 0;
    const max = Math.max(1, (document.documentElement.scrollHeight || 1) - (window.innerHeight || 1));
    const depth = Math.round((y / max) * 1000) / 10;
    const dy = y - lastScrollY;
    lastScrollY = y;
    emit('scroll', { y: Math.round(y), depth, dy: Math.round(dy), direction: dy > 0 ? 'down' : dy < 0 ? 'up' : 'none' });
    if (cfg.heatmaps && cfg.heatmaps.enabled && cfg.heatmaps.showScroll) heatmap.recordScroll(y);
  }

  function onWheel(e) {
    const t = Date.now();
    if (t - (onWheel.last || 0) < 120) return;
    onWheel.last = t;
    emit('wheel', { dx: Math.round(e.deltaX), dy: Math.round(e.deltaY), dz: Math.round(e.deltaZ) });
  }

  // ---- touch ---------------------------------------------------------------
  function onTouch(e) {
    if (!cfg.tracking.trackTouch) return;
    const t = e.changedTouches && e.changedTouches[0];
    emit('touch', {
      type: e.type,
      x: t ? Math.round(t.clientX) : null,
      y: t ? Math.round(t.clientY) : null,
      touches: e.touches ? e.touches.length : 0,
    });
  }

  // ---- forms ---------------------------------------------------------------
  function onSubmit(e) {
    if (!cfg.tracking.trackForm) return;
    const form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    const fields = Array.from(form.querySelectorAll('input,select,textarea')).map((el) => {
      const sensitive = isSensitive(el);
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute && el.getAttribute('type')) || '',
        name: (el.getAttribute && el.getAttribute('name')) || '',
        required: el.hasAttribute && el.hasAttribute('required'),
        sensitive,
        filled: !!(el.value && el.value.length),
      };
    });
    emit('form_submit', {
      id: (form.getAttribute && form.getAttribute('id')) || '',
      name: (form.getAttribute && form.getAttribute('name')) || '',
      action: (form.getAttribute && form.getAttribute('action')) || '',
      method: (form.method || 'get').toUpperCase(),
      fieldCount: fields.length,
      sensitiveFieldCount: fields.filter((f) => f.sensitive).length,
      fields,
    });
  }

  // ---- navigation -----------------------------------------------------------
  let lastUrl = pageUrl();
  let lastNavTs = 0;

  function detectUrlChange() {
    const u = pageUrl();
    if (u === lastUrl) return;
    const prev = lastUrl;
    lastUrl = u;
    emit('navigation', { from: safeUrl(prev), to: safeUrl(u), kind: sameDoc(prev, u) ? 'spa' : 'hard' });
  }

  function sameDoc(a, b) {
    try {
      return new URL(a).pathname + new URL(a).hash === new URL(b).pathname + new URL(b).hash;
    } catch {
      return false;
    }
  }

  function onPopState() {
    detectUrlChange();
  }

  function onAnchorClick(e) {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || /^(mailto:|tel:|javascript:)/.test(href)) return;
    const t = Date.now();
    if (t - lastNavTs < 200) return;
    lastNavTs = t;
    const url = new URL(href, location.href);
    if (url.origin === location.origin) {
      emit('navigation', {
        from: safeUrl(pageUrl()),
        to: safeUrl(url.href),
        kind: 'link',
        target: describe(a),
      });
    }
  }

  function onPageHide(e) {
    emit('page_leave', { persisted: e.persisted, url: safeUrl(pageUrl()) });
    flush();
  }

  // ---- errors ---------------------------------------------------------------
  function onWindowError(e) {
    if (!cfg.tracking.trackErrors) return;
    emit('error', {
      message: tools.sanitizeText(String(e.message || '').slice(0, 300)),
      source: String(e.filename || '').slice(0, 300),
      line: e.lineno,
      col: e.colno,
      stack: String(e.error && e.error.stack ? e.error.stack : '').slice(0, 600),
    });
  }

  function onUnhandledRejection(e) {
    if (!cfg.tracking.trackErrors) return;
    const r = e.reason;
    emit('unhandled_rejection', {
      message: tools.sanitizeText(String((r && (r.message || r.name)) || r || '').slice(0, 300)),
      stack: String(r && r.stack ? r.stack : '').slice(0, 600),
    });
  }

  function onResourceError(e) {
    if (!cfg.tracking.trackErrors) return;
    const t = e.target;
    if (!t || !t.src) return;
    emit('resource_error', { tag: (t.tagName || '').toLowerCase(), src: String(t.src).slice(0, 300) });
  }

  function onConsoleError(args) {
    if (!cfg.tracking.trackErrors) return;
    emit('console_error', { args: args.map((a) => tools.sanitizeText(String(a).slice(0, 200))).slice(0, 8) });
  }

  // ---- visibility / misc -----------------------------------------------------
  function onVisibilityChange() {
    const state = document.visibilityState;
    emit('visibility', { state, ts: Date.now() });
    if (state === 'visible') detectUrlChange();
  }

  function onFullscreen() {
    emit('fullscreen', { active: !!document.fullscreenElement });
  }

  function onNetwork() {
    emit('network', { online: navigator.onLine });
  }

  function onPrint() {
    emit('print', {});
  }

  function onFind() {
    emit('find', {});
  }

  // ---- DOM mutations (optional, for dead-click + insights) -------------------
  let mutationObserver = null;
  function startMutationCounting() {
    if (mutationObserver || typeof MutationObserver === 'undefined') return;
    try {
      mutationObserver = new MutationObserver((muts) => {
        mutationCount += muts.length;
      });
      mutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch (e) {
      /* ignore */
    }
  }

  // ---- idle detection ---------------------------------------------------------
  let lastActivity = Date.now();
  let idleState = false;
  function markActivity() {
    lastActivity = Date.now();
    if (idleState) {
      idleState = false;
      emit('idle_end', { durationMs: lastActivity - idleStartedAt });
    }
  }
  let idleStartedAt = 0;
  setInterval(() => {
    if (!cfg.tracking.trackIdle) return;
    const threshold = cfg.insights.idleThresholdMs || 45000;
    if (!idleState && Date.now() - lastActivity > threshold) {
      idleState = true;
      idleStartedAt = lastActivity;
      emit('idle_start', { thresholdMs: threshold });
    }
  }, 2000);

  // ---- performance ------------------------------------------------------------
  function sendPerformance() {
    if (!cfg.tracking.trackPerformance) return;
    const nav = performance.getEntriesByType('navigation')[0];
    const timing = {};
    if (nav) {
      const d = nav.toJSON ? nav.toJSON() : nav;
      timing = {
        domContentLoaded: Math.round(d.domContentLoadedEventEnd),
        load: Math.round(d.loadEventEnd),
        ttfb: Math.round(d.responseStart),
        domInteractive: Math.round(d.domInteractive),
        domComplete: Math.round(d.domComplete),
        transferSize: d.transferSize,
        protocol: d.nextHopProtocol,
      };
    }
    const entries = performance.getEntriesByType('resource');
    const failures = entries.filter((r) => r.transferSize === 0 && !/^data:/i.test(r.name)).length;
    emit('performance', {
      ...timing,
      resources: entries.length,
      resourceFailures: failures,
      fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0),
      lcp: Math.round(performance.getEntriesByName('largest-contentful-paint')[0]?.startTime || 0),
    });
  }

  // ---- heatmap overlay ----------------------------------------------------------
  const heatmap = {
    mode: null,
    clicks: [],
    scrollDepths: [],
    el: null,
    recordClick(x, y) {
      this.clicks.push({ x, y, ts: Date.now() });
      if (this.clicks.length > 3000) this.clicks.splice(0, 300);
      if (this.mode === 'clicks') this.render();
    },
    recordScroll(y) {
      const vh = window.innerHeight || 1;
      const max = Math.max(1, (document.documentElement.scrollHeight || 1) - vh);
      const depth = Math.min(1, y / max);
      this.scrollDepths.push({ depth, ts: Date.now() });
      if (this.scrollDepths.length > 2000) this.scrollDepths.splice(0, 200);
      if (this.mode === 'scroll') this.render();
    },
    ensureEl() {
      if (this.el && this.el.isConnected) return this.el;
      this.el = document.createElement('div');
      this.el.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:2147483646;mix-blend-mode:multiply;opacity:0;transition:opacity .2s;';
      (document.body || document.documentElement).appendChild(this.el);
      return this.el;
    },
    render() {
      if (!cfg.heatmaps || !cfg.heatmaps.enabled) return;
      const el = this.ensureEl();
      el.innerHTML = '';
      el.style.opacity = String(cfg.heatmaps.opacity || 0.45);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (this.mode === 'clicks') {
        const frag = document.createDocumentFragment();
        for (const c of this.clicks) {
          const d = document.createElement('div');
          const r = Math.max(18, Math.min(60, 12 + (c.count || 1) * 6));
          d.style.cssText = `position:absolute;left:${c.x - r}px;top:${c.y - r}px;width:${r * 2}px;height:${r * 2}px;border-radius:50%;background:radial-gradient(circle,rgba(255,0,60,.55),rgba(255,120,0,.25) 45%,rgba(255,120,0,0) 70%);`;
          frag.appendChild(d);
        }
        el.appendChild(frag);
      } else if (this.mode === 'scroll') {
        const max = Math.max(1, (document.documentElement.scrollHeight || 1) - vh);
        const buckets = {};
        for (const s of this.scrollDepths) {
          const depthY = s.depth * max;
          const bucket = Math.round(depthY / 60);
          buckets[bucket] = (buckets[bucket] || 0) + 1;
        }
        const frag = document.createDocumentFragment();
        for (const [bucket, count] of Object.entries(buckets)) {
          const y = bucket * 60 - (window.scrollY || 0);
          if (y < -80 || y > vh + 80) continue;
          const d = document.createElement('div');
          const maxCount = Math.max(1, ...Object.values(buckets));
          const alpha = 0.1 + (count / maxCount) * 0.5;
          d.style.cssText = `position:absolute;left:0;right:0;top:${y}px;height:60px;background:linear-gradient(90deg,rgba(76,110,245,.15),rgba(76,110,245,${alpha}));border-left:3px solid rgba(76,110,245,.6);`;
          frag.appendChild(d);
        }
        el.appendChild(frag);
      }
    },
    clear() {
      if (this.el && this.el.isConnected) this.el.remove();
      this.el = null;
    },
    setMode(m) {
      this.mode = m;
      if (m) this.render();
      else this.clear();
    },
    toggle(mode) {
      this.setMode(this.mode === mode ? null : mode);
      return this.mode;
    },
  };

  // ---- messages from background / popup / dashboard ---------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    switch (msg.type) {
      case 'vaia:scan_page':
        sendResponse({ summary: tools.pageSummary(Number(msg.maxElements) || 80) });
        return true;
      case 'vaia:heatmap':
        if (msg.action === 'toggle') sendResponse({ mode: heatmap.toggle(msg.mode || 'clicks') });
        else if (msg.action === 'clear') {
          heatmap.clear();
          heatmap.clicks = [];
          heatmap.scrollDepths = [];
          sendResponse({ mode: null });
        } else if (msg.action === 'data') {
          sendResponse({ clicks: heatmap.clicks, scroll: heatmap.scrollDepths });
        }
        return true;
      case 'vaia:config_updated':
        if (msg.config) {
          cfg = msg.config;
          if (cfg.heatmaps && cfg.heatmaps.enabled && heatmap.mode) heatmap.render();
        }
        sendResponse({ ok: true });
        return true;
      case 'vaia:ping':
        sendResponse({ pong: Date.now() });
        return true;
      default:
        return false;
    }
  });

  // ---- init ------------------------------------------------------------------
  function init() {
    try {
      connect();
      if (VAIA.privacy) VAIA.privacy.start(4000);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get('vaia:config').then((res) => {
          if (res && res['vaia:config']) cfg = Object.assign(cfg, res['vaia:config']);
          emit('page_view', { referrer: document.referrer || '', title: document.title });
          sendPerformance();
          detectUrlChange();
        }).catch(() => {
          emit('page_view', { referrer: document.referrer || '', title: document.title });
        });
      } else {
        emit('page_view', { referrer: document.referrer || '', title: document.title });
      }
    } catch (e) {
      /* storage unavailable */
    }

    const opts = { passive: true, capture: true };
    const optsNotPassive = { passive: false, capture: true };
    window.addEventListener('pointermove', onMouseMove, opts);
    window.addEventListener('pointerdown', onPointerDown, opts);
    window.addEventListener('pointerup', onPointerUp, opts);
    document.addEventListener('click', onClick, opts);
    document.addEventListener('dblclick', onDblClick, opts);
    document.addEventListener('contextmenu', onContextMenu, opts);
    document.addEventListener('pointerdown', onDragStart, opts);
    document.addEventListener('pointerup', onDragEnd, opts);
    window.addEventListener('keydown', onKeyDown, opts);
    window.addEventListener('keyup', onKeyUp, opts);
    window.addEventListener('input', onInput, opts);
    document.addEventListener('copy', clipboardEvent('copy'), opts);
    document.addEventListener('cut', clipboardEvent('cut'), opts);
    document.addEventListener('paste', clipboardEvent('paste'), optsNotPassive);
    document.addEventListener('focusin', onFocusIn, opts);
    document.addEventListener('focusout', onFocusOut, opts);
    document.addEventListener('scroll', onScroll, opts);
    window.addEventListener('wheel', onWheel, opts);
    window.addEventListener('touchstart', onTouch, opts);
    window.addEventListener('touchend', onTouch, opts);
    document.addEventListener('submit', onSubmit, opts);
    document.addEventListener('click', onAnchorClick, opts);
    window.addEventListener('popstate', onPopState, opts);
    window.addEventListener('hashchange', detectUrlChange, opts);
    window.addEventListener('pagehide', onPageHide, opts);
    window.addEventListener('error', onWindowError, { capture: true, passive: true });
    window.addEventListener('unhandledrejection', onUnhandledRejection, opts);
    document.addEventListener('error', onResourceError, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('fullscreenchange', onFullscreen);
    window.addEventListener('online', onNetwork);
    window.addEventListener('offline', onNetwork);
    window.addEventListener('beforeprint', onPrint);
    window.addEventListener('afterprint', onPrint);

    try {
      document.addEventListener('selectionchange', onSelectionChange, opts);
    } catch (e) {}

    // track SPA URL changes cheaply
    setInterval(detectUrlChange, 900);

    startMutationCounting();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
