A short note at the top of the README, right under its title, tells a visitor what this fork is before they read upstream's README.

It says this is a personal fork of [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) that holds the chat channels for [hex](https://github.com/AVGVSTVS96/hex), a personal assistant where every Telegram topic, Discord thread, Buzz thread, T3 Code thread and voice call is its own Claude Code session. It says what the fork's changes do, a few words each, linking each one's folder in `.autofork/`: the hub that gives every thread its own session, the reworked Telegram and Discord channels, the new Buzz, T3 Code and voice channels, and the marketplace named `hex`. It says the fork stays current with [autofork](https://autofork.com), which rebuilds it with these changes on top whenever upstream changes. And it says the one thing a visitor looking for hex's channels should know: hex now keeps its own copy of them and no longer installs them from this fork, which still has their history.

The note ends by saying everything below it is upstream's README, unchanged, and nothing below it differs from upstream.

Keep it plain and short: autofork named once, with its link, and no pitch.

Once the fork is retired, this patch is done.
