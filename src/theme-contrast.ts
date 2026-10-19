// Utilidades de contraste para derivar los colores de la UI a partir del tema.
// Los temas de VS Code no garantizan que, p. ej., `descriptionForeground` o
// `button.background` sean legibles sobre `editor.background` (en Dracula el
// "acento" es el gris #44475A y el texto secundario el color de los comentarios),
// así que solo aceptamos un color del tema si cumple el contraste pedido.

type Rgba = { r: number; g: number; b: number; a: number }

export function parseCssColor(value: string | undefined): Rgba | null {
  if (!value) return null
  const color = value.trim()

  const hex = color.match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex
    const channel = (index: number) => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16)
    return { r: channel(0), g: channel(1), b: channel(2), a: full.length === 8 ? channel(3) / 255 : 1 }
  }

  const rgb = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i)
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number(rgb[4])
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha }
  }

  return null
}

function blend(foreground: Rgba, background: Rgba): Rgba {
  const a = foreground.a
  return {
    r: foreground.r * a + background.r * (1 - a),
    g: foreground.g * a + background.g * (1 - a),
    b: foreground.b * a + background.b * (1 - a),
    a: 1,
  }
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const linear = (channel: number) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** Contraste WCAG de `foreground` (con su alfa compuesto) sobre `background`. */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseCssColor(background)
  const fg = parseCssColor(foreground)
  if (!bg || !fg) return 1
  const lighter = Math.max(relativeLuminance(blend(fg, bg)), relativeLuminance(bg))
  const darker = Math.min(relativeLuminance(blend(fg, bg)), relativeLuminance(bg))
  return (lighter + 0.05) / (darker + 0.05)
}

/** Primer color del tema (por orden de preferencia) que alcanza `minContrast`. */
export function pickReadableThemeColor(
  colors: Record<string, string>,
  candidates: string[],
  background: string,
  minContrast: number,
): string | null {
  for (const candidate of candidates) {
    const color = colors[candidate]
    if (color && contrastRatio(color, background) >= minContrast) return color
  }
  return null
}

/** Mezcla `foreground` y `background` (peso 0–1 de `foreground`) en un hex opaco. */
export function mixColors(foreground: string, background: string, weight: number): string {
  const fg = parseCssColor(foreground)
  const bg = parseCssColor(background)
  if (!fg || !bg) return foreground
  const mixed = blend({ ...fg, a: weight }, bg)
  const toHex = (channel: number) => Math.round(channel).toString(16).padStart(2, '0')
  return `#${toHex(mixed.r)}${toHex(mixed.g)}${toHex(mixed.b)}`
}

/**
 * Mezcla `foreground` hacia `background` lo máximo posible (desde `weight`)
 * sin bajar de `minContrast`; si ni el color puro llega, devuelve el puro.
 */
export function mixWithMinContrast(
  foreground: string,
  background: string,
  weight: number,
  minContrast: number,
): string {
  for (let current = weight; current < 1; current += 0.05) {
    const mixed = mixColors(foreground, background, current)
    if (contrastRatio(mixed, background) >= minContrast) return mixed
  }
  return mixColors(foreground, background, 1)
}

/** Blanco o negro, el que mejor se lea sobre `background`. */
export function readableForeground(background: string): string {
  return contrastRatio('#ffffff', background) >= contrastRatio('#000000', background) ? '#ffffff' : '#000000'
}
