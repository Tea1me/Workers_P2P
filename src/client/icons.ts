const paths: Record<string, string> = {
  layers:
    '<path d="m3 7 9-5 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>',
  github:
    '<path d="M9 19c-4 1-4-2-5-2m10 5v-4c0-1 .1-1.6-.5-2 3.3-.4 6.5-1.6 6.5-6a4.6 4.6 0 0 0-1.3-3.2c.1-.4.6-2-0.2-3.8 0 0-1.2-.4-4 1.5a13 13 0 0 0-7 0C4.2 2.5 3 3 3 3c-.8 1.8-.3 3.4-.2 3.8A4.6 4.6 0 0 0 1.5 10c0 4.4 3.2 5.6 6.5 6-.5.4-.6 1.2-.5 2v4" transform="translate(1 0) scale(.95)"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  "shield-check":
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  laptop:
    '<rect x="5" y="4" width="14" height="12" rx="2"/><path d="m5 16-3 4h20l-3-4M10 20h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  "arrow-right": '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  "arrow-up": '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  link: '<path d="m10 13 4-4m-6 6-2 2a3.5 3.5 0 0 0 5 5l4-4a3.5 3.5 0 0 0 0-5M9 11a3.5 3.5 0 0 1 0-5l4-4a3.5 3.5 0 0 1 5 5l-2 2" transform="translate(2 1) scale(.9)"/>',
  radar:
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 7-7"/><circle cx="12" cy="12" r="1"/>',
  wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M12 20h.01"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-6-6L3 21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  files: '<path d="M8 6h8l4 4v11H8V6ZM4 17V2h10M16 6v4h4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  zap: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  inbox: '<path d="m4 4-2 10v6h20v-6L20 4H4Z"/><path d="M2 14h6l2 3h4l2-3h6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
export function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.file}</svg>`;
}
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon!);
  });
}
