export type InterfaceTheme = 'light' | 'dark'

export type InterfaceThemeColors = {
  backgroundPrimary: string
  backgroundSecondary: string
  backgroundTertiary: string
}

export type InterfaceColors = Record<InterfaceTheme, InterfaceThemeColors>

export const INTERFACE_COLOR_PRESETS = [
  {
    id: 'claude-classic',
    label: 'Claude Classic',
    colors: {
      light: {
        backgroundPrimary: '#f7f6f2',
        backgroundSecondary: '#eeede7',
        backgroundTertiary: '#e2e1db',
      },
      dark: {
        backgroundPrimary: '#262624',
        backgroundSecondary: '#333330',
        backgroundTertiary: '#41413d',
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
      },
      dark: {
        backgroundPrimary: '#1c252e',
        backgroundSecondary: '#253240',
        backgroundTertiary: '#324252',
      },
    },
  },
] satisfies ReadonlyArray<{ id: string; label: string; colors: InterfaceColors }>

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
