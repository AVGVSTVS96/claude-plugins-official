import { free } from './hub.ts'

await Promise.all([
  import('../external_plugins/telegram/bot.ts'),
  import('../external_plugins/discord/bot.ts'),
  import('../external_plugins/buzz/bot.ts'),
  import('../external_plugins/t3/bot.ts'),
  import('../external_plugins/voice/bot.ts'),
])

process.on('SIGHUP', () => void free().then(() => process.exit(0)))
