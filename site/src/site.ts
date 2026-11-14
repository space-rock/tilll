import "./site.css";

// The only script on the landing page: the copy buttons. Without it the page works the same, minus those buttons.
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const target = document.getElementById(button.dataset.copy ?? "");
  if (!target || !navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(target.textContent ?? "").then(() => {
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1500);
    });
  });
}
