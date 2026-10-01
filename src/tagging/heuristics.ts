/**
 * Deterministic UI-element detection (no LLM): [taxonomy element, CSS selector].
 * Runs in the page at capture time; Claude tagging (scrn tag) refines it later.
 */
export const ELEMENT_RULES: [string, string][] = [
  ['Table', 'table, [role=table], [role=grid], .ag-root, .ant-table, .MuiDataGrid-root'],
  ['Chart', 'canvas, svg.recharts-surface, .echarts, .apexcharts-canvas, .highcharts-container, [class*="chart" i] svg'],
  ['Map', '.mapboxgl-map, .maplibregl-map, .leaflet-container, .ol-viewport, .gm-style, [class*="map-container" i]'],
  ['Sidebar', 'aside, [class*="sidebar" i], nav[class*="side" i]'],
  ['Top bar', 'header, [role=banner]'],
  ['Tabs', '[role=tablist]'],
  ['Modal', '[role=dialog], [aria-modal=true]'],
  ['Drawer', '[class*="drawer" i]'],
  ['Form', 'form'],
  ['Text field', 'input[type=text], input:not([type]), textarea'],
  ['Search', 'input[type=search], [placeholder*="search" i], [placeholder*="поиск" i]'],
  ['Dropdown', 'select, [role=combobox], [role=listbox]'],
  ['Date picker', '[class*="date-picker" i], [class*="datepicker" i], input[type=date]'],
  ['Filter', '[class*="filter" i]'],
  ['Button', 'button, [role=button]'],
  ['Chat', '[class*="chat" i], [class*="message-list" i], [role=log]'],
  ['Avatar', '[class*="avatar" i]'],
  ['Badge', '[class*="badge" i], [class*="chip" i], [class*="tag" i]'],
  ['Pagination', '[class*="pagination" i], [aria-label*="pagination" i]'],
  ['Toast', '[role=status], [role=alert], [class*="toast" i]'],
  ['Breadcrumb', '[aria-label*="breadcrumb" i], [class*="breadcrumb" i]'],
  ['Progress bar', 'progress, [role=progressbar]'],
  ['Toggle', '[role=switch]'],
  ['Checkbox', 'input[type=checkbox], [role=checkbox]'],
  ['Timeline', '[class*="timeline" i]'],
  ['Video', 'video'],
];

/** Screen-pattern guesses from detected elements — a starting point until YAML or Claude say otherwise. */
export function guessPatterns(elements: string[], text: string): string[] {
  const has = (e: string) => elements.includes(e);
  const out: string[] = [];
  if (has('Map')) out.push('Map view');
  if (has('Chat')) out.push('Chat');
  if (has('Chart') && has('Card')) out.push('Dashboard');
  if (has('Table') && !has('Chart')) out.push('List & Table');
  if (has('Modal')) out.push('Modal');
  if (/no data|нет данных|لا توجد بيانات|nothing (here|found)/i.test(text)) out.push('Empty state');
  return out;
}
