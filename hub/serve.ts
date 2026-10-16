import { PORT, free, route } from './hub.ts'

// Before the clients load: Telegram's bot module awaits its polling loop, which never ends.
process.on('SIGHUP', () => void free().then(() => process.exit(0)))
Bun.serve({ hostname: '127.0.0.1', port: PORT, idleTimeout: 0, fetch: route })

await Promise.all([
  import('../external_plugins/telegram/bot.ts'),
  import('../external_plugins/discord/bot.ts'),
  import('../external_plugins/buzz/bot.ts'),
  import('../external_plugins/t3/bot.ts'),
  import('../external_plugins/voice/bot.ts'),
])
