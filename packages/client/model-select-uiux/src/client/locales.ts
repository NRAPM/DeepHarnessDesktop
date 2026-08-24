/**
 * `providerModel` namespace dictionaries owned by this plugin.
 *
 * This is this plugin's OWN namespace (distinct from the shipped `model`
 * namespace): registering it avoids any collision with the upstream
 * ui-model-selection dictionaries while the seat registration points the
 * locale seat at it. The key set is exactly what the ProviderFirstModelSelect
 * component reads — plus common vocabulary (`retry`, …) served by the shared
 * `common` namespace.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger.fallback': '选择模型',
  'trigger.selectAria': '选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'menu.aria': '模型与推理等级',
  'menu.provider': '提供方',
  'menu.back': '返回',
  'effort.providerDefault': 'Default',
  'effort.pillAria': '推理等级，当前 {effort}',
  'effort.menuAria': '选择推理等级',
  'effort.popoverTitle': '推理等级',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'empty.models': '没有可用的模型。',
  'empty.providers': '没有可用的提供方。',
} satisfies Record<string, string>

/** The providerModel namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger.fallback': 'Select model',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'menu.aria': 'Model and reasoning effort',
  'menu.provider': 'Providers',
  'menu.back': 'Back',
  'effort.providerDefault': 'Default',
  'effort.pillAria': 'Reasoning effort, current {effort}',
  'effort.menuAria': 'Choose reasoning effort',
  'effort.popoverTitle': 'Reasoning effort',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'warning.groupLoad': '{name} failed to load: {message}',
  'empty.models': 'No models available.',
  'empty.providers': 'No providers available.',
} satisfies Record<ModelKey, string>
