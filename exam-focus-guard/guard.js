(() => {
  'use strict';

  const examPath = /^\/exam\/(?:examSingleMode|examMode)\/[^/]+(?:\/|$)/i;

  window.addEventListener('blur', (event) => {
    // Read the current route because the exam uses history-based SPA navigation.
    if (event.target !== window || !examPath.test(window.location.pathname)) return;

    // Element blur must reach answer-saving handlers and editor components.
    event.stopImmediatePropagation();
  }, true);
})();
