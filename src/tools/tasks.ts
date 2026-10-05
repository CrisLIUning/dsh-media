/**
 * `media_tasks`: the video and audio tasks dsh-vibedev is following or has
 * finished, newest first.
 * @module dsh-vibedev/tools/tasks
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MediaError } from '../gateway/errors.js'
import type { MediaRuntime } from '../runtime.js'
import { isFinished } from '../tasks/store.js'
import { describeTask } from './common.js'

/**
 * Build the tool.
 * @param runtime - the media runtime.
 * @returns the tool definition.
 */
export function mediaTasksTool(runtime: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'media_tasks',
    description: 'Show the video and audio generation tasks dsh-vibedev is following or has finished (newest first): status, progress, '
      + 'saved files and charges. Background jobs already report completion, so use this only when asked, after a restart, '
      + 'or to look up an earlier result.',
    parameters: {
      task_id: { type: 'string', description: 'Show only this task.' },
      limit: { type: 'integer', description: 'How many recent tasks to show (default 10, at most 50).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          tasks: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                status: { type: 'string', required: true },
                model: { type: 'string', required: true },
                createdAt: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tasks.length === 0
          ? 'No media tasks yet.'
          : value.tasks.map(task => `- ${new Date(task.createdAt).toISOString().slice(0, 16).replace('T', ' ')} ${task.text}`).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const all = await runtime.store.list()
      const owner = exec.agent?.id
      const wanted = args.task_id?.trim()
      let tasks = wanted === undefined || wanted === '' ? all : all.filter(task => task.id === wanted)
      if (wanted !== undefined && wanted !== '' && tasks.length === 0) throw new MediaError(`There is no media task ${wanted}.`, 'UNKNOWN_TASK', { field: 'task_id' })
      if (wanted === undefined || wanted === '') {
        // This conversation's tasks first, then the rest.
        tasks = [...tasks.filter(task => task.owner === owner), ...tasks.filter(task => task.owner !== owner)]
      }
      const limit = Math.min(50, Math.max(1, Math.trunc(args.limit ?? 10)))
      const shown = tasks.slice(0, limit)
      // Make sure every live task is being followed (after a restart, say).
      for (const task of shown) if (!isFinished(task)) void runtime.tracker.follow(task.id).catch(() => undefined)
      return {
        tasks: shown.map(task => ({
          id: task.id, kind: task.kind, status: task.status, model: task.model, createdAt: task.createdAt,
          text: describeTask(runtime, exec, task),
        })),
      }
    },
  })
}
