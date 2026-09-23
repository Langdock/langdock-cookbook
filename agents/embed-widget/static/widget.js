(() => {
  const script = document.currentScript;
  const src = script?.getAttribute("data-src") || script?.src || "";
  const origin = src ? new URL(src).origin : window.location.origin;
  const iframeSrc = `${origin}/`;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const icon = (paths) =>
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Open assistant");
  button.innerHTML = icon(
    '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
  );
  Object.assign(button.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    zIndex: "2147483646",
    display: "grid",
    placeItems: "center",
    width: "48px",
    height: "48px",
    padding: "0",
    border: "0",
    borderRadius: "16px",
    background: "#4469fc",
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 8px 24px rgba(68, 105, 252, 0.28)",
  });

  const panel = document.createElement("iframe");
  panel.title = "Assistant";
  panel.src = iframeSrc;
  Object.assign(panel.style, {
    position: "fixed",
    right: "20px",
    bottom: "80px",
    zIndex: "2147483646",
    width: "min(400px, calc(100vw - 32px))",
    height: "min(640px, calc(100vh - 112px))",
    border: dark ? "1px solid #37383d" : "1px solid #e8e7e4",
    borderRadius: "20px",
    boxShadow: dark
      ? "0 16px 48px rgba(0,0,0,.45)"
      : "0 16px 48px rgba(31, 32, 38, .16)",
    display: "none",
    background: dark ? "#1f2026" : "#fff",
    overflow: "hidden",
    opacity: "0",
    transform: "translateY(8px)",
    transition: reduceMotion
      ? "none"
      : "opacity 180ms ease-out, transform 180ms ease-out",
  });

  let open = false;
  const setOpen = (next) => {
    open = next;
    button.setAttribute("aria-label", open ? "Close assistant" : "Open assistant");
    button.innerHTML = open
      ? icon('<path d="M6 6l12 12M18 6L6 18"/>')
      : icon(
          '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
        );
    if (open) {
      panel.style.display = "block";
      requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0)";
      });
    } else {
      panel.style.opacity = "0";
      panel.style.transform = "translateY(8px)";
      const hide = () => {
        if (!open) panel.style.display = "none";
        panel.removeEventListener("transitionend", hide);
      };
      if (reduceMotion) hide();
      else panel.addEventListener("transitionend", hide);
    }
  };

  button.addEventListener("click", () => setOpen(!open));
  document.body.append(panel, button);
})();
