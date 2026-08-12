// Per-surface config: adding a new surface is one new entry here, nothing
// else in the codebase should need to know which surface it's running on.
window.__ytSummarizer = window.__ytSummarizer || {};

(function (ns) {
  function extractVideoId(card) {
    const anchors = card.querySelectorAll('a[href*="/watch?"]');
    for (const a of anchors) {
      try {
        const url = new URL(a.getAttribute('href'), location.origin);
        const id = url.searchParams.get('v');
        if (id) return id;
      } catch (e) {
        // malformed href, try next anchor
      }
    }
    return null;
  }

  // Tried in order; first match becomes the overlay mount. YouTube has been
  // migrating cards from the Polymer `ytd-thumbnail` renderer to the newer
  // lockup/view-model markup, and both ship depending on rollout, so we
  // cannot depend on any single one of these.
  const THUMBNAIL_SELECTORS = [
    'ytd-thumbnail',
    'yt-thumbnail-view-model',
    '.ytThumbnailViewModelHost',
    'a#thumbnail',
    'a.yt-lockup-view-model__content-image',
  ];

  // Where a button goes when it cannot live on the thumbnail. Tried in order,
  // newest markup first, ending with the older Polymer ids as a backstop.
  // Used by surfaces whose cards are small enough that YouTube starts an inline
  // preview the moment the mouse approaches - that preview replaces the
  // thumbnail's contents, so an overlay button vanishes exactly when someone
  // reaches for it, at any position and any z-index.
  const META_SELECTORS = [
    '.yt-lockup-metadata-view-model__text-container',
    '.yt-lockup-metadata-view-model',
    'ytd-video-meta-block',
    '#meta',
    '#details',
  ];

  ns.surfaces = {
    home: {
      name: 'home',
      kind: 'grid',
      matches: (pathname) => pathname === '/',
      gridSelector: 'ytd-rich-grid-renderer #contents.ytd-rich-grid-renderer',
      cardSelector: 'ytd-rich-item-renderer',
      thumbnailSelectors: THUMBNAIL_SELECTORS,
      getVideoId: extractVideoId,
    },
    subscriptions: {
      name: 'subscriptions',
      kind: 'grid',
      matches: (pathname) => pathname === '/feed/subscriptions',
      // Subscriptions has shipped as both a rich-grid layout and a plain
      // grid layout at various points; match both until confirmed live.
      gridSelector:
        'ytd-rich-grid-renderer #contents.ytd-rich-grid-renderer, ytd-grid-renderer #contents.ytd-grid-renderer',
      cardSelector: 'ytd-rich-item-renderer, ytd-grid-video-renderer',
      thumbnailSelectors: THUMBNAIL_SELECTORS,
      getVideoId: extractVideoId,
    },
    // Search results. A vertical list rather than a grid, which needs no
    // special handling: the row logic in panel.js groups cards by vertical
    // offset, and in a single column every card is its own row, so the panel
    // lands directly under the result that was clicked.
    //
    // Results also contain channels, playlists, Shorts shelves and ads.
    // None of those are filtered out here on purpose - they carry no
    // /watch?v= link, so getVideoId returns null and syncCardButton skips
    // them. Matching loosely and letting the id decide is more robust than
    // trying to enumerate every non-video renderer YouTube ships.
    search: {
      name: 'search',
      kind: 'grid',
      matches: (pathname) => pathname === '/results',
      gridSelector:
        'ytd-section-list-renderer #contents.ytd-section-list-renderer, ytd-search #contents, #primary ytd-section-list-renderer',
      cardSelector: 'ytd-video-renderer, yt-lockup-view-model',
      thumbnailSelectors: THUMBNAIL_SELECTORS,
      // Same problem as channel home: hovering a result starts the inline
      // preview, which replaces the thumbnail and takes an overlay button with
      // it. The panel stays inline here though - a vertical list of results is
      // not a horizontal scroller, so nothing clips it.
      buttonPlacement: 'meta',
      mountSelectors: META_SELECTORS,
      getVideoId: extractVideoId,
    },
    // A channel's Videos tab (and Live, which is the same markup). Matched by
    // the path ending rather than by handle, because a channel can be reached
    // as /@handle, /channel/UC…, /c/name or /user/name and all four end the
    // same way. The grid itself is the same rich-grid the home feed uses.
    channel: {
      name: 'channel',
      kind: 'grid',
      matches: (pathname) => /\/(videos|streams)\/?$/.test(pathname),
      gridSelector: 'ytd-rich-grid-renderer #contents.ytd-rich-grid-renderer',
      cardSelector: 'ytd-rich-item-renderer',
      thumbnailSelectors: THUMBNAIL_SELECTORS,
      getVideoId: extractVideoId,
    },
    // Playlists, which is also Watch Later: /playlist?list=WL is the same page
    // type as any other list, so both are covered by this one entry. The
    // decision being made here - "which of these forty is worth my time" - is
    // the same one the feed surfaces serve, on a longer list.
    playlist: {
      name: 'playlist',
      kind: 'grid',
      // Liked videos is /playlist?list=LL - the same page type, so it can only
      // be excluded by query string. Watch Later (?list=WL) stays.
      matches: (pathname, search = '') =>
        pathname === '/playlist' && !/[?&]list=LL(&|$)/.test(search),
      gridSelector:
        'ytd-playlist-video-list-renderer #contents, ytd-section-list-renderer #contents, ytd-browse #contents',
      // Three renderers because YouTube is mid-migration and ships whichever
      // it feels like: the classic playlist row, the plain video row, and the
      // newer lockup. Matching all three is safe - anything without a
      // /watch?v= link is skipped by getVideoId, including the playlist
      // header's own "Play all" link, which is not one of these renderers.
      cardSelector: 'ytd-playlist-video-renderer, ytd-video-renderer, yt-lockup-view-model',
      thumbnailSelectors: THUMBNAIL_SELECTORS,
      getVideoId: extractVideoId,
    },
    // A channel's home tab, which is shelves of horizontal carousels rather
    // than a grid - "My most important videos", "Conversations with…". Matches
    // the bare channel URL and its /featured form, in all four ways a channel
    // can be addressed, but NOT /videos, which the channel surface above owns.
    //
    // Cards scroll sideways here, which needs nothing special: processGrid
    // sweeps document.querySelectorAll on every pass, so a card revealed by
    // scrolling a carousel right gets its button on the next tick exactly like
    // one revealed by scrolling the page down.
    //
    // The button does NOT overlay the thumbnail on this surface. These cards
    // are small enough that hovering one starts YouTube's inline preview
    // immediately, and that preview does not merely cover the thumbnail - it
    // replaces its contents, so an overlay button vanishes the instant the
    // mouse arrives, wherever it was placed. Mounting into the title and
    // view-count block puts it outside anything the preview touches.
    channelHome: {
      name: 'channelHome',
      kind: 'grid',
      // A popup, not an inline accordion. These shelves are horizontal
      // scrollers: anything inserted into one becomes another item in a row
      // laid out sideways and gets clipped at the shelf's edge, which is why
      // the summary came out cut off on both sides. A popup is positioned in
      // page coordinates against the card, so the shelf cannot crop it.
      panelMode: 'popup',
      matches: (pathname) =>
        /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/featured)?\/?$/.test(pathname),
      gridSelector:
        'ytd-two-column-browse-results-renderer #contents, ytd-browse #contents, ytd-section-list-renderer #contents',
      cardSelector:
        'ytd-grid-video-renderer, ytd-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer',
      thumbnailSelectors: THUMBNAIL_SELECTORS,
      buttonPlacement: 'meta',
      mountSelectors: META_SELECTORS,
      getVideoId: extractVideoId,
    },
    // The watch page has no card grid: one video, and the summary belongs
    // directly under the player, above the description and comments. Tried in
    // order; whichever exists becomes the host for the button bar + panel.
    watch: {
      name: 'watch',
      kind: 'single',
      matches: (pathname) => pathname === '/watch',
      hostSelectors: [
        'ytd-watch-metadata',
        '#above-the-fold',
        '#below.ytd-watch-flexy',
        '#below',
      ],
      getVideoId: () => {
        try {
          return new URL(location.href).searchParams.get('v');
        } catch (e) {
          return null;
        }
      },
      // The player itself is the most reliable duration source on this page.
      getDurationSeconds: () => {
        // ns.mainPlayer, not the first <video> on the page: a watch page also
        // holds a hover-preview player for whatever the mouse last touched in
        // the sidebar, and reading its duration would report the wrong length.
        const video = ns.mainPlayer ? ns.mainPlayer() : document.querySelector('video');
        if (video && isFinite(video.duration) && video.duration > 0) {
          return Math.round(video.duration);
        }
        const label = document.querySelector('.ytp-time-duration');
        return label ? ns.timestampToSeconds(label.textContent) : 0;
      },
      readMeta: () => {
        const titleEl = document.querySelector(
          'h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata, #title h1'
        );
        const channelEl = document.querySelector('#owner #channel-name a, ytd-channel-name a');
        return {
          title: titleEl ? titleEl.textContent.trim() : document.title.replace(/ - YouTube$/, ''),
          channel: channelEl ? channelEl.textContent.trim() : '',
          // No thumbnail: the actual video is directly above the panel.
          thumb: null,
          duration: '',
        };
      },
    },
    // The related rail on the watch page. Same card logic as the feed, but the
    // column is far too narrow for an inline accordion, so the panel opens as
    // a wider popup anchored to the card. It is absolutely positioned in page
    // coordinates, so it scrolls with the page instead of hanging over it.
    related: {
      name: 'related',
      kind: 'grid',
      panelMode: 'popup',
      matches: (pathname) => pathname === '/watch',
      gridSelector: '#related #contents, #secondary #contents, #related',
      cardSelector: 'ytd-compact-video-renderer, yt-lockup-view-model',
      thumbnailSelectors: THUMBNAIL_SELECTORS,
      getVideoId: extractVideoId,
    },
  };

  // More than one surface can be live at once - /watch hosts both the player
  // (single) and the related-videos rail (grid) - so this returns all matches.
  ns.getActiveSurfaces = function () {
    const path = location.pathname;
    // The search string is passed as well because one surface is defined by it:
    // /playlist?list=LL is Liked videos, which is deliberately not covered.
    const search = typeof location !== 'undefined' ? location.search || '' : '';
    return Object.values(ns.surfaces).filter((s) => s.matches(path, search));
  };

  ns.getCurrentSurface = function () {
    return ns.getActiveSurfaces()[0] || null;
  };

  ns.getSurfaceByName = function (name) {
    return ns.surfaces[name] || null;
  };
})(window.__ytSummarizer);
