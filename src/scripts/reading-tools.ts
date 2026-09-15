let teardown: (() => void) | undefined;

function setupReadingTools() {
  teardown?.();
  if (!document.querySelector("[data-reading-tools]")) return;
  const controller = new AbortController();
  const { signal } = controller;
  const proseBlocks = Array.from(
    document.querySelectorAll<HTMLElement>(".prose"),
  );
  function layoutNotes() {
    for (const prose of proseBlocks) {
      const section = prose.querySelector<HTMLElement>("[data-footnotes]");
      if (!section) continue;
      const notes = Array.from(
        section.querySelectorAll<HTMLElement>(":scope > ol > li"),
      );
      prose.classList.remove("has-sidenotes");
      prose.style.removeProperty("min-height");
      notes.forEach((note) => note.style.removeProperty("top"));
      const rect = prose.getBoundingClientRect();
      // Measure actual room, including zoom and the current reading width.
      if (innerWidth - rect.right < 288) continue;
      prose.classList.add("has-sidenotes");
      let bottom = 0;
      for (const note of notes) {
        const reference = Array.from(
          prose.querySelectorAll<HTMLAnchorElement>("[data-footnote-ref]"),
        ).find((ref) => decodeURIComponent(ref.hash.slice(1)) === note.id);
        const top = Math.max(
          bottom,
          reference ? reference.getBoundingClientRect().top - rect.top : 0,
        );
        note.style.top = `${top}px`;
        bottom = top + note.getBoundingClientRect().height + 20;
      }
      prose.style.minHeight = `${bottom}px`;
    }
  }
  window.addEventListener("resize", layoutNotes, { signal });
  document.addEventListener("load", layoutNotes, { signal, capture: true });
  void document.fonts.ready.then(() => {
    if (!signal.aborted) layoutNotes();
  });
  layoutNotes();
  teardown = () => {
    controller.abort();
    teardown = undefined;
  };
}

document.addEventListener("astro:page-load", setupReadingTools);
document.addEventListener("astro:before-swap", () => teardown?.());
