import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  mixColors,
  mixWithMinContrast,
  parseCssColor,
  pickReadableThemeColor,
  readableForeground,
} from './theme-contrast'

describe('parseCssColor', () => {
  it('lee hex cortos, largos, con alfa y rgb()', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseCssColor('#FF79C680')).toEqual({ r: 255, g: 121, b: 198, a: 128 / 255 })
    expect(parseCssColor('rgb(40, 42, 54)')).toEqual({ r: 40, g: 42, b: 54, a: 1 })
    expect(parseCssColor('rgba(121, 121, 121, 0.4)')).toEqual({ r: 121, g: 121, b: 121, a: 0.4 })
    expect(parseCssColor('tomato')).toBeNull()
  })
})

describe('contrastRatio', () => {
  it('coincide con los valores WCAG de referencia', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
  })

  it('compone el alfa sobre el fondo', () => {
    expect(contrastRatio('#ffffff00', '#282a36')).toBeCloseTo(1, 5)
  })
})

describe('pickReadableThemeColor', () => {
  const dracula = {
    'button.background': '#44475A',
    'textLink.foreground': '#8BE9FD',
    descriptionForeground: '#6272A4',
  }

  it('descarta candidatos ilegibles sobre el fondo (acento gris de Dracula)', () => {
    expect(pickReadableThemeColor(dracula, ['button.background', 'textLink.foreground'], '#282A36', 3)).toBe('#8BE9FD')
  })

  it('devuelve null si ningún candidato llega al contraste pedido', () => {
    expect(pickReadableThemeColor(dracula, ['descriptionForeground'], '#282A36', 4.5)).toBeNull()
  })
})

describe('mixColors y readableForeground', () => {
  it('mezcla en un hex opaco con contraste intermedio', () => {
    const muted = mixColors('#F8F8F2', '#282A36', 0.7)
    expect(muted).toMatch(/^#[0-9a-f]{6}$/)
    expect(contrastRatio(muted, '#282A36')).toBeGreaterThan(4.5)
  })

  it('sube el peso de la mezcla hasta alcanzar el contraste (Tokyo Night)', () => {
    const muted = mixWithMinContrast('#a9b1d6', '#1a1b26', 0.7, 4.5)
    expect(contrastRatio(muted, '#1a1b26')).toBeGreaterThanOrEqual(4.5)
  })

  it('elige blanco o negro según el fondo', () => {
    expect(readableForeground('#8BE9FD')).toBe('#000000')
    expect(readableForeground('#0e639c')).toBe('#ffffff')
  })
})
