/**
 * The dsh-vibedev settings page on the Plugins page: spending confirmation, the
 * output folder, the pinned models, and how the account works. Edits are
 * staged and written together by the save, like every settings page there.
 */

import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { SettingsForm, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFieldState, SettingsFormActions, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { MODEL_FIELDS, type MediaSettingsField } from './fields.ts'
import type { MediaSettingsKey } from './locales.ts'

/** Where new users register and everyone tops up. */
const VIBEDEV_SITE = 'https://vibedev.jzsaas.com'

/** What the page renders, rebuilt whenever the Host values or a staged edit change. */
export interface PageState {
  /** `loading` until the Host answers for the namespace. */
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly shell: SettingsFormShell
  readonly fields: Readonly<Record<MediaSettingsField, SettingsFieldState>>
}

/** A subscribable snapshot, as the form model's bound store provides. */
export interface PageStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): PageState
}

export type Translate = (key: MediaSettingsKey) => string

const styles = {
  section: { padding: '12px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
  firstSection: { padding: '0 0 12px' },
  sectionTitle: { margin: '0 0 2px', fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  sectionHint: { margin: '0 0 4px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
  switchRow: { display: 'flex', alignItems: 'center', gap: 16, padding: '10px 0 0' },
  switchText: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 },
  label: { fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
  link: { display: 'inline-block', marginTop: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-business-primary)' },
  quiet: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
} satisfies Record<string, CSSProperties>

function Section(props: { first?: boolean; title: string; hint?: string; children: ReactNode }) {
  return (
    <section style={props.first === true ? styles.firstSection : styles.section}>
      <h4 style={styles.sectionTitle}>{props.title}</h4>
      {props.hint === undefined ? null : <p style={styles.sectionHint}>{props.hint}</p>}
      {props.children}
    </section>
  )
}

/**
 * Render the settings page.
 * @param props - the dictionary, the form store and its actions.
 * @returns the page.
 */
export function MediaSettingsPage({ t, store, actions }: { t: Translate; store: PageStore; actions: SettingsFormActions }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  if (state.status === 'loading') return <p style={styles.quiet} role="status">{t('loading')}</p>
  const disabled = !state.shell.writable || state.shell.saving
  const textField = (field: MediaSettingsField) => ({
    text: state.fields[field].text,
    overridden: state.fields[field].overridden,
    invalid: state.fields[field].invalid,
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('invalid'),
    disabled,
    onEdit: (text: string) => { actions.edit(field, text) },
    onReset: () => { actions.resetField(field) },
  })
  return (
    <SettingsForm
      labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }}
      state={state.shell}
      onSave={actions.save}
      onDiscard={actions.discard}
    >
      <Section first title={t('spending')}>
        <div style={styles.switchRow}>
          <div style={styles.switchText}>
            <span style={styles.label}>{t('confirmSpending')}</span>
            <p style={styles.hint}>{t('confirmSpendingHint')}</p>
          </div>
          <Switch
            checked={state.fields.confirmSpending.text === 'true'}
            onChange={(next) => { actions.edit('confirmSpending', next ? 'true' : 'false') }}
            label={t('confirmSpending')}
            disabled={disabled}
          />
        </div>
      </Section>
      <Section title={t('output')}>
        <SettingsValueField id="dsh-vibedev-output-dir" label={t('outputDir')} hint={t('outputDirHint')} placeholder="media" {...textField('outputDir')} />
      </Section>
      <Section title={t('models')} hint={t('modelsHint')}>
        {MODEL_FIELDS.map(field => (
          <SettingsValueField key={field} id={`dsh-vibedev-${field}`} label={t(field)} placeholder={t('modelPlaceholder')} {...textField(field)} />
        ))}
      </Section>
      <Section title={t('account')}>
        <p style={styles.hint}>{t('accountHint')}</p>
        <a style={styles.link} href={VIBEDEV_SITE} target="_blank" rel="noreferrer">{t('register')}</a>
      </Section>
    </SettingsForm>
  )
}
