import type { ChannelServer } from '../../hub/hub.ts'

// What each session's channel says and offers; the hub serves it over HTTP.
export const server: ChannelServer = {
  title: 'T3 Code',
  instructions: [
    'This session is one T3 Code thread. Unlike the chat apps, the user reads this session itself: T3 Code shows your text, tool calls and edits live as you work. So answer in plain text, as you would in a terminal; there is no reply tool here.',
    '',
    'Messages arrive as <channel source="t3" ts="...">. Images and files the user attaches show up in them as absolute paths: Read them. Your working directory is the project this thread was opened in.',
  ].join('\n'),
  tools: [],
}
