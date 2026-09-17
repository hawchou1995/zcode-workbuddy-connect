/**
 * WorkBuddy model catalog: a static fallback list captured from the live CN
 * endpoint, replaced by the upstream's dynamic answer once it loads.
 *
 * The fallback exists so the provider registers a usable roster even while the
 * first fetch is in flight or offline. It is deliberately *not* a promise about
 * the upstream's current state.
 *
 * @module workbuddy-connect/catalog
 */

import { modelWithCurrentPromotion } from './upstream.js'

/**
 * Static CLI models observed on the CN endpoint. Reasoning metadata is taken
 * verbatim from the live endpoint — each model's supported effort set and
 * whether thinking can be disabled — and the `free` flag follows the upstream
 * `x0.00` credits marker.
 *
 * Rows without `supportedEfforts` carry only a default effort.
 */
export const FALLBACK_WORKBUDDY_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'high', canDisableThinking: true }, billing: { free: false } },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { free: false, rateUnknown: true } },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.00', free: true } },
  { id: 'hy3-x', name: 'Hy3-X', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.05', free: false } },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.03', free: false } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.06', free: false } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000, supportsImages: false, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x0.71', free: false } },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x1.62', free: false } },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.77', free: false } },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x0.57', free: false } },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x0.52', free: false } },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'medium', canDisableThinking: true }, billing: { credits: 'x0.25', free: false } },
  { id: 'deepseek-v4-pro', name: 'Deepseek-v4-Pro', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.51', free: false } },
]

/**
 * Mutable catalog shared by the endpoint's `/v1/models` and the status CLI.
 *
 * Visibility is separate from content. A signed-out account must expose *no*
 * models rather than a fallback roster: serving the fallback would advertise
 * models that can only fail, which is worse than showing nothing.
 */
export class WorkBuddyCatalog {
  constructor(initial = FALLBACK_WORKBUDDY_MODELS) {
    this.models = initial
    this.visible = true
    /** Provenance of the roster currently held. */
    this.source = 'fallback'
    this.fetchedAtMs = undefined
    this.useMaximumContextWindow = false
  }

  /** Current entries; empty while the catalog has no usable credential. */
  current() {
    if (!this.visible) return []
    return this.models.map(model => {
      const current = modelWithCurrentPromotion(model)
      const maximum = current.supportedContextWindows === undefined
        ? undefined : Math.max(...current.supportedContextWindows)
      return this.useMaximumContextWindow && maximum !== undefined && maximum > current.contextWindow
        ? { ...current, defaultContextWindow: current.defaultContextWindow ?? current.contextWindow, contextWindow: maximum }
        : current
    })
  }

  /** Replace the list with a freshly fetched roster. */
  set(models, { source, fetchedAtMs } = {}) {
    this.models = [...models]
    if (source !== undefined) this.source = source
    this.fetchedAtMs = fetchedAtMs ?? Date.now()
  }

  isVisible() {
    return this.visible
  }

  /** Show or hide the whole catalog. Returns whether the value changed. */
  setVisible(visible) {
    if (this.visible === visible) return false
    this.visible = visible
    return true
  }

  /** Select the largest declared window where the upstream offers a choice. */
  setUseMaximumContextWindow(useMaximum) {
    if (this.useMaximumContextWindow === useMaximum) return false
    this.useMaximumContextWindow = useMaximum
    return true
  }

  /** Models to fall back to when the upstream fetch fails; ignores visibility. */
  fallback() {
    return this.models
  }
}