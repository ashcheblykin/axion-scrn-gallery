/** The Axion mark (assets/anonymize/logo.svg) — gallery header, favicon and the fallback replacement logo. */
export const AXION_MARK_PATH =
  'M116.884 91.8565L79.4818 36.8428H46.7156L64.679 63.2643H52.7455C37.6723 63.2643 31.3817 67.7558 26.0076 79.1166L14.7363 103.159H43.5711L52.0897 86.2487H80.306L91.8023 103.159H125.263L116.884 91.8565Z';

/** Viewbox cropped to the mark (the asset itself is 140×140 with clear space). */
export const AXION_MARK_VIEWBOX = '8 30 124 80';

export function axionMarkSvg(fill = 'currentColor', attrs = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${AXION_MARK_VIEWBOX}" ${attrs}><path d="${AXION_MARK_PATH}" fill="${fill}"/></svg>`;
}

/** Favicon that follows the browser theme. */
export function axionFavicon(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${AXION_MARK_VIEWBOX}"><style>path{fill:#0f172a}@media (prefers-color-scheme:dark){path{fill:#fff}}</style>` +
    `<path d="${AXION_MARK_PATH}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
