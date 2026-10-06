await Promise.all([
  import('../external_plugins/telegram/bot.ts'),
  import('../external_plugins/discord/bot.ts'),
  import('../external_plugins/buzz/bot.ts'),
])
