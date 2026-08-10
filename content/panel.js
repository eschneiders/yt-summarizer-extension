window.__ytSummarizer = window.__ytSummarizer || {};

(function (ns) {
  // The panel is inserted into the feed grid as a full-width row after the row
  // holding the clicked card, rather than floating above the page. It is in
  // normal flow, so it scrolls with the feed and pushes later rows down - an
  // accordion, not an overlay.
  //
  // The cost of this choice (flagged when we picked it): the grid is managed
  // by YouTube's own renderer and recycles nodes, so a foreign child can be
  // moved or dropped at any time. syncPanelPlacement below re-validates the
  // panel on every observer pass and removes it once its anchor is gone.

  let el = null;
  let anchorBtn = null;
  let anchorCard = null;
  let anchorVideoId = null;
  let anchorSurface = null;
  let escBound = false;
  let tickHandle = null;

  // ---------- helpers ----------

  function timestampToSeconds(ts) {
    if (!ts) return 0;
    return String(ts)
      .trim()
      .split(':')
      .map((p) => parseInt(p, 10) || 0)
      .reduce((acc, p) => acc * 60 + p, 0);
  }

  ns.timestampToSeconds = timestampToSeconds;

  function watchUrl(videoId, ts) {
    const base = `https://www.youtube.com/watch?v=${videoId}`;
    const secs = timestampToSeconds(ts);
    return secs > 0 ? `${base}&t=${secs}` : base;
  }

  function readingTimeMinutes(markdown) {
    const words = String(markdown || '').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 200));
  }

  // Card metadata is scraped from the DOM rather than requested from Gemini -
  // it is already on screen, and asking for it would cost tokens and risk
  // hallucinated titles.
  function readCardMeta(card) {
    const titleEl = card.querySelector('#video-title, h3 a, a.yt-lockup-metadata-view-model__title');
    const channelEl = card.querySelector(
      '#channel-name a, ytd-channel-name a, .yt-content-metadata-view-model__metadata-row a'
    );
    const img = card.querySelector('img');
    const durationEl = card.querySelector(
      'ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text, .ytThumbnailOverlayBadgeViewModelHost'
    );
    return {
      title: titleEl ? titleEl.textContent.trim() : 'Untitled',
      channel: channelEl ? channelEl.textContent.trim() : '',
      thumb: img && img.src && !img.src.startsWith('data:') ? img.src : null,
      duration: durationEl ? durationEl.textContent.trim().split('\n')[0].trim() : '',
    };
  }

  ns.readCardMeta = readCardMeta;

  ns.readCardDurationSeconds = function (card) {
    return timestampToSeconds(readCardMeta(card).duration);
  };

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------- placement ----------

  // Find the element the panel should sit directly after: the whole visual row
  // containing the card, so the panel spans the grid instead of splitting it.
  function findInsertAfter(card, surface) {
    // Single-video surfaces anchor to the injected bar itself, so the panel
    // lands directly under the player and above the description.
    if (surface.kind === 'single') {
      return card.closest('.yts-watch-bar') || card;
    }

    const row = card.closest('ytd-rich-grid-row');
    if (row && row.parentElement) return row;

    // No row wrapper - cards are direct children of the grid container, so
    // group by vertical offset to find the last card on the same visual line.
    const container = card.parentElement;
    if (!container) return card;
    const cards = Array.from(container.children).filter(
      (c) => c.matches && c.matches(surface.cardSelector)
    );
    const top = card.offsetTop;
    let last = card;
    cards.forEach((c) => {
      if (Math.abs(c.offsetTop - top) < 4) last = c;
    });
    return last;
  }

  const POPUP_WIDTH = 560;
  const POPUP_MARGIN = 16;

  // Popups are position:absolute in PAGE coordinates (not fixed), so they
  // scroll with the document instead of hovering over whatever is beneath.
  function positionPopup() {
    if (!el || !anchorCard) return;
    const rect = anchorCard.getBoundingClientRect();
    const width = Math.min(POPUP_WIDTH, window.innerWidth - POPUP_MARGIN * 2);
    el.style.width = `${width}px`;

    // The related rail hugs the right edge, so a popup wider than the card has
    // to be pulled left to stay on screen.
    let left = rect.left + window.scrollX;
    const maxLeft = window.scrollX + window.innerWidth - width - POPUP_MARGIN;
    const minLeft = window.scrollX + POPUP_MARGIN;
    if (left > maxLeft) left = maxLeft;
    if (left < minLeft) left = minLeft;

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(rect.top + window.scrollY)}px`;
  }

  function mount(card, surface) {
    if (surface.panelMode === 'popup') {
      el.classList.add('yts-popup');
      if (el.parentElement !== document.body) document.body.appendChild(el);
      positionPopup();
      return true;
    }

    const after = findInsertAfter(card, surface);
    const parent = after.parentElement;
    if (!parent) return false;
    if (el.previousElementSibling === after && el.parentElement === parent) return true;
    parent.insertBefore(el, after.nextSibling);
    return true;
  }

  function onKeydown(e) {
    if (e.key === 'Escape') ns.panel.close();
  }

  function ensureEl(card, surface) {
    if (!el) {
      el = h('div', 'yts-panel');
      el.setAttribute('data-yts-panel', 'true');
    }
    mount(card, surface);
    if (!escBound) {
      escBound = true;
      document.addEventListener('keydown', onKeydown, true);
      window.addEventListener('resize', positionPopup);
    }
    // Expand on the next frame so the collapsed height is rendered first and
    // the transition actually runs.
    requestAnimationFrame(() => el && el.classList.add('yts-open'));
    return el;
  }

  function setContent(nodes) {
    el.innerHTML = '';
    const inner = h('div', 'yts-panel-inner');
    nodes.forEach((n) => inner.appendChild(n));
    el.appendChild(inner);
  }

  // ---------- rendering ----------

  function renderHeader(meta, summary, videoId) {
    const header = h('div', 'yts-panel-header');

    const thumbWrap = h('div', 'yts-panel-thumb');
    if (meta.thumb) {
      const img = document.createElement('img');
      img.src = meta.thumb;
      img.alt = '';
      thumbWrap.appendChild(img);
    }
    if (meta.duration) thumbWrap.appendChild(h('span', 'yts-panel-duration', meta.duration));
    header.appendChild(thumbWrap);

    const info = h('div', 'yts-panel-headinfo');
    info.appendChild(h('div', 'yts-panel-title', meta.title));
    if (meta.channel) info.appendChild(h('div', 'yts-panel-channel', meta.channel));

    const bits = [`${readingTimeMinutes(summary)} min read`];
    // Only shown when the service is reachable and someone else has actually
    // been here - "0 others" is noise, and an unreachable service must not
    // silently render as nobody having read it.
    const others = meta.stats && meta.stats.others;
    if (others > 0) {
      bits.push(others === 1 ? '1 other person summarised this' : `${others} others summarised this`);
    }
    info.appendChild(h('div', 'yts-panel-meta', bits.join(' · ')));
    header.appendChild(info);

    const close = h('button', 'yts-collapse', '');
    close.type = 'button';
    close.title = 'Collapse (Esc)';
    close.setAttribute('aria-label', 'Collapse summary');
    close.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    close.addEventListener('click', () => ns.panel.close());
    header.appendChild(close);

    return header;
  }

  // ---------- markdown rendering ----------
  //
  // Gemini now returns free-form markdown rather than a fixed JSON shape, so
  // this parses the subset it actually emits: headings, ordered and unordered
  // lists, bold/italic/code, links, and paragraphs. Everything is built with
  // textContent, never innerHTML, so model output cannot inject markup.

  const TIMESTAMP_RE = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;

  // Matches, in priority order: a markdown link (tolerating the [[ts](url)]
  // double-bracket form), bold, italic, inline code, then a bare timestamp.
  const INLINE_RE =
    /\[?\[([^\]]+)\]\(([^)]+)\)\]?|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/g;

  function makeChip(label, videoId) {
    const chip = document.createElement('a');
    chip.className = 'yts-chip';
    chip.textContent = label;
    // Always rebuild the URL ourselves rather than trusting a model-supplied
    // href - it has produced search-redirect links rather than watch links.
    chip.href = watchUrl(videoId, label);
    chip.target = '_blank';
    chip.rel = 'noopener';
    return chip;
  }

  function appendInline(parent, text, videoId) {
    let lastIndex = 0;
    let match;
    INLINE_RE.lastIndex = 0;

    while ((match = INLINE_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      lastIndex = match.index + match[0].length;

      const [full, linkText, linkHref, bold, italic, code] = match;

      if (linkText !== undefined) {
        if (TIMESTAMP_RE.test(linkText.trim())) {
          parent.appendChild(makeChip(linkText.trim(), videoId));
        } else if (/^https:\/\//i.test(linkHref)) {
          const a = document.createElement('a');
          a.className = 'yts-link';
          a.textContent = linkText;
          a.href = linkHref;
          a.target = '_blank';
          a.rel = 'noopener';
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(linkText));
        }
      } else if (bold !== undefined) {
        parent.appendChild(h('strong', 'yts-bullet-label', bold));
      } else if (italic !== undefined) {
        parent.appendChild(h('em', null, italic));
      } else if (code !== undefined) {
        parent.appendChild(h('code', 'yts-code', code));
      } else {
        parent.appendChild(makeChip(full, videoId));
      }
    }

    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function renderMarkdown(md, videoId) {
    const body = h('div', 'yts-panel-body');
    const lines = String(md || '').split('\n');

    let paragraph = [];
    let list = null;
    let listIndent = 0;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const p = h('p', 'yts-overview');
      appendInline(p, paragraph.join(' '), videoId);
      body.appendChild(p);
      paragraph = [];
    };
    const flushList = () => {
      list = null;
      listIndent = 0;
    };

    lines.forEach((raw) => {
      const line = raw.replace(/\s+$/, '');

      if (!line.trim()) {
        flushParagraph();
        flushList();
        return;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const el2 = h('div', 'yts-section-heading');
        appendInline(el2, heading[2], videoId);
        body.appendChild(el2);
        return;
      }

      const bullet = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        const indent = bullet[1].length;
        if (!list || indent < listIndent - 1) {
          list = h('ul', 'yts-bullets');
          listIndent = indent;
          body.appendChild(list);
        }
        const li = h('li', 'yts-bullet');
        if (indent > listIndent + 1) li.classList.add('yts-bullet-nested');
        appendInline(li, bullet[2], videoId);
        list.appendChild(li);
        return;
      }

      flushList();
      paragraph.push(line.trim());
    });

    flushParagraph();
    return body;
  }

  ns.renderMarkdownTo = renderMarkdown;

  function summaryAsText(meta, markdown, videoId) {
    return [meta.title, watchUrl(videoId), '', String(markdown || '')].join('\n');
  }

  const THUMB_UP_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M7 10v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3Zm0 0 4.2-7.4a1 1 0 0 1 1.8.5V8h5.3a2 2 0 0 1 2 2.5l-1.8 7A2 2 0 0 1 16.6 19H7" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const THUMB_DOWN_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M7 14V4H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3Zm0 0 4.2 7.4a1 1 0 0 0 1.8-.5V16h5.3a2 2 0 0 0 2-2.5l-1.8-7A2 2 0 0 0 16.6 5H7" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  // Replaces the old manual "Re-summarise" button. A video is summarised once
  // and everyone reads that one summary, so the signal that a summary is bad
  // has to come from readers rather than from each reader paying to redo it.
  // The threshold that turns enough thumbs-down into a re-run is a server-side
  // decision - see YTS_VOTE in the service worker.
  function renderFeedback(meta, videoId) {
    const wrap = h('div', 'yts-feedback');
    let current = meta.yourVote || null;
    let counts = meta.stats ? { up: meta.stats.up, down: meta.stats.down } : null;

    const up = h('button', 'yts-vote', null);
    const down = h('button', 'yts-vote', null);
    up.type = 'button';
    down.type = 'button';
    up.title = 'This summary matched the video';
    down.title = 'This summary was wrong or unhelpful';
    up.setAttribute('aria-label', up.title);
    down.setAttribute('aria-label', down.title);

    const paint = () => {
      [
        [up, THUMB_UP_SVG, 'up'],
        [down, THUMB_DOWN_SVG, 'down'],
      ].forEach(([btn, svg, kind]) => {
        btn.innerHTML = svg;
        // Counts come from the service; with no service there is nothing
        // meaningful to count, so the thumbs stand alone.
        if (counts && counts[kind] > 0) btn.appendChild(h('span', 'yts-vote-count', counts[kind]));
        btn.classList.toggle('yts-voted', current === kind);
        btn.setAttribute('aria-pressed', String(current === kind));
      });
    };

    const cast = (vote) => async () => {
      // Clicking the active thumb clears the vote, matching every other
      // thumbs widget on this page.
      current = current === vote ? null : vote;
      paint();

      const res = await ns.recordVote(videoId, current);
      if (!res || !res.ok) return;

      current = res.vote || null;
      if (res.stats) counts = { up: res.stats.up, down: res.stats.down };
      paint();

      // This vote was the one that tipped the summary over the threshold. It
      // is now being rewritten for everyone, so say so rather than leaving a
      // summary on screen that the reader has just been told is retired.
      if (res.retired) {
        wrap.replaceChildren(
          h(
            'div',
            'yts-retired',
            'Enough readers flagged this — it gets rewritten on the next open.'
          )
        );
      } else if (res.exhausted) {
        // Already had its one rewrite and the rewrite was rejected too. Saying
        // nothing here would read as the vote having been ignored.
        wrap.replaceChildren(
          h('div', 'yts-retired', 'Noted — this one has already been rewritten once.')
        );
      }
    };

    up.addEventListener('click', cast('up'));
    down.addEventListener('click', cast('down'));
    paint();

    wrap.append(up, down);
    return wrap;
  }

  function renderCopyButton(meta, summary, videoId) {
    const copy = h('button', 'yts-action yts-copy', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(summaryAsText(meta, summary, videoId));
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      } catch (err) {
        console.warn('[yts] clipboard write failed', err);
      }
    });
    return copy;
  }

  function renderFooter(meta, summary, videoId) {
    const footer = h('div', 'yts-panel-footer');
    const actions = h('div', 'yts-footer-actions');

    // On the watch page all three of these are nonsense: you are already
    // watching it, "Later" would queue a second tab of the page you are on,
    // and there is no feed card to hide. Feedback and Copy still apply.
    if (anchorSurface && anchorSurface.kind === 'single') {
      const right = h('div', 'yts-footer-right');
      right.append(renderFeedback(meta, videoId), renderCopyButton(meta, summary, videoId));
      footer.append(actions, right);
      return footer;
    }

    const watch = h('button', 'yts-action', 'Watch');
    watch.type = 'button';
    watch.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'YTS_OPEN_TAB', url: watchUrl(videoId), active: true });
      ns.panel.close();
    });

    const later = h('button', 'yts-action', 'Later');
    later.type = 'button';
    later.title = 'Open in a background tab without leaving the feed';
    later.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'YTS_OPEN_TAB', url: watchUrl(videoId), active: false });
      ns.panel.close();
    });

    const skip = h('button', 'yts-action', 'Skip');
    skip.type = 'button';
    skip.title = 'Hide this video from the feed for this session';
    skip.addEventListener('click', () => {
      const card = anchorCard;
      ns.panel.close();
      ns.skipVideo(videoId, card);
    });

    actions.append(watch, later, skip);

    const right = h('div', 'yts-footer-right');
    right.append(renderFeedback(meta, videoId), renderCopyButton(meta, summary, videoId));

    footer.append(actions, right);
    return footer;
  }

  // ---------- public API ----------

  ns.panel = {
    openLoading(btn, card, videoId, surface) {
      anchorBtn = btn;
      anchorCard = card;
      anchorVideoId = videoId;
      anchorSurface = surface;
      ensureEl(card, surface);

      const loading = h('div', 'yts-panel-loading');
      loading.appendChild(h('div', 'yts-spinner'));
      loading.appendChild(h('div', null, 'Gemini is watching the whole video…'));
      const hint = h('div', 'yts-panel-hint', 'Roughly a few seconds per minute of video.');
      loading.appendChild(hint);
      setContent([loading]);

      // A visible clock makes a long wait read as progress rather than a hang.
      const startedAt = Date.now();
      clearInterval(tickHandle);
      tickHandle = setInterval(() => {
        if (!el || !el.contains(hint)) {
          clearInterval(tickHandle);
          return;
        }
        hint.textContent = `${((Date.now() - startedAt) / 1000).toFixed(0)}s elapsed`;
      }, 1000);
    },

    renderSummary(markdown, meta, videoId) {
      if (!el) return;
      clearInterval(tickHandle);
      setContent([
        renderHeader(meta, markdown, videoId),
        renderMarkdown(markdown, videoId),
        renderFooter(meta, markdown, videoId),
      ]);
    },

    // Streaming: render whatever has arrived so far. Markdown renders as a
    // prefix without any repair, which is one reason dropping the JSON schema
    // simplified this. The footer is withheld until the summary is complete,
    // so a partial view is never mistaken for the final one.
    renderPartial(markdown, meta, videoId) {
      if (!el || !markdown) return;
      const streaming = h('div', 'yts-streaming');
      streaming.appendChild(h('span', 'yts-streaming-dot'));
      streaming.appendChild(h('span', null, 'still writing…'));
      setContent([
        renderHeader(meta, markdown, videoId),
        renderMarkdown(markdown, videoId),
        streaming,
      ]);
    },

    renderError(message, opts) {
      if (!el) return;
      const box = h('div', 'yts-panel-error');
      box.appendChild(h('div', 'yts-error-title', 'Could not summarise this video'));
      box.appendChild(h('div', 'yts-error-msg', message));

      // A quota refusal is not an error state, so it gets the one piece of
      // information that actually helps: when it comes back.
      if (opts && opts.quota && opts.quota.resetsAt) {
        box.appendChild(
          h(
            'div',
            'yts-error-msg',
            `Your allowance resets ${new Date(opts.quota.resetsAt).toLocaleDateString()}.`
          )
        );
      }

      const row = h('div', 'yts-error-actions');
      if (opts && opts.needsSettings) {
        const open = h('button', 'yts-action', 'Open settings');
        open.type = 'button';
        open.addEventListener('click', () =>
          chrome.runtime.sendMessage({ type: 'YTS_OPEN_OPTIONS' })
        );
        row.appendChild(open);
      }
      const dismiss = h('button', 'yts-action', 'Close');
      dismiss.type = 'button';
      dismiss.addEventListener('click', () => ns.panel.close());
      row.appendChild(dismiss);

      box.appendChild(row);
      setContent([box]);
    },

    close() {
      if (!el) return;
      clearInterval(tickHandle);
      const node = el;
      node.classList.remove('yts-open');
      anchorBtn = null;
      anchorCard = null;
      anchorVideoId = null;
      if (escBound) {
        escBound = false;
        document.removeEventListener('keydown', onKeydown, true);
        window.removeEventListener('resize', positionPopup);
      }
      anchorSurface = null;
      // Let the collapse animation finish before removing from the grid.
      setTimeout(() => {
        if (node.parentElement && !node.classList.contains('yts-open')) node.remove();
      }, 300);
      el = null;
    },

    isOpenFor(videoId) {
      return !!el && anchorVideoId === videoId;
    },

    // Bug 2: the grid recycled the card this panel was anchored to, so the
    // panel is now describing a video that is no longer beneath it.
    closeIfAnchoredTo(btn) {
      if (anchorBtn && anchorBtn === btn) ns.panel.close();
    },

    // Called on every observer pass: YouTube re-renders the grid freely, and
    // an in-flow child of #contents can be relocated or orphaned by that.
    syncPlacement(surface) {
      if (!el || !anchorCard) return;
      // /watch runs two grids; only the surface that owns this panel may move it.
      if (anchorSurface && surface && anchorSurface.name !== surface.name) return;
      if (!anchorCard.isConnected) {
        ns.panel.close();
        return;
      }
      mount(anchorCard, anchorSurface || surface);
    },
  };
})(window.__ytSummarizer);
