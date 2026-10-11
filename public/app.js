(() => {
  const form = document.querySelector('.prompt');
  const input = form?.querySelector('input[name="idea"]');
  const button = form?.querySelector('button');
  const toast = document.querySelector('.toast');
  const bubble = document.querySelector('.queue-bubble');
  const popup = document.querySelector('.queue-popup');
  const closeButton = document.querySelector('.queue-close');
  const activeList = document.querySelector('.active-list');
  const historyList = document.querySelector('.history-list');
  const countBadge = document.querySelector('.queue-count');
  const scrollBox = document.querySelector('.queue-scroll');
  const sentinel = document.querySelector('.history-sentinel');
  const loadingNote = document.querySelector('.history-loading');
  const endNote = document.querySelector('.history-end');
  if (!form || !input || !button || !bubble || !popup) return;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const requesterStorageKey = 'commons-requester-id';
  function newRequesterId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
      const random = Math.random() * 16 | 0;
      return (char === 'x' ? random : (random & 3 | 8)).toString(16);
    });
  }
  let requesterId;
  try {
    requesterId = localStorage.getItem(requesterStorageKey);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requesterId || '')) {
      requesterId = newRequesterId();
      localStorage.setItem(requesterStorageKey, requesterId);
    }
  } catch { requesterId = newRequesterId(); }

  let toastTimer;
  function showToast(message, kind = 'success') {
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
  }
  async function watchBuild(statusUrl) {
    for (;;) {
      await sleep(2200);
      try {
        const response = await fetch(statusUrl, { cache: 'no-store' });
        if (!response.ok) continue;
        const status = await response.json();
        if (status.state === 'done') {
          await refreshCanvas();
          refreshActive();
          if (loadedHistory) loadHistory(true);
          return;
        }
        if (status.state === 'failed') {
          refreshActive();
          if (loadedHistory) loadHistory(true);
          showToast(status.message || 'Could not build that change', 'error');
          return;
        }
      } catch { /* Keep checking; the queue itself remains the source of truth. */ }
    }
  }
  async function refreshCanvas() {
    try {
      const response = await fetch('/', { cache: 'no-store' });
      if (!response.ok) return;
      const html = await response.text();
      const documentCopy = new DOMParser().parseFromString(html, 'text/html');
      const updatedFrame = documentCopy.querySelector('#canvas-frame');
      const currentFrame = document.querySelector('#canvas-frame');
      if (updatedFrame && currentFrame) currentFrame.srcdoc = updatedFrame.srcdoc;
    } catch { /* A later page visit will show the latest saved canvas. */ }
  }
  function friendlyStatus(request) {
    if (request.status === 'building') return 'Building now';
    if (request.status === 'queued') return request.position > 1 ? `#${request.position} in line` : 'Up next';
    if (request.status === 'done') return 'Added';
    return 'Could not build';
  }
  function shortTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function makeItem(request) {
    const item = document.createElement('li');
    item.className = 'queue-item';
    if (request.requester_id === requesterId) item.classList.add('queue-item-mine');
    const idea = document.createElement('p');
    idea.className = 'queue-idea';
    idea.textContent = request.idea;
    const meta = document.createElement('div');
    meta.className = 'queue-meta';
    const person = document.createElement('span');
    person.className = 'queue-person';
    person.textContent = request.requester_id === requesterId ? 'You' : request.requester_label;
    const state = document.createElement('span');
    state.className = `queue-state queue-state-${request.status}`;
    state.textContent = friendlyStatus(request);
    const time = shortTime(request.status === 'building' ? request.started_at : request.completed_at || request.created_at);
    const timestamp = document.createElement('time');
    timestamp.className = 'queue-time';
    timestamp.dateTime = request.completed_at || request.started_at || request.created_at || '';
    timestamp.textContent = time;
    meta.append(person, timestamp, state);
    item.append(idea, meta);
    return item;
  }
  function renderActive(requests, pendingCount) {
    if (!activeList) return;
    activeList.replaceChildren();
    if (!requests.length) {
      const empty = document.createElement('li');
      empty.className = 'queue-empty';
      empty.textContent = 'Nothing is being built right now.';
      activeList.append(empty);
    } else requests.forEach(request => activeList.append(makeItem(request)));
    if (countBadge) {
      countBadge.textContent = String(pendingCount ?? requests.length);
      countBadge.setAttribute('aria-label', `${pendingCount ?? requests.length} active requests`);
    }
  }
  let previousActiveIds = null;
  async function refreshActive() {
    try {
      const response = await fetch('/api/requests/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load requests');
      const data = await response.json();
      const requests = data.requests || [];
      const activeIds = new Set(requests.map(request => request.id));
      const finishedARequest = previousActiveIds && [...previousActiveIds].some(id => !activeIds.has(id));
      previousActiveIds = activeIds;
      renderActive(requests, data.pendingCount);
      if (finishedARequest && loadedHistory) loadHistory(true);
    } catch {
      if (activeList && !activeList.children.length) {
        const unavailable = document.createElement('li');
        unavailable.className = 'queue-empty';
        unavailable.textContent = 'The queue is temporarily unavailable.';
        activeList.append(unavailable);
      }
    }
  }

  let nextCursor = null;
  let loadedHistory = false;
  let loadingHistory = false;
  let historyHasMore = true;
  let historyNeedsRefresh = false;
  async function loadHistory(reset = false) {
    if (!historyList) return;
    if (loadingHistory) {
      if (reset) historyNeedsRefresh = true;
      return;
    }
    if (!historyHasMore && !reset) return;
    loadingHistory = true;
    if (loadingNote) loadingNote.hidden = false;
    if (endNote) endNote.hidden = true;
    try {
      if (reset) {
        historyList.replaceChildren();
        nextCursor = null;
        historyHasMore = true;
      }
      const url = new URL('/api/requests', window.location.origin);
      if (nextCursor) url.searchParams.set('cursor', nextCursor);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load request history');
      const data = await response.json();
      const requests = data.requests || [];
      requests.forEach(request => historyList.append(makeItem(request)));
      nextCursor = data.nextCursor || null;
      historyHasMore = Boolean(nextCursor);
      loadedHistory = true;
      if (!historyList.children.length) {
        const empty = document.createElement('li');
        empty.className = 'queue-empty';
        empty.textContent = 'No recent requests yet.';
        historyList.append(empty);
      }
      if (endNote) endNote.hidden = historyHasMore;
    } catch {
      if (!historyList.children.length) {
        const unavailable = document.createElement('li');
        unavailable.className = 'queue-empty';
        unavailable.textContent = 'Request history is temporarily unavailable.';
        historyList.append(unavailable);
      }
      historyHasMore = false;
    } finally {
      loadingHistory = false;
      if (loadingNote) loadingNote.hidden = true;
      if (historyNeedsRefresh) {
        historyNeedsRefresh = false;
        queueMicrotask(() => loadHistory(true));
      }
    }
  }
  const historyObserver = sentinel && 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting) && popupOpen() && loadedHistory) loadHistory();
      }, { root: scrollBox, rootMargin: '100px' })
    : null;
  historyObserver?.observe(sentinel);
  function popupOpen() { return popup.classList.contains('is-open'); }
  function openPopup() {
    popup.classList.add('is-open');
    popup.setAttribute('aria-hidden', 'false');
    popup.inert = false;
    bubble.setAttribute('aria-expanded', 'true');
    if (!loadedHistory) loadHistory();
    closeButton?.focus();
  }
  function closePopup() {
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
    popup.inert = true;
    bubble.setAttribute('aria-expanded', 'false');
    bubble.focus();
  }
  bubble.addEventListener('click', () => popupOpen() ? closePopup() : openPopup());
  closeButton?.addEventListener('click', closePopup);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && popupOpen()) closePopup(); });
  document.addEventListener('pointerdown', event => {
    if (popupOpen() && !popup.contains(event.target) && !bubble.contains(event.target)) closePopup();
  });
  refreshActive();
  window.setInterval(refreshActive, 2500);

  let submitting = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const idea = input.value.trim();
    if (!idea) return;
    submitting = true;
    button.disabled = true;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({ idea, requesterId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not queue that request. Try again.');
      input.value = '';
      showToast('Added to queue');
      await invalidateQueue();
      void watchBuild(data.statusUrl);
    } catch (error) {
      showToast(error.message || 'Could not add that request', 'error');
    } finally {
      submitting = false;
      button.disabled = false;
    }
  });
  async function invalidateQueue() {
    await refreshActive();
    if (loadedHistory) await loadHistory(true);
  }
})();
