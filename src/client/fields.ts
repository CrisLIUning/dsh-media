/**
 * The settings the page edits: the plugin's live-editable config fields, and
 * how each converts between its stored value and the text a control stages.
 * Kept free of runtime imports so it can be tested outside a browser.
 */

import type { SettingsFieldSpec } from '@deepseek-ai/dsh-client-ui-primitives'

/** The settings namespace: the plugin's profile entry id. */
export const SETTINGS_NAMESPACE = 'dsh-vibedev'

/** The model slots, in page order. */
export const MODEL_FIELDS = ['imageModel', 'videoModel', 'musicModel', 'podcastModel', 'transcriptionModel'] as const

/** Every field the page edits. */
export const FIELDS = ['confirmSpending', 'outputDir', ...MODEL_FIELDS] as const

export type MediaSettingsField = typeof FIELDS[number]

/**
 * A switch field: the staged text is `true` or `false`, and saving always
 * writes the boolean (a switch has no empty state to clear with).
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : 'false',
    parse: text => ({ kind: 'set', value: text.trim() === 'true' }),
  }
}

/**
 * A free-text field: an empty draft clears the field, so it falls back to the
 * default (`media` for the folder, automatic choice for a model).
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function textField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/** The specs of every field the page edits. */
export function fieldSpecs(): SettingsFieldSpec[] {
  return [booleanField('confirmSpending'), textField('outputDir'), ...MODEL_FIELDS.map(textField)]
}
