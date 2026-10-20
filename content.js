// CoFoundersLab Connect Bot — runs on cofounderslab.com.
//
// Flow: open "Find a CoFounder" (/search) → for each profile card that still shows a
// "Connect" button, look up the profile's country via the site's own API → if US/Canada,
// click Connect, write the template note, click Send → click "Next" → repeat.
(function () {
  if (window.__cflBotLoaded) return;
  window.__cflBotLoaded = true;

  const SEARCH_PATH = '/search';
  const ALLOWED_COUNTRIES = ['US', 'CA'];
  const DEFAULTS = {
    template: 'Hi {firstName}, I came across your profile and would love to connect!',
    minDelay: 20,
    maxDelay: 45,
    maxPerRun: 20,
    dailyLimit: 40,
    autoPaginate: true
  };

  let running = false;
  let settings = { ...DEFAULTS };
  let sentThisRun = 0;

  // ---------- helpers ----------
  // Chrome throttles timers in hidden tabs (down to ~1 per minute after 5 min hidden), which
  // stalls every wait loop. Timers inside a Web Worker are not throttled that way, so sleep()
  // asks a worker to wake us up. A normal setTimeout runs alongside as a fallback in case the
  // site's CSP blocks the worker — whichever fires first resolves the sleep.
  const timer = (() => {
    try {
      const src = 'onmessage=(e)=>setTimeout(()=>postMessage(e.data[0]),e.data[1]);';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const waiting = new Map();
      let nextId = 0;
      w.onmessage = (e) => {
        const done = waiting.get(e.data);
        if (done) done();
      };
      w.onerror = () => w.terminate();
      return (ms, done) => {
        const id = ++nextId;
        waiting.set(id, done);
        w.postMessage([id, ms]);
        return () => waiting.delete(id);
      };
    } catch (e) {
      return null;
    }
  })();

  const sleep = (ms) => new Promise((r) => {
    let cancel = () => {};
    const fallback = setTimeout(() => { cancel(); r(); }, ms);
    if (timer) cancel = timer(ms, () => { cancel(); clearTimeout(fallback); r(); });
  });
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => norm(el && el.innerText);
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const buttons = (root = document) => [...root.querySelectorAll('button')].filter(isVisible);
  const buttonByText = (root, text) => buttons(root).find((b) => textOf(b).toLowerCase() === text.toLowerCase());

  async function log(msg, level = 'info') {
    console.log('[CFL Bot]', msg);
    const { logs = [] } = await chrome.storage.local.get('logs');
    logs.push({ t: Date.now(), msg, level });
    await chrome.storage.local.set({ logs: logs.slice(-300), lastActive: Date.now() });
  }

  // A hidden tab also renders the site more slowly, so allow twice the time while hidden.
  // The final check after the deadline catches a page that loaded during a long throttled sleep.
  async function waitFor(fn, timeout = 8000, interval = 250) {
    const end = Date.now() + (document.hidden ? timeout * 2 : timeout);
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return fn() || null;
  }

  async function pause(seconds) {
    for (let i = 0; i < seconds && running; i++) await sleep(1000);
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  async function getStats() {
    const { stats = {} } = await chrome.storage.local.get('stats');
    if (stats.day !== todayKey()) return { day: todayKey(), sentToday: 0, total: stats.total || 0 };
    return stats;
  }

  async function limitReached() {
    const s = await getStats();
    if (s.sentToday >= settings.dailyLimit) return `Daily limit of ${settings.dailyLimit} reached.`;
    if (sentThisRun >= settings.maxPerRun) return `Reached ${settings.maxPerRun} messages for this run.`;
    return null;
  }

  // ---------- popups ----------
  // The site's dialog wrapper has zero height (its children are position:fixed), so a dialog
  // counts as visible when any of its buttons / fields are visible.
  const dialogShown = (d) => d && d.isConnected && [...d.querySelectorAll('button, textarea, input')].some(isVisible);
  const visibleDialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(dialogShown);

  // Closes a dialog with its ✕ (icon-only) button or Escape — never "Cancel", which submits on this site.
  async function closeDialog(d) {
    const x = buttons(d).find((b) => !textOf(b) || /^(x|×|close)$/i.test(textOf(b)));
    if (x) x.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(800);
  }

  // Closes the "Start Your Free Trial" / premium popups. Never clicks Cancel/submit buttons.
  async function closePromoPopups() {
    for (const d of visibleDialogs()) {
      if (d.querySelector('textarea[name="message"]')) continue; // that's the connect dialog
      if (!/free trial|premium|upgrade|unlock/i.test(d.innerText)) continue;
      await closeDialog(d);
    }
  }

  // ---------- profile data (site API, same origin) ----------
  async function fetchProfile(slug) {
    const { countryCache = {} } = await chrome.storage.local.get('countryCache');
    if (countryCache[slug]) return countryCache[slug];
    let res;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(`/api/backend/founder/profile?slug=${encodeURIComponent(slug)}`, { credentials: 'include' });
      // 429 / 5xx = the site is throttling or struggling: back off and retry.
      if ((res.status === 429 || res.status >= 500) && attempt < 4 && running) {
        await log(`Site is busy (HTTP ${res.status}). Waiting 60s…`, 'warn');
        await pause(60);
        continue;
      }
      break;
    }
    if (!res.ok) throw new Error(`profile API ${res.status}`);
    const p = await res.json();
    const c = p.city_details || {};
    const info = {
      firstName: p.firstName || '',
      name: norm(`${p.firstName || ''} ${p.lastName || ''}`),
      country: c.countryCode || '',
      location: [c.name, c.region, c.country].filter(Boolean).join(', ')
    };
    countryCache[slug] = info;
    const keys = Object.keys(countryCache);
    if (keys.length > 5000) keys.slice(0, keys.length - 5000).forEach((k) => delete countryCache[k]);
    await chrome.storage.local.set({ countryCache });
    return info;
  }

  // The search list always shows "Connect", even for people already invited, so the real
  // state is read from the profile page (loaded in a hidden same-origin iframe).
  // Returns the action button label: 'connect', 'request sent', 'pending', 'accept', … or '' if unknown.
  async function profileButtonState(slug) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const state = await loadProfileState(slug, 40000);
      if (state) return state;
      if (attempt === 1) await log(`Profile of ${slug} is slow to load, retrying…`, 'warn');
    }
    return '';
  }

  async function loadProfileState(slug, timeout) {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:1300px;height:900px;opacity:0;pointer-events:none;border:0;';
    frame.src = `/profile/${encodeURIComponent(slug)}`;
    document.body.appendChild(frame);
    try {
      const STATES = ['connect', 'request sent', 'pending', 'accept', 'accepted', 'ignored', 'ignore'];
      const found = await waitFor(() => {
        const doc = frame.contentDocument;
        if (!doc || !doc.body) return null;
        const labels = [...doc.querySelectorAll('button')].map((b) => textOf(b).toLowerCase());
        if (!labels.includes('message')) return null; // profile header not rendered yet
        return labels.find((l) => STATES.includes(l)) || 'none'; // 'none' = already connected
      }, timeout, 400);
      return found || '';
    } finally {
      frame.remove();
    }
  }

  // ---------- search page ----------
  async function goToSearch() {
    if (location.pathname === SEARCH_PATH) return true;
    const nav = [...document.querySelectorAll('a')].find((a) => /^find a co-?founder$/i.test(textOf(a)) && isVisible(a));
    if (nav) {
      nav.click();
      await log('Opening "Find a CoFounder"…');
      if (await waitFor(() => location.pathname === SEARCH_PATH, 8000)) return true;
    }
    location.href = SEARCH_PATH; // full load; the bot resumes afterwards
    return false;
  }

  function cards() {
    return [...document.querySelectorAll('ul[role="list"] > li')].filter((li) => li.querySelector('a[href^="/profile/"]'));
  }

  function cardData(li) {
    const link = li.querySelector('a[href^="/profile/"]');
    const slug = link.getAttribute('href').split('/profile/')[1].split(/[/?#]/)[0];
    return { li, slug, name: textOf(link), connectBtn: buttonByText(li, 'Connect') };
  }

  const pageSignature = () => cards().map((li) => li.querySelector('a[href^="/profile/"]').getAttribute('href')).join(',');

  async function waitForCards() {
    return waitFor(() => cards().length > 0, 45000, 500); // later pages can take 10s+ to load
  }

  // If the page won't load (site slow or throttling), wait longer and longer, then reload.
  // Returns true when cards are shown, false when it gave up, 'reload' when a reload is in progress.
  const BACKOFF_MIN = [1, 2, 4, 8, 8];
  async function ensureCards() {
    if (await waitForCards()) {
      await chrome.storage.local.set({ reloads: 0 });
      return true;
    }
    const { reloads = 0 } = await chrome.storage.local.get('reloads');
    if (reloads >= BACKOFF_MIN.length) return false;
    const mins = BACKOFF_MIN[reloads];
    await log(`Page ${urlPage()} did not load. Waiting ${mins} min, then reloading (${reloads + 1}/${BACKOFF_MIN.length})…`, 'warn');
    for (let i = 0; i < mins * 60 && running; i++) {
      await sleep(1000);
      if (i % 60 === 0) await chrome.storage.local.set({ lastActive: Date.now() }); // keep resume window open
      if (cards().length > 0) {
        await chrome.storage.local.set({ reloads: 0 });
        return true;
      }
    }
    if (!running) return false;
    await chrome.storage.local.set({ reloads: reloads + 1, lastActive: Date.now() });
    location.reload();
    return 'reload';
  }

  const urlPage = () => parseInt(new URLSearchParams(location.search).get('page'), 10) || 1;

  // Returns 'ok' (moved to the next page), 'end' (no enabled Next button) or 'reload'
  // (falling back to a full page load of ?page=N; the bot resumes after it).
  // Later pages can take 10s+ to load, so wait generously and retry before giving up.
  async function nextPage() {
    const target = urlPage() + 1;
    const startSig = pageSignature();
    const arrived = () => urlPage() >= target && cards().length > 0 && pageSignature() !== startSig;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // While a page loads, the site hides both the cards and the pagination bar,
      // so wait for the page to finish loading before deciding anything.
      await waitFor(() => cards().length > 0, 45000, 500);
      if (arrived()) return 'ok'; // an earlier slow click went through after all
      if (urlPage() >= target) {
        // Already navigating to the target page — never click Next again (it would skip a page).
        if (await waitFor(arrived, 45000, 500)) return 'ok';
        await log(`Page ${target} is slow to load (attempt ${attempt}/3)…`, 'warn');
        continue;
      }
      const before = pageSignature();
      let next = buttonByText(document, 'Next');
      if (!next || next.disabled) {
        await sleep(3000); // re-check once in case the pagination bar was still re-rendering
        next = buttonByText(document, 'Next');
        if ((!next || next.disabled) && cards().length > 0) return 'end'; // loaded, and really no Next
        if (!next || next.disabled) continue;
      }
      next.scrollIntoView({ block: 'center' });
      await sleep(600);
      next.click();
      const changed = await waitFor(() => {
        const s = pageSignature();
        return s && s !== before && urlPage() >= target;
      }, 45000, 500);
      if (changed) {
        await sleep(rand(1500, 3000));
        return 'ok';
      }
      if (urlPage() >= target) {
        // URL moved but the list hasn't refreshed yet — wait a bit more before clicking again.
        if (await waitFor(() => pageSignature() && pageSignature() !== before, 20000, 500)) return 'ok';
      }
      await log(`Page ${target} is slow to load (attempt ${attempt}/3)…`, 'warn');
    }
    await chrome.storage.local.set({ pageNo: target, lastActive: Date.now() });
    await log(`Loading page ${target} directly…`, 'warn');
    location.href = `${SEARCH_PATH}?page=${target}`;
    return 'reload';
  }

  // ---------- connect dialog ----------
  function fillTemplate(info) {
    let msg = settings.template
      .replace(/\{firstName\}/gi, info.firstName || 'there')
      .replace(/\{name\}/gi, info.name || info.firstName || 'there')
      .replace(/\{location\}/gi, info.location || '');
    // The site rejects notes that start with a space or special character.
    return msg.trim().replace(/^[^A-Za-z0-9]+/, '');
  }

  function setTextarea(el, text) {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function toastText() {
    const t = [...document.querySelectorAll('[role="status"], [role="alert"], .Toastify__toast, [class*="toast" i]')]
      .filter(isVisible).map(textOf).join(' | ');
    return t;
  }

  // Returns 'sent' | 'failed' | 'limit'.
  async function sendTo(card, info) {
    card.connectBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rand(800, 1500));
    card.connectBtn.click();

    const dialog = await waitFor(() => visibleDialogs().find((d) => d.querySelector('textarea[name="message"]')), 6000);
    if (!dialog) {
      await closePromoPopups();
      if (visibleDialogs().some((d) => /premium|upgrade|limit/i.test(d.innerText))) return 'limit';
      await log(`Connect dialog did not open for ${info.name}.`, 'error');
      return 'failed';
    }

    const box = dialog.querySelector('textarea[name="message"]');
    setTextarea(box, fillTemplate(info));
    await sleep(rand(800, 1500));

    // NOTE: never click "Cancel" — on this site it also submits the form.
    if (!box.value.trim()) {
      await log(`Could not write the note for ${info.name} — closing the dialog.`, 'error');
      await closeDialog(dialog);
      return 'failed';
    }

    const send = buttonByText(dialog, 'Send');
    if (!send) {
      await log('Send button not found in dialog — closing it.', 'error');
      await closeDialog(dialog);
      return 'failed';
    }
    send.click();

    // The dialog closes after the request completes; a toast reports the result.
    let toast = '';
    await waitFor(() => {
      toast = toastText() || toast;
      return !dialogShown(dialog);
    }, 15000);
    await sleep(1200);
    toast = toastText() || toast;

    if (/limit|premium|upgrade/i.test(toast)) return 'limit';
    if (/fail|error|not found|cannot/i.test(toast)) {
      await log(`Site said: "${toast}"`, 'error');
      return 'failed';
    }
    if (dialogShown(dialog)) {
      await log(`Dialog did not close for ${info.name} — closing it.`, 'error');
      await closeDialog(dialog);
      return 'failed';
    }
    return 'sent';
  }

  // ---------- main loop ----------
  async function processPage() {
    const { sentKeys = [], skippedKeys = [] } = await chrome.storage.local.get(['sentKeys', 'skippedKeys']);
    const sent = new Set(sentKeys);
    const skipped = new Set(skippedKeys);
    let connectable = 0;

    for (const li of cards()) {
      if (!running) return null;
      const stop = await limitReached();
      if (stop) return stop;

      await closePromoPopups();
      const card = cardData(li);
      if (!card.connectBtn) continue; // no Connect button on the card → already handled
      connectable++;
      if (sent.has(card.slug) || skipped.has(card.slug)) continue;

      let info;
      try {
        info = await fetchProfile(card.slug);
      } catch (e) {
        await log(`Could not load ${card.name}'s profile (${e.message}). Skipping.`, 'warn');
        continue;
      }
      info.name = info.name || card.name;

      if (!ALLOWED_COUNTRIES.includes(info.country)) {
        skipped.add(card.slug);
        await chrome.storage.local.set({ skippedKeys: [...skipped].slice(-20000) });
        await log(`Skipped ${info.name} — ${info.location || 'no location'}.`);
        await sleep(rand(1000, 2500)); // gentle pace so the site doesn't throttle us
        continue;
      }

      const state = await profileButtonState(card.slug);
      if (state !== 'connect') {
        if (state) {
          skipped.add(card.slug);
          await chrome.storage.local.set({ skippedKeys: [...skipped].slice(-20000) });
        }
        const why = state === 'none' ? 'already connected' : state ? `"${state}" on profile` : 'profile did not load';
        await log(`Skipped ${info.name} (${info.location}) — ${why}.`);
        continue;
      }

      const result = await sendTo(card, info);
      if (result === 'limit') return 'The site reported a limit / premium requirement. Stopping.';
      if (result !== 'sent') continue;

      sent.add(card.slug);
      sentThisRun++;
      const s = await getStats();
      s.sentToday++;
      s.total = (s.total || 0) + 1;
      await chrome.storage.local.set({ stats: s, runSent: sentThisRun, sentKeys: [...sent].slice(-20000) });
      await log(`✓ Sent to ${info.name} (${info.location}). ${s.sentToday}/${settings.dailyLimit} today.`, 'success');

      const wait = rand(settings.minDelay, settings.maxDelay);
      await log(`Waiting ${wait}s…`);
      await pause(wait);
    }
    if (!connectable) await log('No "Connect" buttons on this page (all already requested).');
    return null;
  }

  async function run(resume = false) {
    if (running) return;
    running = true;
    const stored = await chrome.storage.local.get(['settings', 'runSent', 'pageNo']);
    settings = { ...DEFAULTS, ...(stored.settings || {}) };
    sentThisRun = resume ? stored.runSent || 0 : 0;
    let page = resume ? stored.pageNo || 1 : 1;
    if (!resume) await chrome.storage.local.set({ runSent: 0, pageNo: 1, reloads: 0 });

    await log(resume ? 'Bot resumed.' : 'Bot started.');
    let stopReason = null;
    try {
      if (!(await goToSearch())) { running = false; return; } // full page load in progress
      await sleep(1500);
      await closePromoPopups();
      const ready = await ensureCards();
      if (ready === 'reload') { running = false; return; }
      if (!ready) throw new Error(`Page ${urlPage()} still did not load after several retries. Try again later.`);

      // After a resume, jump straight to the page we were on.
      if (resume && page !== urlPage()) {
        await chrome.storage.local.set({ lastActive: Date.now() });
        location.href = `${SEARCH_PATH}?page=${page}`;
        running = false;
        return;
      }
      page = urlPage();

      while (running) {
        await chrome.storage.local.set({ pageNo: page });
        await log(`— Page ${page} —`);
        stopReason = await processPage();
        if (stopReason || !running) break;
        if (!settings.autoPaginate) { stopReason = 'Auto pagination is off.'; break; }
        await closePromoPopups();
        const moved = await nextPage();
        if (moved === 'reload') { running = false; return; }
        if (moved === 'end') { stopReason = `No more pages (no "Next" button after page ${page}).`; break; }
        page = urlPage();
      }
    } catch (e) {
      stopReason = 'Error: ' + e.message;
    }
    running = false;
    await chrome.storage.local.set({ running: false });
    if (stopReason) await log(stopReason, /Error|limit/i.test(stopReason) ? 'warn' : 'info');
    await log(`Bot stopped. Sent ${sentThisRun} this run.`);
  }

  // ---------- messaging ----------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'start') {
      chrome.storage.local.set({ running: true });
      run();
      reply({ ok: true });
    } else if (msg.type === 'stop') {
      running = false;
      chrome.storage.local.set({ running: false });
      reply({ ok: true });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (running && document.hidden) log('Tab is hidden — Chrome may slow the site down; the bot keeps going.', 'warn');
  });

  // Resume after a full page load if the bot was active within the last 3 minutes.
  chrome.storage.local.get(['running', 'lastActive']).then(({ running: wasRunning, lastActive = 0 }) => {
    if (!wasRunning) return;
    if (Date.now() - lastActive < 180000) setTimeout(() => run(true), 3000);
    else chrome.storage.local.set({ running: false });
  });
})();
