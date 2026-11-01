"use strict";
(function () {
  const listeners = new Set();
  let active = false;
  let started = false;
  let running = false;
  let lastPoll = 0;
  let timer = null;

  async function checkVisibility() {
    try {
      active = await window.__TAURI__.core.invoke("dashboard_active");
    } catch (error) {
      active = false;
      console.error("Cannot check window visibility", error);
    }
    return active;
  }

  async function runOnce(force) {
    if (running) return;
    running = true;
    try {
      const visible = await checkVisibility();
      const interval = visible ? 5000 : 30000;
      if (!force && Date.now() - lastPoll < interval) return;
      lastPoll = Date.now();
      for (const listener of listeners) {
        try {
          await listener({ visible: visible });
        } catch (error) {
          console.error("Dashboard refresh listener failed", error);
        }
      }
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async function () {
      await runOnce(false);
      schedule();
    }, 2000);
  }

  window.dashboardRefresh = {
    get active() { return active; },
    subscribe(listener) {
      listeners.add(listener);
      if (!started) {
        started = true;
        runOnce(true).finally(schedule);
      }
    },
    async refreshNow() {
      lastPoll = 0;
      await runOnce(true);
    },
    checkVisibility: checkVisibility
  };

  window.addEventListener("focus", function () {
    lastPoll = 0;
    runOnce(false);
  });
  document.addEventListener("visibilitychange", function () {
    lastPoll = 0;
    runOnce(false);
  });
})();
