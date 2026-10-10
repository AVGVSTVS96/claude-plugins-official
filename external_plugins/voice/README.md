# voice

Live voice calls for Claude Code. OpenAI's `gpt-live-1` talks with you in real
time; your Claude Code session does the real work and tells it what to say.

```
 you ─── WebRTC audio ───► gpt-live-1     talks, listens, handles interruptions,
                              │           decides when it needs the backend
                              │ handoff (an id, no text)
                              ▼
                         voice plugin     keeps the one ordered transcript and the
                              │           task board; makes no decisions
                              │ channel message: transcript since the last handoff
                              ▼
                         Claude Code      decides everything: answer, start work,
                                          follow up, cancel
```

The voice model runs in [client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
mode, so it has no tools and no way to start or stop work. It can only ask for
the backend. Every task is Claude's, and keeps running until the caller asks
Claude to stop that task.

## How a call flows

1. You open the call page and press **Start call**. The page sends its WebRTC
   offer to the plugin, the plugin starts a `gpt-live-1` session with
   OpenAI, and attaches a server-side connection to the same session.
2. The plugin hears every transcript fragment from both sides and keeps them in
   timeline order (by `start_ms`), so lines that arrive late still land in the
   right place.
3. When the voice model hands off (`session.delegation.created`), the plugin
   waits for the first words spoken after that moment, so the request is fully
   transcribed, then sends Claude everything said since the last handoff.
4. Claude answers with its tools:

   | Tool | Goes to the voice as | For |
   | --- | --- | --- |
   | `say` | `session.commentary.append` | a result to say aloud (it paraphrases) |
   | `note` | `session.thinking.append` | a fact to know without saying it yet |
   | `task` | `session.thinking.append` (the whole board) | task status: running, done, failed |

   Each tool returns once OpenAI acknowledges the update.
5. The voice answers "how's it going?" from the board, without a handoff, so
   status questions never touch running work.
6. When the call ends, Claude gets the last words and a "call ended" message.

## Setup

1. Put an OpenAI API key with access to `gpt-live-1` (a paid tier) in
   `~/.claude/channels/voice/.env`:

   ```sh
   OPENAI_API_KEY=sk-...
   # optional
   VOICE=marin        # one of OpenAI's built-in voices; OpenAI's default if unset
   VOICE_PORT=8790    # the call page's local port
   ```

2. Start a session with the channel:

   ```sh
   claude --dangerously-load-development-channels plugin:voice@hex
   ```

   Organizations that allowlist channels add
   `{ "plugin": "voice", "marketplace": "hex" }` to `allowedChannelPlugins` in
   managed settings, then start it with `--channels plugin:voice@hex`.

3. Open the call page. The browser only allows the microphone on `localhost`
   or HTTPS:
   - On the same machine: `http://localhost:8790`.
   - From another computer: `ssh -L 8790:127.0.0.1:8790 <host>`, then
     `http://localhost:8790`.
   - From a phone on Tailscale: `tailscale serve --bg --https=8790 http://127.0.0.1:8790`,
     then `https://<host>.<tailnet>.ts.net:8790`.

The page listens on `127.0.0.1` only, and the API key never leaves the plugin.

## Limits

- Each update to the voice is capped at 500 tokens by OpenAI. Long results
  belong in a chat channel, with a short spoken pointer.
- OpenAI exposes no turn-detection settings for `gpt-live-1`.
- Custom voices need OpenAI sales approval. Built-in voices work with any key.
- Voice costs $0.05 a minute, billed per second, on top of Claude usage.
- One call at a time. A new call ends the previous one.
