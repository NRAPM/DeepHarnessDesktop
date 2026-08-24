/**
 * Provider-first model selection plugin, browser half — a UI-only override of
 * the composer's `conversation.input.model` seat.
 *
 * It reuses the shared per-session model directory (`ctx.modelDirectories`,
 * the same service the shipped ui-model-selection plugin registers) so the
 * seat keeps its single source of truth with the /model popup, and replaces
 * ONLY the rendered menu with the provider-first flow:
 *
 *   open → providers → pick provider → that provider's models → pick model
 *
 * The seat is a `single`-occupant slot with `replaceRisk: shadows-shipped-ui`,
 * so this plugin's registration genuinely takes the seat away from the
 * shipped picker. If the upstream `ui-model-selection` plugin is ever absent
 * (no `modelDirectories` service), this plugin degrades to a no-op and the
 * default seat stays as-is.
 */
// Type-only: the carrier types and the seat's ctx/slot merges.
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.model seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ModelDirectoryService, ModelSelectInjected } from './slots.ts'
import { ProviderFirstModelSelect } from './ModelSelect.tsx'
import { en, zh, type ModelKey } from './locales.ts'

export type { ModelSelectInjected } from './slots.ts'
export type { ModelKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The provider-first model seat's copy (this plugin's own namespace). */
    providerModel: ModelKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'providerModel'

/** Services the overridden seat needs inside the plugin scope. */
export const inject = ['locale', 'slots', 'sessions']

/**
 * Client plugin body: register the `providerModel` dictionaries, then replace
 * the composer model seat with the provider-first UI. The seat reuses the
 * shared per-session directory through `modelDirectories` (waited on via the
 * nested ctx.inject so ordering against the upstream plugin is irrelevant).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'provider-first: dictionaries')

  ctx.inject(['modelDirectories'], (scope: ClientContext) => {
    const modelService = scope.get('modelDirectories') as ModelDirectoryService | undefined
    if (modelService === undefined) return
    const models = modelService
    const sessions = scope.sessions
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      locale: NS,
      priority: -1,
      inject: (sessionId): ModelSelectInjected => {
        const directory = models.directoryFor(sessionId)
        const available = sessions.subagentAddress(sessionId) === undefined
        return {
          available,
          directory: directory.store,
          load: () => {
            if (available) directory.load().catch(() => { /* surfaced on the store */ })
          },
          select: selection => available
            ? directory.select(selection).then(() => true, () => false)
            : Promise.resolve(false),
        }
      },
    }, ProviderFirstModelSelect))
  })
}
