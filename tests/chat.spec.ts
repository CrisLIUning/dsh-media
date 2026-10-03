import { describe, expect, it } from 'vitest'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Message } from '@deepseek-ai/dsh-llm'
import { chatAttachments, loadChatReference, parseChatReference } from '../src/media/chat.js'
import { MP3, MP4, PNG } from './fixtures.js'

const image = (id: string, name: string): ImageAttachmentRef => ({ attachmentId: id, mediaType: 'image/png', bytes: PNG.byteLength, width: 1, height: 1, name } as unknown as ImageAttachmentRef)
const file = (id: string, name: string, bytes: number): FileAttachmentRef => ({ attachmentId: id, name, bytes } as unknown as FileAttachmentRef)

const messages = [
  { id: 'm1', role: 'user', source: {}, content: [{ type: 'image', attachment: image('i1', 'old.png') }, { type: 'text', text: 'first' }] },
  { id: 'm2', role: 'assistant', source: {}, content: [{ type: 'text', text: 'ok' }] },
  {
    id: 'm3', role: 'user', source: {},
    content: [
      { type: 'file', attachment: file('f1', 'dance.mp4', MP4.byteLength) },
      { type: 'image', attachment: image('i2', 'new.png') },
      { type: 'file', attachment: file('f2', 'song.mp3', MP3.byteLength) },
    ],
  },
] as unknown as Message[]

const store = {
  readImage: async (ref: ImageAttachmentRef) => ({ ref, data: PNG }),
  async *readFileStream(ref: FileAttachmentRef) {
    const data = ref.name.endsWith('.mp4') ? MP4 : MP3
    yield data.subarray(0, 4)
    yield data.subarray(4)
  },
} as unknown as AttachmentStore

describe('chat references', () => {
  it('parses chat:N and chat:<kind>:N', () => {
    expect(parseChatReference('chat:1')).toEqual({ index: 1 })
    expect(parseChatReference(' chat:Video:2 ')).toEqual({ kind: 'video', index: 2 })
    expect(parseChatReference('chat:0')).toBeUndefined()
    expect(parseChatReference('chat.png')).toBeUndefined()
  })

  it('lists the user\'s attachments, most recent first', () => {
    expect(chatAttachments(messages).map(item => `${item.kind}:${item.name}`)).toEqual(['audio:song.mp3', 'image:new.png', 'video:dance.mp4', 'image:old.png'])
  })

  it('loads the Nth attachment of the kind the input needs', async () => {
    expect(await loadChatReference({ index: 1 }, 'image', messages, store, 1024)).toEqual({ source: 'chat:1', name: 'new.png', mime: 'image/png', data: PNG })
    expect((await loadChatReference({ index: 2 }, 'image', messages, store, 1024)).name).toBe('old.png')
    expect(await loadChatReference({ index: 1 }, 'video', messages, store, 1024)).toEqual({ source: 'chat:1', name: 'dance.mp4', mime: 'video/mp4', data: MP4 })
    expect((await loadChatReference({ kind: 'audio', index: 1 }, 'audio', messages, store, 1024)).mime).toBe('audio/mpeg')
  })

  it('explains a reference that names nothing, or the wrong kind', async () => {
    await expect(loadChatReference({ index: 2 }, 'video', messages, store, 1024)).rejects.toMatchObject({ code: 'CHAT_REFERENCE_NOT_FOUND' })
    await expect(loadChatReference({ kind: 'audio', index: 1 }, 'image', messages, store, 1024)).rejects.toMatchObject({ code: 'CHAT_REFERENCE_KIND_MISMATCH' })
    await expect(loadChatReference({ index: 1 }, 'video', messages, store, 4)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
  })
})
