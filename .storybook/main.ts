import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/react-vite'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const config: StorybookConfig = {
  stories: ['../src/renderer/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-docs'],
  framework: '@storybook/react-vite',
  viteFinal: async (config, { configType }) => {
    const nodeEnv = configType === 'PRODUCTION' ? 'production' : 'development'
    config.envDir = __dirname
    config.resolve = config.resolve || {}
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': resolve(__dirname, '../src/renderer'),
      '@shared': resolve(__dirname, '../src/shared'),
    }
    config.define = {
      ...config.define,
      'process.type': '"renderer"',
      'process.env.NODE_ENV': JSON.stringify(nodeEnv),
      'process.env.CHATBOX_BUILD_TARGET': JSON.stringify('unknown'),
      'process.env.CHATBOX_BUILD_PLATFORM': JSON.stringify('web'),
      'process.env.USE_LOCAL_API': JSON.stringify(''),
      'process.env.USE_BETA_API': JSON.stringify(''),
    }
    config.css = {
      ...config.css,
      postcss: resolve(__dirname, '../postcss.config.js'),
    }
    config.optimizeDeps = {
      ...config.optimizeDeps,
      include: [...(config.optimizeDeps?.include || []), '@mantine/core', '@mantine/hooks'],
    }
    config.server = {
      ...config.server,
      watch: {
        ...config.server?.watch,
        ignored: [
          '**/.env',
          '**/.env.*',
          ...(Array.isArray(config.server?.watch?.ignored) ? config.server.watch.ignored : []),
        ],
      },
    }
    return config
  },
}
export default config
