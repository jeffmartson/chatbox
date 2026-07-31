export type InterfaceTheme = 'light' | 'dark'

export type InterfaceThemeColors = {
  backgroundPrimary: string
  backgroundSecondary: string
  backgroundTertiary: string
  brand: string
}

export type InterfaceColors = Record<InterfaceTheme, InterfaceThemeColors>

export type InterfaceColorPreset = {
  id: string
  label: string
  colors: InterfaceColors
}

export const INTERFACE_COLOR_PRESETS = [
  {
    id: 'claude-classic',
    label: 'Claude Classic',
    colors: {
      light: {
        backgroundPrimary: '#f7f6f2',
        backgroundSecondary: '#eeede7',
        backgroundTertiary: '#e2e1db',
        brand: '#d97757',
      },
      dark: {
        backgroundPrimary: '#262624',
        backgroundSecondary: '#333330',
        backgroundTertiary: '#41413d',
        brand: '#e89173',
      },
    },
  },
  {
    id: 'mist-blue',
    label: 'Mist Blue',
    colors: {
      light: {
        backgroundPrimary: '#f6f8fa',
        backgroundSecondary: '#eaf0f5',
        backgroundTertiary: '#d9e3ec',
        brand: '#5784aa',
      },
      dark: {
        backgroundPrimary: '#1c252e',
        backgroundSecondary: '#253240',
        backgroundTertiary: '#324252',
        brand: '#7fb3dd',
      },
    },
  },
] satisfies ReadonlyArray<InterfaceColorPreset>

export const DEFAULT_INTERFACE_COLORS: InterfaceColors = {
  light: {
    backgroundPrimary: '#ffffff',
    backgroundSecondary: '#f3f3f3',
    backgroundTertiary: '#dee2e6',
    brand: '#228be6',
  },
  dark: {
    backgroundPrimary: '#242424',
    backgroundSecondary: '#3b3b3b',
    backgroundTertiary: '#424242',
    brand: '#4dabf7',
  },
}

export function getDefaultInterfaceColors(): InterfaceColors {
  return {
    light: { ...DEFAULT_INTERFACE_COLORS.light },
    dark: { ...DEFAULT_INTERFACE_COLORS.dark },
  }
}

export function withColorOpacity(color: string, opacity: number): string {
  const alpha = Math.round(Math.min(Math.max(opacity, 0), 1) * 255)
  return `${color}${alpha.toString(16).padStart(2, '0')}`
}
