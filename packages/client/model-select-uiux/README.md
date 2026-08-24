# model-select-uiux — Model Select UI/UX Improvement

A drop-in **client plugin** for the DeepSeek Harness **web** Composer that
improves the model select surfaces:

1. **Provider-first picker** — the model menu opens on the **provider list**;
   picking a provider reveals **that provider's models** (previously one long,
   provider-grouped list).
2. **Compact reasoning-effort popover** — effort is NOT inside the modal at
   all. A small pill beside the model trigger (``High ▾``) shows the current
   level; clicking it opens a temporary popover with the discrete levels
   (optional descriptions, trailing check + subtle highlight on the selected
   one). It closes on selection, outside click, or Escape — the selector is
   never permanently visible. Keyboard: arrows move, Enter/Space select.

It is a pure **override**: it reuses the exact same per-session model directory
and `session.models` / `session.selectModel` calls the shipped picker uses, so
the seat, the `/model` popup, and the composer's block state all stay
consistent. It only replaces the *rendered menu* (the `conversation.input.model`
seat), which is a `single`-occupant slot — a plugin registration at a lower
priority shadows the shipped UI.

## Why this package exists

The behavior lives in this **separate plugin** instead of the upstream
`ui-model-selection` package, so a `git pull` on the harness never touches it,
and anyone can install it in their own checkout without changing upstream
source.

## Requirements

- The DeepSeek Harness **web** app (the Composer surface) — this plugin registers a
  seat in `conversation.input.model`, which only exists there.
- The **upstream `@deepseek-ai/dsh-client-ui-model-selection` plugin must remain
  mounted** in the web composition. This plugin reads its `modelDirectories`
  service for data. If that plugin is ever removed, this one degrades to a no-op
  and the default seat stays as-is.
- `node` ≥ 22 and `pnpm` (the harness toolchain).

## Quick install (1 command)

Depois de copiar a pasta, corre o instalador — ele trata de tudo (tsconfig,
composição, dependência, `pnpm install` e build). É idempotente.

```bash
# Se já copiaste para dentro do checkout:
node packages/client/model-select-uiux/install.mjs

# Ou a partir de uma pasta descarregada, apontando para o harness:
node /path/to/model-select-uiux/install.mjs /path/to/deepseek-harness
```

Depois reinicia `dsh web` e faz hard refresh.

## Install — passos manuais (alternativa)

The package is built with the same toolchain as the shipped client plugins, so it
has to live in the workspace while building. Copy it in, wire it into the client
project graph, and build — then it is a normal workspace package your harness
serves.

1. **Copy** this directory into the checkout:

   ```bash
   cp -r model-select-uiux /path/to/deepseek-harness/packages/client/
   ```

2. **Add its tsconfig** at
   `packages/client/model-select-uiux/tsconfig.json`:

   ```json
   {
     "extends": "../../../tsconfig.base.client.json",
     "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
     "include": ["src"],
     "references": [
       { "path": "../../../vendor/cordis" },
       { "path": "../locale" },
       { "path": "../runtime" },
       { "path": "../ui-conversation" },
       { "path": "../ui-primitives" },
       { "path": "../ui-slots" }
     ]
   }
   ```

3. **Register the project** in `tsconfig.client.json` (next to the other client
   packages):

   ```json
   { "path": "./packages/client/model-select-uiux" },
   ```

4. **Link and build**:

   ```bash
   pnpm install
   pnpm run build   # runs tsc -b + tsdown bundles + the web shell
   ```

   (Incremental: `pnpm exec tsc -b tsconfig.client.json` then
   `pnpm --filter model-select-uiux run bundle`.)

5. **Mount the plugin** in the web composition (`packages/bundle/web-app/cordis.patch.yml`,
   in the client-plugins section, alongside `ui-model-selection`):

   ```yaml
   - id: model-select-uiux
     name: 'model-select-uiux'
   ```

6. Restart `dsh web` (or refresh if the dev loop is running). The composer model
   seat now opens provider-first with the effort pill/popover.

## Uninstall

Remove the composition row, the `tsconfig.client.json` reference, the
`packages/client/model-select-uiux` directory, and run `pnpm install` to prune
the workspace link. The repo returns to stock behavior.

## Behavior details

- Opening the seat shows the **provider list** directly (no Model/Effort landing
  pane).
- Picking a provider shows **that provider's models**, with a back row
  (`← Provider name`) on top.
- **Effort is out of the modal**: the compact pill beside the trigger (while
  the current model has ≥ 2 reasoning levels) opens a temporary popover —
  discrete options with check/subtle highlight and optional descriptions;
  picks commit the effort for the current provider/model and close the popover
  immediately. Animations: 150ms fade/slide/scale-in on open, 120ms out on
  close; the popover flips above when there is no room below and stays
  right-aligned to the trigger.
- `Escape` walks back one level at a time (models → providers → close); the
  in-menu error strip and the rejected-selection toast behave as shipped.
- `/model` popup and the shared directory are untouched.

## Layout

```
model-select-uiux/
  package.json            # plugin manifest (dsh.client platform "web")
  tsdown.config.ts        # clientBundle preset wiring (reference ../tsdown.client.ts)
  src/
    index.ts              # node half (empty apply; presence marker for host loader)
    css-modules.d.ts
    client/
      index.ts            # browser half: registers the providerModel dicts + seat override
      slots.ts            # local structural types for the shared directory service
      ModelSelect.tsx     # provider-first seat UI + effort pill/popover
      ModelSelect.module.css
      locales.ts          # zh/en dictionaries (own "providerModel" namespace)
```

## License

MIT.