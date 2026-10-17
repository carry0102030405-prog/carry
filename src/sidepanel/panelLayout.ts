/** Resizable side-panel layout (chat area vs. settings section vs. input box), persisted in storage. */

export const PANEL_LAYOUT_STORAGE_KEY = 'panelLayout';

export interface PanelLayout {
  /** Max height of the top section (AI order, connections, trace), px. */
  configHeight?: number;
  /** Height of the input textarea, px. */
  inputHeight?: number;
}

export const INPUT_MIN_PX = 52;
export const CONFIG_MIN_PX = 48;
/** The chat transcript always keeps at least this much room. */
export const CHAT_MIN_PX = 80;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Largest input box allowed for a panel of `viewportHeight` px (about 60% of it). */
export function inputMaxPx(viewportHeight: number): number {
  return Math.max(INPUT_MIN_PX, Math.round(viewportHeight * 0.6));
}

/** Largest top section allowed for a panel of `viewportHeight` px (about 75% of it). */
export function configMaxPx(viewportHeight: number): number {
  return Math.max(CONFIG_MIN_PX, Math.round(viewportHeight * 0.75));
}

export function clampInputHeight(value: number, viewportHeight: number): number {
  return Math.round(clamp(value, INPUT_MIN_PX, inputMaxPx(viewportHeight)));
}

export function clampConfigHeight(value: number, viewportHeight: number): number {
  return Math.round(clamp(value, CONFIG_MIN_PX, configMaxPx(viewportHeight)));
}

/**
 * Dragging the handle between the chat area and the input: moving it up (smaller clientY)
 * makes the input taller and the chat area shorter.
 */
export function inputHeightAfterDrag(startHeight: number, startY: number, currentY: number, viewportHeight: number): number {
  return clampInputHeight(startHeight + (startY - currentY), viewportHeight);
}

/**
 * Dragging the handle between the top section and the chat area: moving it down makes the
 * top section taller and the chat area shorter.
 */
export function configHeightAfterDrag(startHeight: number, startY: number, currentY: number, viewportHeight: number): number {
  return clampConfigHeight(startHeight + (currentY - startY), viewportHeight);
}

/** Read a stored layout, dropping anything malformed. */
export function normalizePanelLayout(value: unknown): PanelLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const layout: PanelLayout = {};
  const pick = (key: keyof PanelLayout) => {
    const candidate = raw[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) layout[key] = Math.round(candidate);
  };
  pick('configHeight');
  pick('inputHeight');
  return layout;
}
