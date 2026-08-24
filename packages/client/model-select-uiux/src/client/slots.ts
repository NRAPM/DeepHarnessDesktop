/**
 * Local structural types for the provider-first override.
 *
 * The plugin deliberately does NOT import the upstream `ui-model-selection`
 * package's types: it reads the shared `modelDirectories` service at runtime
 * (the same service the shipped seat uses), so the override only needs the
 * leaf fields it renders. Structural compatibility is enough — the service's
 * state satisfies these interfaces.
 */

/** Complete provider/model/reasoning selection. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** One dynamic reasoning-effort level. */
export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

/** Adapter-owned reasoning metadata for one advertised model. */
export interface ModelReasoning {
  efforts: readonly ModelReasoningEffort[]
  defaultEffort?: string
}

/** One advertised model within a provider group. */
export interface AdvertisedModel {
  id: string
  name: string
  description?: string
  reasoning?: ModelReasoning
}

/** One provider group of the advisory directory. */
export interface ModelProviderGroup {
  id: string
  name: string
  models: readonly AdvertisedModel[]
}

/** Provider-local catalog failure surfaced inline. */
export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** Per-session directory snapshot rendered by the seat (leaf fields only). */
export interface ModelDirectoryState {
  current: ModelSelection | null
  routable: boolean | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

/** Minimal snapshot-store face the seat consumes (subset of the real store). */
export interface DirectoryStore {
  subscribe(fn: () => void): () => void
  getSnapshot(): ModelDirectoryState
}

/** The per-session directory face the override consumes (subset of ModelDirectory). */
export interface ModelDirectory {
  readonly store: DirectoryStore
  load(): Promise<unknown>
  select(selection: ModelSelection): Promise<void>
}

/** The shared `modelDirectories` service face the override consumes. */
export interface ModelDirectoryService {
  directoryFor(sessionId: unknown): ModelDirectory
}

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: DirectoryStore
  /** Refresh the advisory directory (fire-and-forget; errors land on the store). */
  load: () => void
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns whether the host accepted the selection.
   */
  select: (selection: ModelSelection) => Promise<boolean>
}
