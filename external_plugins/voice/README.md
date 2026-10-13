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
5. The voice hands every question to Claude, status questions included, and
   only says Claude's answers. Claude is a dispatcher with work in background
   subagents, so answering never stops running work; the board keeps the
   voice aware of it.
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

   Who the voice is goes in `~/.claude/channels/voice/instructions.md`, the
   first lines of its prompt (a generic assistant if the file is missing),
   for example its name and the person it talks with. Everything else it
   learns from the session: when a call starts, Claude sends it what's going
   on now, and questions about the caller are handed to Claude.

2. Start a session with the channel:

   ```sh
   claude --dangerously-load-development-channels plugin:voice@hex
   ```

   Organizations that allowlist channels add
   `{ "plugin": "voice", "marketplace": "hex" }` to `allowedChannelPlugins` in
   managed settings, then start it with `--channels plugin:voice@hex`.

   In [hex](https://github.com/AVGVSTVS96/hex), the hub runs `bot.ts`, which
   keeps a session named `voice` always running with this channel, so the
   call page comes back by itself after restarts and updates. Each call gets
   a new session: when a call ends, the plugin asks the hub to renew, and once
   that turn is done the hub starts `voice` over fresh, with its own OptChat
   chat of past calls instead of one context that grows with every call.

3. Open the call page. The browser only allows the microphone on `localhost`
   or HTTPS:
   - On the same machine: `http://localhost:8790`.
   - From another computer: `ssh -L 8790:127.0.0.1:8790 <host>`, then
     `http://localhost:8790`.
   - From a phone on Tailscale: `tailscale serve --bg --https=8790 http://127.0.0.1:8790`,
     then `https://<host>.<tailnet>.ts.net:8790`.

The page listens on `127.0.0.1` only, and the API key never leaves the plugin.

## Phone calls

The plugin can also ring a phone through [Twilio](https://www.twilio.com):
Claude's `phone` tool, or **Call my phone** on the call page. Twilio places
the call and streams its audio (G.711 μ-law, passed through untouched) to a
`gpt-live-1` session over a WebSocket; handoffs, `say`, `note` and the board
work exactly as on the page.

```
phone ◄── PSTN ──► Twilio ── Media Stream (wss) ──► plugin /twilio/<one-time token>
                                                        │
                                                        ▼
                                           gpt-live-1 (audio/pcmu, 8 kHz) ◄─► Claude
```

Add to `~/.claude/channels/voice/.env`:

```sh
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_NUMBER=+1...                       # your Twilio number, the caller ID
CALLER_NUMBER=+1...                       # who "call me" rings
VOICE_PUBLIC_URL=host.example.com         # public HTTPS host that reaches /twilio on VOICE_PORT
```

Twilio has to reach `/twilio` from the internet, for example with
`tailscale funnel --bg --https=8443 --set-path=/twilio http://127.0.0.1:8790/twilio`
(`VOICE_PUBLIC_URL=<host>.<tailnet>.ts.net:8443`). Each call's stream URL
carries a one-time token, so nothing else gets through.

To call in, set your Twilio number's voice webhook (HTTP POST) to
`https://<VOICE_PUBLIC_URL>/twilio/incoming`. The plugin picks up only calls
Twilio signed whose caller is `CALLER_NUMBER`, and rejects the rest.

## Limits

- Each update to the voice is capped at 500 tokens by OpenAI. Long results
  belong in a chat channel, with a short spoken pointer.
- OpenAI exposes no turn-detection settings for `gpt-live-1`.
- Custom voices need OpenAI sales approval. Built-in voices work with any key.
- Voice costs $0.05 a minute, billed per second, on top of Claude usage.
- One call at a time. A new call ends the previous one.
