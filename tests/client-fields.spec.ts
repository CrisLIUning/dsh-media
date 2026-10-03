import { describe, expect, it } from 'vitest'
import { FIELDS, MODEL_FIELDS, booleanField, fieldSpecs, textField } from '../src/client/fields.js'
import { Config } from '../src/index.js'

describe('settings page fields', () => {
  it('edits exactly the plugin\'s live-editable settings', () => {
    const live = Object.entries((Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }).dict)
      .filter(([, schema]) => schema.meta?.volatile === true).map(([key]) => key)
    expect([...FIELDS].sort()).toEqual(live.sort())
    expect(fieldSpecs().map(spec => spec.field)).toEqual([...FIELDS])
    expect(MODEL_FIELDS).toHaveLength(5)
  })

  it('stages a switch as true or false and always writes the boolean', () => {
    const spec = booleanField('confirmSpending')
    expect([spec.format(true), spec.format(false), spec.format(undefined)]).toEqual(['true', 'false', 'false'])
    expect(spec.parse('true')).toEqual({ kind: 'set', value: true })
    expect(spec.parse('false')).toEqual({ kind: 'set', value: false })
  })

  it('clears a text field when it is emptied, so it falls back to the default', () => {
    const spec = textField('videoModel')
    expect(spec.format('seedance-2.0')).toBe('seedance-2.0')
    expect(spec.format(undefined)).toBe('')
    expect(spec.parse('  seedance-2.0 ')).toEqual({ kind: 'set', value: 'seedance-2.0' })
    expect(spec.parse('   ')).toEqual({ kind: 'clear' })
  })
})
