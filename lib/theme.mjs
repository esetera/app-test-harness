import { readFileSync } from 'node:fs'

// Browser-host theme values for apps that consume the theme bridge.
const light = {
  mode: 'light',
  surfacePaletteId: null,
  css: `:root {
    color-scheme: light;
    --platform-mode: light;
    --platform-typography-font-family: system-ui, -apple-system, sans-serif;
    --platform-typography-font-family-content: Georgia, serif;
    --platform-typography-font-family-mono: ui-monospace, monospace;
    --platform-typography-font-size-base: 14px;
    --platform-typography-font-size-sm: 12px;
    --platform-typography-font-size-lg: 17px;
    --platform-typography-line-height-base: 1.5;
    --platform-spacing-xs: 4px;
    --platform-spacing-sm: 8px;
    --platform-spacing-md: 12px;
    --platform-spacing-lg: 16px;
    --platform-spacing-xl: 24px;
    --platform-radius-sm: 3px;
    --platform-radius-md: 5px;
    --platform-radius-lg: 7px;
    --platform-colors-bg: #f5f3ec;
    --platform-colors-app-viewport: #fbfaf5;
    --platform-colors-surface: #fbfaf5;
    --platform-colors-surface-hover: #eeeee5;
    --platform-colors-surface-active: #e7ece9;
    --platform-colors-elevated: #fffefa;
    --platform-colors-text: #26384a;
    --platform-colors-text-secondary: #546472;
    --platform-colors-text-disabled: #717c83;
    --platform-colors-text-inverse: #ffffff;
    --platform-colors-accent: #37576b;
    --platform-colors-accent-hover: #28485a;
    --platform-colors-accent-muted: #e4eaed;
    --platform-colors-border: #d7d9d1;
    --platform-colors-border-strong: #abb4b4;
    --platform-colors-divider: #e5e5dc;
    --platform-colors-focus: #93492e;
    --platform-colors-selection: #e0e8e7;
    --platform-colors-success: #35724f;
    --platform-colors-warning: #984f2f;
    --platform-colors-danger: #ab3a33;
    --platform-colors-chrome-titlebar: #fbfaf5;
    --platform-colors-chrome-tab-strip: #f0efe8;
  }`,
}

const embeddedChrome = `
  header > button:has([class$="wordmark__prefix"]),
  header > button[aria-label="Close this app and go to the desk"] {
    display: none !important;
  }
`

export function loadTheme(path) {
  const exported = path ? JSON.parse(readFileSync(path,'utf8')).light : null
  if (path && typeof exported?.css !== 'string') throw new Error('The theme export needs a light CSS theme.')
  return {...light,...exported,css:[light.css,exported?.css,embeddedChrome].filter(Boolean).join('\n')}
}
