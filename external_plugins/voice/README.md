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
   | `send` | the board, as running until the thread is done | work for another hex thread (hex only) |
   | `hang_up` | `session.close`, once the voice stops talking | ending the call |

   Each tool returns once OpenAI acknowledges the update.
5. The voice hands every question to Claude, status questions included, and
   only says Claude's answers. Claude is a dispatcher with work in background
   subagents, so answering never stops running work; the board keeps the
   voice aware of it.
6. When the call ends, Claude gets the last words and a "call ended" message,
   and names the call with `title`.

## Call history

Every call is saved as one JSON file in `~/.claude/channels/voice/calls/`,
named by its `gpt-live-1` session id: when it starts, after every handoff and
task change, and when it ends, so a crash keeps almost all of it.

```json
{
  "id": "sess_...", "started": "2026-10-13T03:05:12.000Z", "ended": "...",
  "end": "you", "reason": "close_requested", "from": "app", "voice": "marin", "title": "Voice app history",
  "claude": "c0f06426-...", "why": "Your build finished",
  "summary": "Checked CI and sent the PR link to Telegram.", "waiting": ["Merge the PR"],
  "expires": "...", "usage": { "seconds": 312.4, "dollars": 0.26, "context": 0.18 },
  "turns": [{ "who": "you", "at": 3400, "text": "Hello there" }],
  "tasks": [{ "id": "plan", "state": "running", "at": 61200, "text": "..." }],
  "moments": [{ "kind": "say", "at": 8100, "text": "CI is green." }]
}
```

`from` is where the call came from: `app`, `web` (the call page), `phone-in`
or `phone-out`. `end` is how it ended: `you` (the caller hung up), `hex`
(Claude hung up with `hang_up`, or the voice service ended it), `dropped`,
`expired` (the session's time limit), `no-connect`, `no-answer` or `busy`;
`reason` says why in words. Every way the caller ends a call (the page, an
app, the phone, `DELETE /session`) sends `session.close` with an `event_id`
starting `close-you`; `hang_up` sends one starting `close_hex`.

Calls that never connect are saved too, with no turns: an app or page whose
`/session` OpenAI refused, a phone session OpenAI refused, and a placed phone
call nobody answered, that was busy, or that failed (Twilio reports each
placed call's outcome to `/twilio/status/<token>`). Claude gets a message for
each, with why it was calling.

`why` is the reason Claude gave `phone`; `summary` and `waiting` are Claude's
wrap-up from `title`; `moments` are Claude's exact `say` and `note` words
(the voice paraphrases them aloud), the time-limit warning, and when the
caller's phone took the audio (`paused`, `resumed`). `usage` is OpenAI's
billed audio seconds, their cost, and how full the voice's context got;
`expires` is when OpenAI ends the session, and two minutes before it the voice
and Claude are told. `at` is milliseconds from the start of the call; `claude` is
the Claude Code session that did the work. Each speaker's words are joined
the way live captions show them: a pause of over two seconds starts a new turn.
Tasks often finish after the caller hangs up; `task` with that call's id keeps
updating its record.

| Request | Answers |
| --- | --- |
| `GET /calls` | `{ version, live, calls }`, newest first, each without its turns, with `seconds`, how many `tasks` and a `preview` of the caller's first words |
| `GET /calls?after=<version>` | the same, once anything has changed since that version (or after 25 seconds) |
| `GET /calls/<id>` | one whole call |
| `DELETE /calls/<id>` | deletes a finished call |
| `POST /calls/<id>/moments` | `{ "kind": "paused" \| "resumed", "text": "..." }` from the app when the phone takes its audio (a phone call or Siri) and gives it back; the voice is told to wait |

## Dropped connections and restarts

If the plugin's connection to a page or app call drops, it reattaches to the
same session by its id (`/v1/live/sessions/<id>/attach`) a few times over
about 15 seconds before calling the call dropped. When the plugin starts, it
picks the latest call that never got an end back up the same way and sends
Claude a "call resumed" message with the call so far; any other call left
without an end is closed out as `dropped`. A phone call's audio runs through
the plugin, so a restart ends it. When a call starts, the plugin tells the hub
to keep the session (`keep`), so a renew asked for by the call before it
doesn't stop the session mid-call.

In hex the plugin restarts with each call's new session, so the hub holds the
port instead (`door.ts`): it starts the plugin with `VOICE_SOCKET` set to
`state/voice/http.sock`, the plugin listens there, and the hub passes every
request and websocket on to it. A request that comes while the
plugin restarts waits for it to come back (up to 30 seconds) instead of failing.

## Agent activity

While a call is live, the app can show one line of what hex's agents are
doing: "Reading server.ts", "Started an agent: tune the glide", or the agent's
own words. Each line comes from the agent's Claude Code transcript, read as
Claude Code writes it and turned into ACP `session/update` notifications (the
same conversion hex uses for Buzz and T3 Code), then into a few plain words.

```
 Claude's background subagent ── task(id, running, text, agent) ─┐
 another hex thread ────────────── send(thread, about, text) ─────┤
                                                                  ▼
                     its transcript (.jsonl) ── ACP updates ── one line per task
                                                                  │
                                         GET /activity?after=<version>
                                                                  ▼
                                                     the app's live line
```

- `task` with `agent` (the agentId the Agent tool returned) follows that
  subagent until the task is done or failed.
- `send` (in hex) delivers a message to a Telegram topic, or a Discord, Buzz
  or T3 Code thread, puts it on the board, follows that thread's session from
  the moment it takes the message in, background agents included, and marks
  it done when a turn ends with none of them still out (failed if the turn
  ends on an API error). It keeps updating the call's record after you hang
  up: the plugin that starts with the next session picks unfinished sends
  from the last day back up, reading their threads from the start.

| Request | Answers |
| --- | --- |
| `GET /activity` | `{ version, call, tasks }`: the live call's tasks, most recently changed first, each with its latest `line` |
| `GET /activity?after=<version>` | the same, once anything has changed since that version (or after 25 seconds) |

## Tasks

In hex, the app can also show every hex thread as a task, call or no call:
what needs you, what's working and its newest step, and what finished. Nothing
new reports in: `tasks.ts` reads the records Claude Code already keeps (the
same ones `claude agents --json` prints) and wakes when one of them changes.

```
 ~/.claude/jobs/<id>/state.json      working, blocked or done; its status line; what it needs
 ~/.claude/jobs/<id>/timeline.jsonl  each change, with its time
 ~/.claude/sessions/<pid>.json       which sessions are running
 state/<app>/threads.json            each thread's name and current session
 <session>.jsonl transcripts         a working thread's newest step, its agents' too
                    │
                    ▼
        GET /tasks?after=<version> ── the app's Tasks sheet
```

A blocked thread needs you; a working one whose session stopped counts as idle;
anything that finished more than a week ago is left out. Rows come in that
order (needs you, working, done, failed, idle), newest change first in each.

| Request | Answers |
| --- | --- |
| `GET /tasks` | `{ version, tasks }`: each thread's `id`, `name`, `where` (Telegram, General, Discord...), `state` (`needs`, `working`, `done`, `failed`, `idle`), one `line`, `since` its state began, `at` its last change, its running `agents` with their own lines, and a Telegram `link` |
| `GET /tasks?after=<version>` | the same, once anything has changed (or after 25 seconds) |
| `GET /tasks/summary?after=<version>` | `{ version, needs, working }`, once a count changes |
| `GET /tasks/<id>` | one task, with what it `needs` from you in full and what it did `lately` |
| `POST /tasks/<id>/talk` | during a call: the voice brings the task up, and Claude hears which thread it is |

An app starting a call with `"about": "<task id>"` in its `/session` body gets
the same: the voice opens with the task, and Claude's "call started" message
names it, so `send` can reach that thread.

## Asks

Everything waiting on you, in one list the app answers in place. The Telegram
hub keeps a ledger (`state/telegram/ledger.json`, `hub/ledger.ts`): every
question a thread asks with buttons or a poll, what became of it (tapped,
answered in the app or on a call, settled, edited away), and each thread's
pinned status post as last written. `asks.ts` reads it, with T3 Code's own
records (`t3.ts`, read only) for what's stuck and what finished since you
looked.

```
 reply(buttons) / poll ──► telegram hub ──► ledger.json ─┐
 tap in Telegram ─────────►      │                       ├─► asks.ts ── GET /asks?after=<version>
 pin / edit_message ──────►      │                       │                      │
 ~/.t3/userdata/statev2.sqlite ──────────── t3.ts ───────┘                      ▼
                                 ▲                                         the app's Tasks
            {type:"answer"} on hub.sock ◄── POST /asks/<id>/answer ◄───────────┘
```

An answer from the app reaches the thread as your own tap would (with
`answered_in`), and its Telegram buttons change to "Answered in the app". A
poll can't take a vote from the bot, so it closes instead. Undo puts the
buttons back and tells the thread the answer no longer stands.

| Request | Answers |
| --- | --- |
| `GET /asks` | `{ version, asks, stuck, fresh, check }`: each open question's `id`, `kind` (`pick`, `yesno`, `do`, `look`), `task` and `topic` (its thread), `question`, `context`, `options` (`label`, `pick`, `url`), `tag`, `places` and a `link` to it; what's `stuck` (`title`, `why`, one `action`); what finished since you looked (`fresh`, with `read`); and the last check's time and counts |
| `GET /asks?after=<version>` | the same, once anything has changed (or after 25 seconds) |
| `POST /asks/<id>/answer` | `{ "label": "..." }`: answers it |
| `POST /asks/<id>/undo` | takes that answer back |
| `POST /stuck/<id>/act` | does its action: asks hex's General to fix it, or puts it away until it changes |
| `POST /fresh/<id>/read` | marks a finished result read |
| `POST /asks/talk` | during a call: Claude walks you through them, one card at a time |
| `GET /asks/check` | the last check in full: what it `read`, what it `fixed` on its own, what it `flagged` |
| `GET /tasks/summary` | also counts what's `yours` |
| `GET /tasks/<id>` | also the thread's own `asks` and its pinned post (`pin`) |

### The check

`check.ts` is hex auditing its own asks against what actually happened: an
Opus pass (`claude -p`, read-only tools, structured output) over the ledger's
open and lately closed questions, every pinned post, the last three days of
call wrap-ups and what T3 Code shows. It rewrites the raw questions into one
list (repeats merged into one ask with every place that asked it, hex's pick,
what each unblocks or costs, most unblocking first), settles the questions the
records show are already decided or done (their buttons say why), and flags
what it can't settle. It never answers for you.

It runs on real events, one pass at a time in a process of its own (so it
outlives the voice session that started it), and anything that happens during
a pass starts one more when it ends: a pinned post changes, a T3 run ends, a
call's wrap-up lands, or Tasks opens with questions newer than the last pass.
It writes `state/voice/check.json`; `check/error` keeps the last failure.

### On a call

In hex the voice session also has `ask` (put an open ask on the caller's
screen as a card in the transcript, by id) and `answer` (send the choice they
said aloud). `GET /activity` carries the call's cards as `asks`, each with its
answer once it has one; a tap on a card answers it like the Tasks sheet does,
and Claude hears it. An app starting a call with `"about": "asks"` (Go through
them with hex) gets Claude walking the list in order.

## Setup

1. Put an OpenAI API key with access to `gpt-live-1` (a paid tier) in
   `~/.claude/channels/voice/.env`:

   ```sh
   OPENAI_API_KEY=sk-...
   # optional
   VOICE=marin        # one of OpenAI's built-in voices; OpenAI's default if unset
   VOICE_PORT=8790    # the call page's local port
   VOICE_TOKEN=...    # if set, /session, /calls and /phone need "Authorization: Bearer <token>"
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
   that turn is done the hub starts `voice` over fresh right away, with its own
   OptChat chat of past calls instead of one context that grows with every
   call. The hub holds `VOICE_PORT` meanwhile, so a call started then waits a
   few seconds instead of failing.

3. Open the call page. The browser only allows the microphone on `localhost`
   or HTTPS:
   - On the same machine: `http://localhost:8790`.
   - From another computer: `ssh -L 8790:127.0.0.1:8790 <host>`, then
     `http://localhost:8790`.
   - From a phone on Tailscale: `tailscale serve --bg --https=8790 http://127.0.0.1:8790`,
     then `https://<host>.<tailnet>.ts.net:8790`.

The page listens on `127.0.0.1` only, and the API key never leaves the plugin.
With `VOICE_TOKEN` set, every request except the page itself and Twilio's
(which carry their own signature or one-time token) needs the token, so
other devices on the same tailnet can't read or delete calls. The page gets it
filled in when opened on `127.0.0.1` directly; through a proxy like
`tailscale serve`, open it once as `https://<host>:8790/#token=<token>` and
the browser keeps it.

An app can hold the same call: POST its WebRTC offer to `/session` as
`{ "sdp": "...", "voice": "marin", "from": "app" }` (the voice is optional; `from`
marks the call as the app's in the call history), and it gets
OpenAI's session back, with the answer SDP in `transport.sdp`. Its data
channel may send `session.input_audio.mute`, `session.input_audio.unmute` and
`session.close`; `DELETE /session` ends the call from outside it.
[hex-voice](https://github.com/AVGVSTVS96/hex-voice) is an iPhone app built this way.

## Phone calls

The plugin can also ring a phone through [Twilio](https://www.twilio.com):
Claude's `phone` tool, or **Call my phone** on the call page. Twilio places
the call and streams its audio (G.711 μ-law, passed through untouched) to a
`gpt-live-1` session over a WebSocket; handoffs, `say`, `note` and the board
work exactly as on the page. `phone` takes `why`, the reason Claude is
calling, which the voice opens with; notes Claude sends while it rings reach
the voice when the call connects, and Twilio reports how each placed call
ended to a signed status callback, so an unanswered or failed call is saved
and Claude hears about it.

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
