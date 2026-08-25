const bootStatus = document.querySelector<HTMLElement>("#boot-status")!;
const bootTitle = bootStatus.querySelector<HTMLElement>("[data-boot-title]")!;
const bootDetail = bootStatus.querySelector<HTMLElement>("[data-boot-detail]")!;
const bootRetry = bootStatus.querySelector<HTMLButtonElement>("[data-boot-retry]")!;

bootRetry.addEventListener("click", () => {
  window.location.reload();
});

export function hideBootStatus(): void {
  bootStatus.dataset["state"] = "ready";
  bootStatus.hidden = true;
}

export function showBootLoading(title: string, detail: string): void {
  bootStatus.dataset["state"] = "loading";
  bootStatus.hidden = false;
  bootTitle.textContent = title;
  bootDetail.textContent = detail;
}

export function showBootError(title: string, detail: string): void {
  bootStatus.dataset["state"] = "error";
  bootStatus.hidden = false;
  bootTitle.textContent = title;
  bootDetail.textContent = detail;
  bootRetry.focus();
}
