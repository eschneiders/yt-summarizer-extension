(function () {
  const ns = (window.__ytSummarizer = window.__ytSummarizer || {});

  // Bug 6: reloading the extension at chrome://extensions orphans old
  // content scripts on already-open tabs. The isolated world persists for
  // the life of the frame, so this flag on `window` survives re-injection
  // and stops us from double-attaching observers/listeners.
  if (ns.loaded) {
    console.log('[yts] already loaded in this frame, skipping re-init');
    return;
  }
  ns.loaded = true;

  // m.youtube.com is a different app with a `ytm-*` DOM that none of our
  // selectors match. We register on it purely so this says so out loud -
  // silence here is indistinguishable from a broken extension.
  if (location.hostname === 'm.youtube.com') {
    console.warn(
      '[yts] mobile site (m.youtube.com) is not supported - this build targets the desktop feed. ' +
        'If you did not mean to be here, turn off the DevTools device toolbar (Cmd+Shift+M) and reload www.youtube.com.'
    );
    return;
  }

  const DEBOUNCE_MS = 150;
  // Ceiling on how long an unbroken mutation stream may postpone a pass - see
  // the comment on `scheduler`.
  const MAX_WAIT_MS = 800;
  // Backstop for cards that finish hydrating without mutating the tree we
  // observe, and for observers whose target YouTube swapped out from under us.
  const SWEEP_MS = 2000;

  // Streaming path: deltas arrive over a Port and render as markdown prefixes,
  // so the panel fills in as text lands.
  function summarizeStreaming(request, onDelta) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let port;
      try {
        port = chrome.runtime.connect({ name: 'yts-stream' });
      } catch (err) {
        finish({ ok: false, error: err.message });
        return;
      }

      port.onMessage.addListener((msg) => {
        if (msg.type === 'delta') onDelta(msg.text);
        else if (msg.type === 'fallback') {
          console.warn('[yts] streaming unavailable (%s), waiting for full response', msg.reason);
          onDelta(null);
        } else if (msg.type === 'done') {
          finish(msg.result);
          port.disconnect();
        } else if (msg.type === 'error') {
          finish({ ok: false, code: msg.code, error: msg.error });
          port.disconnect();
        }
      });

      port.onDisconnect.addListener(() =>
        finish({ ok: false, error: 'Connection to the extension closed.' })
      );
      port.postMessage(request);
    });
  }

  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(response);
      });
    });
  }

  // Which videos *this user* has already been billed for. Only those are free
  // to open again, so only those get the "Summarised" label - a video someone
  // else summarised still costs this reader their minutes.
  ns.refreshSummarisedIds = async function () {
    try {
      const res = await sendMessage({ type: 'YTS_MINE_IDS' });
      if (!res || !res.ok) return;
      const unchanged =
        res.ids.length === ns.summarisedIds.size && res.ids.every((id) => ns.summarisedIds.has(id));
      if (unchanged) return; // avoid repainting every button on every sweep
      ns.summarisedIds = new Set(res.ids);
      ns.repaintButtonStates();
    } catch (err) {
      console.warn('[yts] could not read the summarised list:', err.message);
    }
  };

  // The balance as it will be once this video is billed. Returns the last
  // known figure unchanged when there is nothing to deduct, and null when no
  // figure is known yet - a projection from nothing would be a guess.
  ns.projectQuota = function (durationSeconds, alreadyMine) {
    const base = ns.lastQuota;
    if (!base) return null;
    if (alreadyMine || !durationSeconds) return base;
    return {
      ...base,
      usedSeconds: base.usedSeconds + durationSeconds,
      remainingSeconds: Math.max(0, base.remainingSeconds - durationSeconds),
      projected: true,
    };
  };

  ns.recordVote = async function (videoId, vote) {
    try {
      return await sendMessage({ type: 'YTS_VOTE', videoId, vote });
    } catch (err) {
      console.warn('[yts] vote failed', err.message);
      return { ok: false };
    }
  };

  ns.handleSummarizeClick = async function (videoId, btn, options) {
    const surface =
      ns.getSurfaceByName(btn.getAttribute('data-yts-surface')) || ns.getCurrentSurface();
    if (!surface) return;
    const card = (surface.cardSelector && btn.closest(surface.cardSelector)) || btn.parentElement;

    // Clicking the button of an already-open panel toggles it shut.
    if (!options && ns.panel.isOpenFor(videoId)) {
      ns.panel.close();
      return;
    }

    console.log('[yts] Summarise clicked for video', videoId);

    const meta = surface.readMeta ? surface.readMeta() : ns.readCardMeta(card);
    const durationSeconds = surface.getDurationSeconds
      ? surface.getDurationSeconds()
      : ns.readCardDurationSeconds(card);

    // The server refuses an unmeterable request, so this is a loud failure
    // rather than a silent free summary - but the console should say which
    // card it was, because the cause is a YouTube markup change on that
    // card, not anything the user did.
    if (!durationSeconds) {
      console.warn(
        '[yts] could not read a duration for %s from this card - the duration badge selectors in panel.js need updating. Card:',
        videoId,
        card
      );
    }

    // Show what the balance is about to be, rather than what it was. A
    // generation takes tens of seconds, and leaving the old figure up for all
    // of that reads as the counter being broken - which is exactly how it was
    // reported. The server's real figure replaces this the moment it lands, so
    // the projection is only ever on screen while the answer is unknown.
    //
    // Nothing is deducted for a video that is already this user's: re-opening
    // one is free, so the balance genuinely will not move.
    meta.quota = ns.projectQuota(durationSeconds, ns.summarisedIds.has(videoId));

    btn.disabled = true;
    btn.classList.add('yts-loading');
    ns.setButtonLabel(btn, 'Summarising…');
    ns.panel.openLoading(btn, card, videoId, surface, meta);

    try {
      // Re-rendering on every delta would thrash layout, so redraw at most a
      // few times a second.
      let lastPaint = 0;
      const paintPartial = (text) => {
        if (text === null) return; // fell back to the blocking path
        const now = Date.now();
        if (now - lastPaint < 400) return;
        lastPaint = now;
        // Markdown renders as a prefix directly - no repair step needed.
        ns.panel.renderPartial(text, meta, videoId);
      };

      const res = await summarizeStreaming({ videoId, durationSeconds }, paintPartial);

      // The card may have been recycled to a different video while Gemini was
      // working - in that case this summary no longer belongs on screen.
      if (btn.getAttribute('data-yts-video-id') !== videoId) {
        console.warn('[yts] card recycled while summarising %s, discarding result', videoId);
        return;
      }

      if (!res || !res.ok) {
        const code = res && res.code;
        console.error('[yts] summarise failed for %s: %s', videoId, res && res.error);
        ns.panel.renderError((res && res.error) || 'Unknown error', {
          // Both mean "this extension is not pointed at a working service",
          // which is a settings problem rather than a video problem.
          needsSettings: code === 'NO_SERVICE' || code === 'OFFLINE',
          quota: code === 'QUOTA_EXCEEDED' ? res.quota : null,
          // Signing in is one click, so offer it here rather than sending
          // someone to the settings page to find it.
          onSignIn:
            code === 'SIGN_IN_REQUIRED'
              ? async () => {
                  const result = await sendMessage({ type: 'YTS_SIGN_IN' });
                  if (result && result.ok) {
                    ns.resetButtonState(btn);
                    ns.handleSummarizeClick(videoId, btn);
                  }
                }
              : null,
        });
        btn.classList.remove('yts-loading');
        btn.classList.add('yts-error');
        // Running out of the weekly allowance is not a failure, so it should
        // not read like one on the button.
        ns.setButtonLabel(btn, code === 'QUOTA_EXCEEDED' ? 'Limit reached' : 'Error');
        btn.disabled = false;
        setTimeout(() => ns.resetButtonState(btn), 4000);
        return;
      }

      console.log(
        '[yts] %s: %s',
        videoId,
        res.generated ? 'generated fresh' : 'served from the shared store, nothing generated'
      );
      ns.summarisedIds.add(videoId);
      meta.stats = res.stats || null;
      meta.quota = res.quota || null;
      // Remembered so the next panel can show the allowance immediately,
      // rather than only once its own summary has finished arriving.
      if (res.quota) ns.lastQuota = res.quota;
      meta.yourVote = res.stats ? res.stats.yourVote : null;
      ns.panel.renderSummary(res.markdown, meta, videoId);
      ns.resetButtonState(btn);
    } catch (err) {
      console.error('[yts] summarise threw for', videoId, err);
      ns.panel.renderError(err.message);
      ns.resetButtonState(btn);
    }
  };

  function processGrid(surface) {
    const cards = document.querySelectorAll(surface.cardSelector);
    let created = 0;
    cards.forEach((card) => {
      if (ns.syncCardButton(card, surface)) created += 1;
    });
    // The panel is an in-flow child of a container YouTube re-renders freely,
    // so confirm it is still sitting after its anchor row.
    ns.panel.syncPlacement(surface);
    return { cards: cards.length, created };
  }

  // Bug 7: a plain trailing debounce is the wrong tool here, and it is why
  // buttons never appeared on cards loaded by scrolling. A YouTube feed mutates
  // *continuously* while you scroll - lazy images, hover previews, the grid's
  // own row recycling - so the trailing timer was reset faster than it could
  // ever fire, and the pass that stamps new cards was starved for exactly as
  // long as scrolling continued. Same story under ytd-watch-flexy, which
  // mutates non-stop during playback.
  //
  // So: still coalesce bursts, but never let an unbroken stream delay a pass by
  // more than maxWait.
  function scheduler(fn, wait, maxWait) {
    let timer = null;
    let pendingSince = 0;
    const invoke = () => {
      clearTimeout(timer);
      timer = null;
      pendingSince = 0;
      fn();
    };
    return () => {
      const now = Date.now();
      if (!pendingSince) pendingSince = now;
      if (now - pendingSince >= maxWait) return invoke();
      clearTimeout(timer);
      timer = setTimeout(invoke, wait);
    };
  }

  // ns.observers holds anything with a disconnect(); this lets timers and
  // listeners be torn down by the same loop as the MutationObservers.
  function intervalHandle(id) {
    return { disconnect: () => clearInterval(id) };
  }

  function teardownObserver() {
    (ns.observers || []).forEach((o) => o.disconnect());
    ns.observers = [];
  }

  // Bumped on every (re)setup so a retry timer scheduled before a soft
  // navigation cannot attach a second observer for a surface we have left.
  let generation = 0;

  // The watch page has one video rather than a grid, so instead of stamping
  // cards we inject a single bar under the player that owns the button and
  // acts as the panel's anchor.
  function setupSingleSurface(surface) {
    const videoId = surface.getVideoId();
    if (!videoId) {
      console.warn('[yts] on %s but no videoId in the URL', location.pathname);
      return;
    }

    let host = null;
    let matched = null;
    for (const selector of surface.hostSelectors) {
      host = document.querySelector(selector);
      if (host) {
        matched = selector;
        break;
      }
    }
    if (!host) {
      // No retry timer needed: the observer and the sweep both call back here.
      return;
    }

    let bar = document.querySelector('.yts-watch-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'yts-watch-bar';
      host.parentElement.insertBefore(bar, host);
      console.log('[yts] watch bar inserted before "%s"', matched);
    }

    const existing = bar.querySelector('.yts-summarize-btn');
    if (existing && existing.getAttribute('data-yts-video-id') === videoId) return;

    // Navigating between videos reuses the whole page, so rebuild the button
    // for the new videoId and drop any panel from the previous video.
    bar.innerHTML = '';
    ns.panel.close();
    bar.appendChild(ns.createInlineButton(videoId, surface));
    console.log('[yts] watch surface ready for %s', videoId);
  }

  function setupSurface(surface, retry, gen) {
    if (gen !== generation) return; // a navigation superseded this attempt

    if (surface.kind === 'single') {
      setupSingleSurface(surface);
      // The watch page rebuilds its metadata block asynchronously, so keep
      // watching it rather than assuming one pass is enough.
      const target = document.querySelector('ytd-watch-flexy') || document.body;
      const run = scheduler(() => setupSingleSurface(surface), DEBOUNCE_MS, MAX_WAIT_MS);
      const observer = new MutationObserver(run);
      observer.observe(target, { childList: true, subtree: true });
      ns.observers.push(observer);
      ns.observers.push(intervalHandle(setInterval(run, SWEEP_MS)));
      console.log('[yts] observer attached for surface', surface.name);
      return;
    }

    let grid = document.querySelector(surface.gridSelector);
    if (!grid) {
      // The related rail in particular renders well after the player, so give
      // each surface its own bounded retry instead of restarting everything.
      if (retry < 10) {
        setTimeout(() => setupSurface(surface, retry + 1, gen), 500);
      } else {
        console.warn(
          '[yts] surface "%s" gave up waiting for grid: %s',
          surface.name,
          surface.gridSelector
        );
      }
      return;
    }

    const run = scheduler(
      () => {
        // YouTube replaces the whole grid container on a feed reload (filter
        // chips, the "new videos" refresh). The MutationObserver is then bound
        // to a detached node and can never fire again, which looked like the
        // extension dying halfway through a session. Rebuild instead.
        if (!grid.isConnected) {
          console.warn('[yts] grid for "%s" was detached, re-attaching', surface.name);
          setupForCurrentSurface();
          return;
        }
        const { cards, created } = processGrid(surface);
        if (created) {
          console.log(
            '[yts] stamped %d new card(s) on surface "%s" (%d visible)',
            created,
            surface.name,
            cards
          );
        }
      },
      DEBOUNCE_MS,
      MAX_WAIT_MS
    );

    run();

    const observer = new MutationObserver(run);
    observer.observe(grid, { childList: true, subtree: true });
    ns.observers.push(observer);

    // Belt and braces for the infinite feed. Scrolling is the signal that
    // always precedes new cards, and the slow sweep catches cards that filled
    // in their /watch? href after the observer had already run for that batch.
    window.addEventListener('scroll', run, { passive: true });
    ns.observers.push({
      disconnect: () => window.removeEventListener('scroll', run),
    });
    ns.observers.push(intervalHandle(setInterval(run, SWEEP_MS)));

    console.log('[yts] observer attached for surface', surface.name, grid);
  }

  function setupForCurrentSurface() {
    teardownObserver();
    generation += 1;
    const gen = generation;

    // Which videos already have a summary decides whether a button reads
    // "Summarise" or "Summarised", so refresh it before the first stamping pass
    // and let the sweep pick up anything that lands later.
    ns.refreshSummarisedIds();

    const surfaces = ns.getActiveSurfaces();
    if (!surfaces.length) {
      console.log('[yts] no matching surface for', location.pathname, '- idle');
      return;
    }

    console.log(
      '[yts] %d active surface(s) on %s: %s',
      surfaces.length,
      location.pathname,
      surfaces.map((s) => s.name).join(', ')
    );
    surfaces.forEach((s) => setupSurface(s, 0, gen));
  }

  // Summarising a video on the watch page (or in another tab) should turn its
  // card in this feed into "Summarised" straight away, not on the next
  // navigation.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k.startsWith('mine:'))) ns.refreshSummarisedIds();
    // The allowance changed - possibly from a summary in another tab. Update
    // whatever is on screen rather than waiting for the next panel to open.
    if (changes.quota) {
      ns.lastQuota = changes.quota.newValue || null;
      ns.panel.updateQuota(ns.lastQuota);
    }
  });

  // Seeded from storage so the very first panel of a session shows a figure
  // instead of a gap, without needing a request of its own.
  chrome.storage.local.get(['quota']).then(({ quota }) => {
    if (quota) ns.lastQuota = quota;
  });

  // Bug 1: YouTube is an SPA - navigating between feeds does not reload the
  // page, so re-run setup on every soft navigation.
  document.addEventListener('yt-navigate-finish', () => {
    console.log('[yts] yt-navigate-finish ->', location.pathname);
    setupForCurrentSurface();
  });

  setupForCurrentSurface();
})();
