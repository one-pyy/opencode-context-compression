## messages-transform-role-type-surface-vs-projected-artifacts
Date: 2026-04-03

### Pattern / Gotcha
The installed `@opencode-ai/plugin` TypeScript surface for `experimental.chat.messages.transform` narrows `output.messages[*].info.role` to `"user" | "assistant"`, even though projection work may need to materialize synthetic protected artifacts that conceptually behave like system-level prompt additions.

### Detail
While implementing the deterministic projection pipeline in `/root/_/opencode/opencode-context-compression`, the local runtime seam observations and the architecture notes both supported derived reminder artifacts that are prompt-visible but non-durable. A natural implementation shape was to clone an anchor envelope and retag the reminder artifact as `role = "system"`.

However, the actual installed package type at:

- `node_modules/@opencode-ai/plugin/dist/index.d.ts`

defines `experimental.chat.messages.transform` output as `{ info: Message; parts: Part[] }[]`, and the imported SDK `Message` type in this version narrows `role` to `"user" | "assistant"` for that hook surface. That produced a strict TypeScript error even though the broader architectural design talks about reminder artifacts in system-like terms.

For this repo/version combination, the practical safe path was:

- keep the reminder **derived and non-durable**
- project it with visible state `protected`
- materialize it using an assistant-shaped envelope at the TypeScript layer
- encode the protection semantics in the projection renderer and visible prefix, not in `info.role = "system"`

This keeps the transform implementation type-correct without changing canonical history or inventing a second prompt-authoring seam.

The important lesson is that future projection work here should distinguish between:

- the **architectural meaning** of a protected derived artifact
- the **actual local hook type envelope** accepted by the installed plugin SDK

Do not assume that a conceptually system-like reminder can be emitted as a literal system-role message in this repo unless the plugin/SDK type surface changes first.

### Applies To
- `src/projection/projection-builder.ts`
- `src/projection/messages-transform.ts`
- future derived-artifact work inside `experimental.chat.messages.transform`
