window.__ytSummarizer = window.__ytSummarizer || {};

(function (ns) {
  const BTN_CLASS = 'yts-summarize-btn';
  const ID_ATTR = 'data-yts-video-id';
  const HIDDEN_ATTR = 'data-yts-hidden';

  // Session-only: which videoIds the user Skipped. Resets on page reload,
  // intentionally not persisted anywhere.
  ns.hiddenVideoIds = ns.hiddenVideoIds || new Set();

  // Videos that already have a stored summary. Kept in sync from content.js;
  // declared here because this file is what reads it. Opening one of these is
  // free, so the button advertises that rather than looking like a fresh run.
  ns.summarisedIds = ns.summarisedIds || new Set();

  const LABEL_IDLE = 'Summarise';
  const LABEL_DONE = 'Summarised';

  const ICON_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '</svg>';

  // Resolve the overlay mount by trying the surface's candidate selectors in
  // order, and say which one won exactly once so a future YouTube markup
  // change shows up as a visible log rather than a mispositioned button.
  let reportedMount = false;
  function resolveMount(card, surface) {
    for (const selector of surface.thumbnailSelectors) {
      const el = card.querySelector(selector);
      if (el) {
        if (!reportedMount) {
          reportedMount = true;
          console.log('[yts] overlay mount resolved via "%s"', selector);
        }
        return el;
      }
    }
    if (!reportedMount) {
      reportedMount = true;
      console.warn(
        '[yts] no thumbnail container matched %o - falling back to the card, so the button will sit under the thumbnail instead of on it',
        surface.thumbnailSelectors
      );
    }
    return card;
  }

  function ensurePositioned(el) {
    if (getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }
  }

  function createButton(videoId, surface) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS;
    btn.setAttribute(ID_ATTR, videoId);
    // /watch runs two surfaces at once, so the button has to carry its own
    // rather than the click handler guessing from the pathname.
    if (surface) btn.setAttribute('data-yts-surface', surface.name);
    ns.applyIdleState(btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentId = btn.getAttribute(ID_ATTR);
      ns.handleSummarizeClick(currentId, btn);
    });
    return btn;
  }

  // Watch-page variant: same button, but sits in normal flow under the player
  // rather than being absolutely positioned over a thumbnail.
  ns.createInlineButton = function (videoId, surface) {
    const btn = createButton(videoId, surface);
    btn.classList.add('yts-inline');
    return btn;
  };

  ns.setButtonLabel = function (btn, label) {
    btn.innerHTML = ICON_SVG + `<span>${label}</span>`;
  };

  // The resting label depends on whether this video has been summarised
  // before, so every path back to "not busy" goes through here.
  ns.applyIdleState = function (btn) {
    const done = ns.summarisedIds.has(btn.getAttribute(ID_ATTR));
    btn.classList.toggle('yts-summarised', done);
    ns.setButtonLabel(btn, done ? LABEL_DONE : LABEL_IDLE);
  };

  ns.resetButtonState = function (btn) {
    btn.classList.remove('yts-loading', 'yts-error');
    btn.disabled = false;
    ns.applyIdleState(btn);
  };

  // Called when the summarised set changes underneath buttons that are already
  // on screen. Buttons mid-run own their own label until they finish.
  ns.repaintButtonStates = function () {
    document.querySelectorAll(`.${BTN_CLASS}`).forEach((btn) => {
      if (btn.disabled || btn.classList.contains('yts-error')) return;
      ns.applyIdleState(btn);
    });
  };

  function applyHiddenState(card, videoId) {
    const shouldHide = ns.hiddenVideoIds.has(videoId);
    const isHidden = card.getAttribute(HIDDEN_ATTR) === 'true';
    if (shouldHide && !isHidden) {
      card.setAttribute(HIDDEN_ATTR, 'true');
      card.style.display = 'none';
    } else if (!shouldHide && isHidden) {
      card.removeAttribute(HIDDEN_ATTR);
      card.style.display = '';
    }
  }

  ns.skipVideo = function (videoId, card) {
    ns.hiddenVideoIds.add(videoId);
    if (card) applyHiddenState(card, videoId);
  };

  // Called on every observer pass for every currently-matched card. Dedupes
  // by videoId, not by "does a button already exist" - see bug 2.
  ns.syncCardButton = function (card, surface) {
    const videoId = surface.getVideoId(card);
    if (!videoId) return;

    applyHiddenState(card, videoId);

    // This now runs on a timer and on scroll as well as on mutations, so the
    // already-correct case - by far the common one - gets out before touching
    // the five-selector mount lookup.
    const btn = card.querySelector(`.${BTN_CLASS}`);
    if (!btn) {
      const mount = resolveMount(card, surface);
      ensurePositioned(mount);
      mount.appendChild(createButton(videoId, surface));
      return true;
    }

    const stampedId = btn.getAttribute(ID_ATTR);
    if (stampedId !== videoId) {
      // This card node was recycled to a different video underneath an
      // existing button - restamp rather than creating a new one. The id has to
      // change before the state is reapplied, or the new video inherits the
      // previous one's "Summarised" label.
      btn.setAttribute(ID_ATTR, videoId);
      ns.resetButtonState(btn);
      if (ns.panel && typeof ns.panel.closeIfAnchoredTo === 'function') {
        ns.panel.closeIfAnchoredTo(btn);
      }
    }
    return false;
  };
})(window.__ytSummarizer);
