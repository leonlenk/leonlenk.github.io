import "../styles/video-loading.css";

let dispose = () => {};
function mount(): void {
  dispose();
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  document
    .querySelectorAll<HTMLVideoElement>(".prose video")
    .forEach((video) => {
      const host = document.createElement("div");
      host.className = "video-loading-host";
      video.before(host);
      host.append(video);
      const feedback = document.createElement("div");
      feedback.className = "video-loading";
      feedback.hidden = true;
      const stroke = document.createElement("span");
      stroke.className = "video-loading-stroke";
      stroke.setAttribute("aria-hidden", "true");
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      const link = document.createElement("a");
      link.textContent = "Open video directly →";
      link.href =
        video.currentSrc || video.querySelector("source")?.src || video.src;
      link.hidden = true;
      feedback.append(stroke, status, link);
      host.append(feedback);
      let delay = 0;
      let timeout = 0;
      function clear(): void {
        clearTimeout(delay);
        clearTimeout(timeout);
        delay = timeout = 0;
        feedback.hidden = true;
        status.textContent = "";
        link.hidden = true;
        delete feedback.dataset.stalled;
      }
      function stalled(message: string): void {
        clear();
        feedback.hidden = false;
        feedback.dataset.stalled = "";
        status.textContent = message;
        link.hidden = false;
      }
      function waiting(): void {
        if (
          video.paused ||
          video.ended ||
          delay ||
          timeout ||
          feedback.hasAttribute("data-stalled")
        )
          return;
        delay = window.setTimeout(() => {
          feedback.hidden = false;
          status.textContent = "Loading video…";
        }, 300);
        timeout = window.setTimeout(() => {
          stalled("Still buffering. Try playing again.");
        }, 12000);
      }
      const options = { signal: controller.signal };
      for (const name of ["waiting", "stalled", "seeking"])
        video.addEventListener(name, waiting, options);
      video.addEventListener(
        "play",
        () => {
          clear();
          if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) waiting();
        },
        options,
      );
      for (const name of ["playing", "canplay", "pause", "ended", "emptied"])
        video.addEventListener(name, clear, options);
      video.addEventListener(
        "error",
        () => stalled("The video couldn’t load."),
        options,
      );
      // With <source> children a failed request can report on the source
      // rather than the media element itself.
      video.querySelectorAll("source").forEach((source) => {
        source.addEventListener(
          "error",
          () => stalled("The video couldn’t load."),
          options,
        );
      });
      cleanups.push(() => {
        clear();
        host.before(video);
        host.remove();
      });
    });
  dispose = () => {
    controller.abort();
    cleanups.forEach((cleanup) => cleanup());
  };
}
document.addEventListener("astro:page-load", mount);
document.addEventListener("astro:before-swap", () => dispose());
mount();
