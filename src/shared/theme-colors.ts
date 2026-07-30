export type InterfaceTheme = 'light' | 'dark'

export type InterfaceThemeColors = {
  backgroundPrimary: string
  backgroundSecondary: string
  backgroundTertiary: string
}

export type InterfaceColors = Record<InterfaceTheme, InterfaceThemeColors>

export const DEFAULT_INTERFACE_COLORS: InterfaceColors = {
  light: {
    backgroundPrimary: '#ffffff',
    backgroundSecondary: '#f3f3f3',
    backgroundTertiary: '#dee2e6',
  },
  dark: {
    backgroundPrimary: '#242424',
    backgroundSecondary: '#3b3b3b',
    backgroundTertiary: '#424242',
  },
}

export function getDefaultInterfaceColors(): InterfaceColors {
  return {
    light: { ...DEFAULT_INTERFACE_COLORS.light },
    dark: { ...DEFAULT_INTERFACE_COLORS.dark },
  }
}
