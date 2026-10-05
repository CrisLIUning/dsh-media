/**
 * The DeepSeek Harness patch to pi-ai 0.87.1 (vibedev-app
 * patches/@earendil-works__pi-ai@0.87.1.patch), applied while bundling: pi-ai
 * re-parses a tool call's whole partial JSON on every streamed delta, which
 * costs quadratic time on long tool arguments (a large file being written).
 * The Harness drops those per-delta parses; the parse when the tool call ends
 * stays. Each patch must match exactly once, so a pi-ai upgrade that moves the
 * code fails the build instead of silently shipping unpatched code.
 */

const PATCHES = [
  {
    file: /pi-ai[\\/]dist[\\/]api[\\/]anthropic-messages\.js$/,
    // The same statement also finalizes the block on content_block_stop; only the one after the delta goes.
    from: /(block\.partialJson \+= event\.delta\.partial_json;)\r?\n[ \t]*block\.arguments = parseStreamingJson\(block\.partialJson\);/,
  },
  {
    file: /pi-ai[\\/]dist[\\/]api[\\/]openai-completions\.js$/,
    from: /(block\.partialArgs = \(block\.partialArgs \?\? ""\) \+ toolCall\.function\.arguments;)\r?\n[ \t]*block\.arguments = parseStreamingJson\(block\.partialArgs\);/,
  },
  {
    file: /pi-ai[\\/]dist[\\/]api[\\/]openai-responses-shared\.js$/,
    from: /(slot\.block\.partialJson \+= event\.delta;)\r?\n[ \t]*slot\.block\.arguments = parseStreamingJson\(slot\.block\.partialJson\);/,
  },
]

/**
 * A rolldown plugin applying the patches.
 * @returns the plugin.
 */
export function piAiStreamingJsonPatch() {
  const applied = new Set()
  return {
    name: 'dsh-vibedev:pi-ai-streaming-json',
    buildStart() {
      applied.clear()
    },
    transform(code, id) {
      const patch = PATCHES.find(candidate => candidate.file.test(id))
      if (patch === undefined) return null
      const count = code.match(new RegExp(patch.from.source, 'g'))?.length ?? 0
      if (count !== 1) throw new Error(`pi-ai streaming-JSON patch: expected one match in ${id}, found ${count}`)
      applied.add(patch)
      return { code: code.replace(patch.from, '$1'), map: null }
    },
    buildEnd(error) {
      if (error === undefined && applied.size !== PATCHES.length) {
        throw new Error(`pi-ai streaming-JSON patch: applied ${applied.size} of ${PATCHES.length}; a patched file was not bundled`)
      }
    },
  }
}
