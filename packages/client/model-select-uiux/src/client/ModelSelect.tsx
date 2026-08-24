/**
 * ProviderFirstModelSelect: the composer's named model seat
 * (`conversation.input.model`) with a provider-first flow and a compact
 * ChatGPT-style reasoning-effort popover.
 *
 * Opening the model menu shows the PROVIDER list over the shared per-session
 * directory directly, and picking a provider reveals that provider's model
 * list — models never render before a provider is chosen. The menu contains
 * NO effort control.
 *
 * Effort lives in a compact pill beside the trigger ("High ▾"): clicking it
 * opens a temporary popover with the discrete levels (optional descriptions,
 * check on the selected level, subtle hover, full keyboard navigation) that
 * closes on selection, outside click, or Escape — the selector is never
 * permanently visible. The popover opens below the pill when there is room,
 * above otherwise, and is right-aligned to the trigger.
 *
 * This is a UI-only override of the shipped seat: data and submission ride
 * the SAME per-session directory the shipped placeholder uses (resolved by
 * the plugin's apply() from the shared `modelDirectories` service), so the
 * seat and the /model popup stay consistent.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent, type AnimationEvent,
} from 'react'
import clsx from 'clsx'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronLeftOutline14,
  IconChevronRightOutline14, IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected, ModelSelection } from './slots.ts'
import css from './ModelSelect.module.css'

/** Which pane the model dropdown shows: the provider list or one drilled-in list. */
type Pane = 'provider' | 'model'

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger, the compact effort pill, and the two temporary menus.
 */
export function ProviderFirstModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'providerModel'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('provider')
  // The provider drilled into by the model pane; null at the provider pane.
  const [providerId, setProviderId] = useState<string | null>(null)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  // Effort popover lifecycle: open, exit-animation flag, and placement.
  const [effortOpen, setEffortOpen] = useState(false)
  const [effortClosing, setEffortClosing] = useState(false)
  const [effortUp, setEffortUp] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const effortRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const effortItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const levels = reasoning?.efforts ?? []
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : levels.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effectiveIndex = effectiveEffort === undefined
    ? -1
    : levels.findIndex(level => level.id === effectiveEffort)
  const busy = state.status === 'selecting'
  // The drilled provider's group; undefined when a reload dropped it.
  const activeGroup = providerId === null
    ? undefined
    : state.groups.find(group => group.id === providerId)

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // Mount-time load resolves the trigger label; every open refreshes.
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  // The effort popover closes on any outside pointer interaction.
  // Recomputed on every render so closeEffort always sees fresh state.
  useEffect(() => {
    if (!effortOpen || effortClosing) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) closeEffort(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  })

  // Focus the selected level (or the first) when the popover opens.
  useEffect(() => {
    if (!effortOpen || effortClosing) return
    const items = effortItemRefs.current.filter(item => item !== null)
    const start = effectiveIndex >= 0 ? effectiveIndex : 0
    items[Math.min(start, items.length - 1)]?.focus()
  }, [effortOpen, effortClosing, effectiveIndex])

  if (!available) return null

  const show = (): void => {
    closeEffort(false)
    setPane('provider')
    setProviderId(null)
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('provider')
    setProviderId(null)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const openEffort = (): void => {
    close(false)
    const rect = effortRef.current?.getBoundingClientRect()
    // Estimated popover height: header + one row per level + padding.
    const estimated = 64 + levels.length * 52
    setEffortUp(rect !== undefined && rect.bottom + estimated > window.innerHeight)
    setEffortClosing(false)
    setEffortOpen(true)
  }

  const closeEffort = (restoreFocus = false): void => {
    if (!effortOpen || effortClosing) return
    // Exit animation owns the unmount: the closing class runs 120–150ms
    // and `settleEffortClosing` flips the state on animationend.
    setEffortClosing(true)
    if (restoreFocus) queueMicrotask(() => { effortRef.current?.focus() })
  }

  const settleEffortClosing = (): void => {
    setEffortOpen(false)
    setEffortClosing(false)
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const moveEffortFocus = (offset: number): void => {
    const items = effortItemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // The effort popover closes first when it is open (its own keydown
      // handles focus inside; this covers focus on the pill/trigger).
      if (effortOpen && !effortClosing) {
        event.preventDefault()
        closeEffort(true)
        return
      }
      if (!open) return
      event.preventDefault()
      // Escape backs out one drilled level at a time, then closes.
      if (pane === 'model') setPane('provider')
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onEffortKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeEffort(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveEffortFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onEffortAnimationEnd = (event: AnimationEvent<HTMLDivElement>): void => {
    // Only the EXIT animation unmounts the popover; the open (enter) animation
    // fires this same handler on the same element and must be ignored.
    if (effortClosing && event.target === event.currentTarget) settleEffortClosing()
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const announce = (accepted: boolean): void => {
    if (accepted) return
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    announce(false)
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  // Commit the picked level: same provider/model, new effort, then close.
  const commitEffort = (levelId: string): void => {
    if (state.current === null) return
    if (effectiveEffort === levelId) {
      closeEffort(true)
      return
    }
    lastActionRef.current = 'select'
    void select({
      provider: state.current.provider,
      model: state.current.model,
      reasoningEffort: levelId,
    }).then(announce)
    closeEffort(true)
  }

  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const triggerLabel = modelLabel
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : t('trigger.aria', { model: modelLabel })
  const showEffort = reasoning !== undefined && levels.length >= 2
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }
  effortItemRefs.current = []
  let effortItemIndex = 0
  const effortItemRef = () => {
    const at = effortItemIndex++
    return (node: HTMLButtonElement | null) => { effortItemRefs.current[at] = node }
  }
  // Catalog-load strips shared by both directory panes: loading, whole-load
  // error (Retry re-runs the load), and per-provider failure warnings.
  const catalogStrips = (
    <>
      {state.status === 'loading' && (
        <div className={css.status}>{t('status.loading')}</div>
      )}
      {state.error !== null && lastActionRef.current === 'load' && (
        <div className={css.error}>
          <span>{t('error.action', { message: state.error })}</span>
          <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
        </div>
      )}
      {state.failures.map(failure => (
        <div className={css.warning} key={failure.id}>
          <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
          <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
        </div>
      ))}
    </>
  )

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {showEffort && (
        <button
          ref={effortRef}
          type="button"
          className={css.pill}
          aria-label={effortLabel === undefined
            ? t('effort.pillAria', { effort: t('effort.providerDefault') })
            : t('effort.pillAria', { effort: effortLabel })}
          aria-haspopup="menu"
          aria-expanded={effortOpen}
          aria-controls={effortOpen ? `${id}-effort` : undefined}
          title={effortLabel}
          disabled={locked}
          onClick={() => {
            if (effortOpen) {
              closeEffort(true)
            } else {
              openEffort()
            }
          }}
        >
          <span className={css.pillLabel}>{effortLabel}</span>
          <IconChevronDownOutline14 className={clsx(css.chevron, effortOpen && css.chevronOpen)} />
        </button>
      )}

      {effortOpen && (
        <div
          id={`${id}-effort`}
          role="menu"
          aria-label={t('effort.menuAria')}
          className={clsx(
            css.effortMenu,
            effortUp ? css.effortMenuUp : css.effortMenuDown,
            effortClosing && css.effortMenuClosing,
          )}
          onKeyDown={onEffortKeyDown}
          onAnimationEnd={onEffortAnimationEnd}
        >
          <div className={css.effortHeader}>{t('effort.popoverTitle')}</div>
          {levels.map((level) => {
            const selected = effectiveEffort === level.id
            return (
              <button
                ref={effortItemRef()}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={clsx(css.effortOption, selected && css.effortOptionSelected)}
                key={level.id}
                disabled={busy}
                onClick={() => { commitEffort(level.id) }}
              >
                <span className={css.effortOptionCopy}>
                  <span className={css.effortOptionName}>{level.name}</span>
                  {level.description !== undefined && (
                    <span className={css.effortOptionDesc}>{level.description}</span>
                  )}
                </span>
                <span className={css.check}>
                  {selected ? <IconCheckOutline16 /> : null}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'provider' && (
            <>
              {catalogStrips}
              <div className={clsx(css.groups, 'scrollable')} role="group" aria-label={t('menu.provider')}>
                {state.groups.map((group) => {
                  const current = state.current?.provider === group.id
                  return (
                    <button
                      ref={itemRef()}
                      type="button"
                      role="menuitem"
                      className={css.cell}
                      key={group.id}
                      title={group.name}
                      onClick={() => { setProviderId(group.id); setPane('model') }}
                    >
                      <span className={css.cellLabel}>{group.name}</span>
                      <span className={css.grow} />
                      <span className={css.check}>{current ? <IconCheckOutline16 /> : null}</span>
                      <IconChevronRightOutline14 className={css.cellChevron} />
                    </button>
                  )
                })}
              </div>
              {state.status === 'ready' && state.groups.length === 0 && (
                <div className={css.empty}>{t('empty.providers')}</div>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              <button
                ref={itemRef()}
                type="button"
                role="menuitem"
                className={css.cell}
                aria-label={t('menu.back')}
                title={t('menu.back')}
                onClick={() => { setPane('provider') }}
              >
                <IconChevronLeftOutline14 className={css.cellChevron} />
                <span className={css.cellLabel}>{activeGroup?.name ?? t('menu.back')}</span>
              </button>
              {catalogStrips}
              {activeGroup === undefined ? null : (
                <>
                  <div className={clsx(css.groups, 'scrollable')}>
                    {activeGroup.models.map((model) => {
                      const selected = state.current?.provider === activeGroup.id && state.current.model === model.id
                      return (
                        <button
                          ref={itemRef()}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={clsx(css.option, selected && css.selected)}
                          key={model.id}
                          title={model.name}
                          disabled={busy}
                          onClick={() => { choose({ provider: activeGroup.id, model: model.id }) }}
                        >
                          <span className={css.optionCopy}>
                            <span className={css.modelName}>{model.name}</span>
                            {model.description !== undefined && (
                              <span className={css.description}>{model.description}</span>
                            )}
                          </span>
                          <span className={css.check}>
                            {selected ? <IconCheckOutline16 /> : null}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {activeGroup.models.length === 0 && (
                    <div className={css.empty}>{t('empty.models')}</div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
