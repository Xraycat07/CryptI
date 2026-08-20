// Small badge on the header's "Luno" link showing how many bot proposals
// are pending, so a fresh signal is visible from any page on the site
// without opening the Luno tab. Silent on any failure (not logged into
// the Luno session, feature not configured, etc.) — it's a convenience,
// not core functionality.
(function () {
  "use strict";

  function ensureBadgeStyle() {
    if (document.getElementById("lunoBadgeStyle")) return;
    const style = document.createElement("style");
    style.id = "lunoBadgeStyle";
    style.textContent = `
      .luno-proposal-badge {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 16px; height: 16px; padding: 0 4px; margin-left: 4px;
        border-radius: 999px; background: #ef5350; color: white;
        font-size: 10px; font-weight: 700; line-height: 1;
      }
    `;
    document.head.appendChild(style);
  }

  async function checkProposals() {
    const link = document.querySelector(".luno-link");
    if (!link) return;
    try {
      const res = await fetch("/api/luno/bot/proposals");
      if (!res.ok) return;
      const body = await res.json();
      const pending = (body.proposals || []).filter((p) => p.status === "pending");
      let badge = document.getElementById("lunoProposalBadge");
      if (pending.length) {
        ensureBadgeStyle();
        if (!badge) {
          badge = document.createElement("span");
          badge.id = "lunoProposalBadge";
          badge.className = "luno-proposal-badge";
          link.appendChild(badge);
        }
        badge.textContent = String(pending.length);
        badge.title = `${pending.length} pending bot proposal${pending.length === 1 ? "" : "s"}`;
      } else if (badge) {
        badge.remove();
      }
    } catch {
      // silent
    }
  }

  document.addEventListener("DOMContentLoaded", checkProposals);
})();
