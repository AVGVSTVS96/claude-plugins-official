import type { ChannelServer } from '../../hub/hub.ts'

const titleProperty = { type: 'string', description: 'One word, like a chat name ("Anchors", "Frontier").' }

// What each session's channel says and offers; the hub serves it over HTTP.
export const server: ChannelServer = {
  title: 'T3 Code',
  instructions: [
    'This session is one T3 Code thread. Unlike the chat apps, the user reads this session itself: T3 Code shows your text, tool calls and edits live as you work. So answer in plain text, as you would in a terminal; there is no reply tool here.',
    '',
    'Messages arrive as <channel source="t3" ts="...">. Images and files the user attaches show up in them as absolute paths: Read them. Your working directory is the project this thread was opened in.',
    '',
    'new_thread opens a thread in one of hex\'s chat apps (Discord, Telegram or Buzz) with its own fresh session, working in this project, and hands it your prompt. handoff continues this conversation in one of them when the user asks: a copy of this session carries on there with your memory, and you stay here.',
  ].join('\n'),
  tools: [
    {
      name: 'new_thread',
      description: 'Open a thread in Discord, Telegram or Buzz, start a fresh session for it in this project, and give that session the prompt as its first message.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', enum: ['discord', 'telegram', 'buzz'] },
          title: titleProperty,
          prompt: { type: 'string', description: "The user's request and the context the new session can't find itself: it starts from this prompt alone." },
          about: { type: 'string', description: 'One line the user sees first in the new thread, saying what it is for and where it came from.' },
          channel: { type: 'string', description: 'Discord or Buzz only: the channel to open it in, by name. Default: Discord\'s system channel, or Buzz\'s #general.' },
        },
        required: ['app', 'title', 'prompt', 'about'],
      },
    },
    {
      name: 'handoff',
      description: 'Continue this conversation in Discord, Telegram or Buzz when the user asks. It opens a thread there, where a copy of this session carries on with its full memory; this thread stays here.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', enum: ['discord', 'telegram', 'buzz'] },
          title: titleProperty,
          channel: { type: 'string', description: 'Discord or Buzz only: the channel to open it in, by name. Default: Discord\'s system channel, or Buzz\'s #general.' },
        },
        required: ['to', 'title'],
      },
    },
  ],
}
