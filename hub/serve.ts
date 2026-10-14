import { free } from './hub.ts'

// Before the clients load: Telegram's bot module awaits its polling loop, which never ends.
process.on('SIGHUP', () => void free().then(() => process.exit(0)))

await Promise.all([
  import('../external_plugins/telegram/bot.ts'),
  import('../external_plugins/discord/bot.ts'),
  import('../external_plugins/buzz/bot.ts'),
  import('../external_plugins/t3/bot.ts'),
  import('../external_plugins/voice/bot.ts'),
])
