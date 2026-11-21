import { Command, Plugin } from "@opencode/plugin/gui"
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js"

const SYSTEM = [
  "You predict the user's next message in a coding session.",
  "Reply with exactly one short first-person message the user would plausibly send next.",
  "No quotes, no preface, no explanation, no markdown.",
  "Reply NONE when the conversation gives nothing to predict.",
].join(" ")

const EDITOR_SELECTORS = [
  '[data-component="composer-editor"]',
  '[role="textbox"][aria-multiline="true"]',
  '[contenteditable="true"]',
]
const MAX_CHARS = 120

function messageText(message: any) {
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim()
}

function findEditor(): HTMLElement | null {
  for (const selector of EDITOR_SELECTORS) {
    const node = document.querySelector<HTMLElement>(selector)
    if (node) return node
  }
  return null
}

function placeholderFor(editor: HTMLElement): HTMLElement | null {
  const sibling = editor.nextElementSibling
  if (sibling instanceof HTMLElement) return sibling
  const parent = editor.parentElement
  return parent ? parent.querySelector<HTMLElement>("div.pointer-events-none") : null
}

export default Plugin.define({
  i18n: { en: { title: "Ghost" } },
  setup(ctx) {
    const [suggestion, setSuggestion] = createSignal("")
    const [busy, setBusy] = createSignal(false)
    let timer: ReturnType<typeof setTimeout> | undefined
    let sessionID = ""
    let lastStatus = "idle"
    let primed = false

    const debug = Boolean((ctx.options as any)?.debug ?? false)
    const note = (title: string, variant: "default" | "success" | "error" = "default", description?: string) => {
      if (!debug) return
      try {
        ctx.toast.show({ title, description, variant, duration: 4000 })
      } catch {
        // Toasts unavailable before the window mounts.
      }
    }

    const current = () => ctx.sessions.current()
    const composer = () => ctx.screen.current()?.composer
    const maxChars = Number((ctx.options as any)?.maxChars ?? MAX_CHARS) || MAX_CHARS
    const configuredModel = String((ctx.options as any)?.model ?? "")

    const modelFor = (target: any) => {
      const [providerID, ...rest] = configuredModel.split("/")
      if (providerID && rest.length) return { providerID, id: rest.join("/") }
      const model = target.model()
      return model ? { id: model.modelID, providerID: model.providerID } : undefined
    }

    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    }

    // The host renders its placeholder in a sibling overlay div. Own that element's
    // text while a suggestion is showing, and restore it exactly afterwards.
    const paint = () => {
      const editor = findEditor()
      if (!editor) return false
      const holder = placeholderFor(editor)
      if (!holder) return false
      const value = suggestion()
      const draft = composer()?.text() ?? ""
      if (value && !draft.trim()) {
        if (holder.textContent !== value) {
          if (holder.dataset.ghostBase === undefined) holder.dataset.ghostBase = holder.textContent ?? ""
          holder.dataset.ghostText = value
          holder.textContent = value
        }
        holder.style.color = "var(--v2-text-text-muted, #8a8a8a)"
      } else if (holder.dataset.ghostText !== undefined) {
        holder.textContent = holder.dataset.ghostBase ?? ""
        delete holder.dataset.ghostText
        delete holder.dataset.ghostBase
        holder.style.removeProperty("color")
      }
      return true
    }

    const insert = () => {
      const value = suggestion()
      const target = composer()
      if (!value || !target) return
      target.insert(value)
      setSuggestion("")
      note("Ghost: inserted", "success", value)
    }

    const generate = async () => {
      const session = current()
      const target = composer()
      if (!session || !target) {
        console.warn("[ghost] skip: no session or composer")
        return
      }
      if (busy()) return
      if (target.text().trim()) {
        console.warn("[ghost] skip: draft present", target.text().length)
        return
      }
      setBusy(true)
      note("Ghost: generating…", "default")
      console.warn("[ghost] generating", configuredModel || "composer-model")
      try {
        const list = await ctx.client.message.list({
          sessionID: session.id,
          limit: 12,
          order: "desc",
        })
        const messages = Array.isArray(list?.data) ? [...list.data].reverse() : []
        const transcript = messages
          .map((message: any) => {
            const text = messageText(message)
            if (!text) return ""
            const who = message.type === "user" ? "User" : message.type === "assistant" ? "Assistant" : ""
            return who ? `${who}: ${text}` : ""
          })
          .filter(Boolean)
          .join("\n\n")
          .slice(-6000)
        if (!transcript) {
          note("Ghost: no conversation yet")
          return
        }
        const output = await ctx.client.generate.text({
          prompt: `${SYSTEM}\n\nConversation:\n${transcript}\n\nNext user message:`,
          model: modelFor(target),
        })
        const text = String(output?.text ?? "")
          .trim()
          .replace(/^["'`]+|["'`]+$/g, "")
          .slice(0, maxChars)
        if (!text || /^none\b/i.test(text)) {
          note("Ghost: no suggestion", "default", text ? "Model replied NONE" : "Model replied empty")
          return
        }
        setSuggestion(text)
        console.warn("[ghost] suggestion ready", text.length, text.slice(0, 80))
        note("Ghost: suggestion ready", "success", text)
      } catch (error) {
        console.error("[ghost] generation failed", error)
        note("Ghost: generation failed", "error", String((error as any)?.message ?? error).slice(0, 300))
      } finally {
        setBusy(false)
      }
    }

    const dispose = createRoot((stop) => {
      // Paint ghost text whenever the draft, the suggestion or the editor changes.
      createEffect(() => {
        composer()?.text()
        suggestion()
        ctx.screen.current()
        paint()
      })

      // The editor can mount later than the effect: repaint on DOM changes.
      const observer = new MutationObserver(() => {
        paint()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })

      // Accept with Tab or Right arrow while the ghost is showing.
      const onKeyDown = (event: KeyboardEvent) => {
        if (!suggestion()) return
        if (event.key !== "Tab" && event.key !== "ArrowRight") return
        const node = document.activeElement as HTMLElement | null
        if (!node || !node.isContentEditable) return
        if ((composer()?.text() ?? "").trim()) return
        event.preventDefault()
        event.stopPropagation()
        insert()
      }
      window.addEventListener("keydown", onKeyDown, true)

      // After a turn finishes in an idle, empty composer, ask for the next message.
      createEffect(() => {
        try {
          const session = current()
          const target = composer()
          if (!session) return
          const status = session.server.data.session.status(session.id)
          if (session.id !== sessionID) {
            sessionID = session.id
            lastStatus = status
            primed = false
            setSuggestion("")
            clearTimer()
          }
          if (lastStatus === "running" && status === "idle") {
            clearTimer()
            timer = setTimeout(() => void generate(), 700)
          }
          // First look at a session: offer a suggestion without waiting for a turn.
          if (!primed && target && !suggestion() && !target.text().trim()) {
            primed = true
            clearTimer()
            timer = setTimeout(() => void generate(), 1200)
          }
          lastStatus = status
        } catch (error) {
          console.warn("[ghost] status unavailable", error)
        }
      })

      onCleanup(() => {
        observer.disconnect()
        window.removeEventListener("keydown", onKeyDown, true)
        clearTimer()
        const editor = findEditor()
        const holder = editor ? placeholderFor(editor) : null
        if (holder?.dataset.ghostText !== undefined) {
          holder.textContent = holder.dataset.ghostBase ?? ""
          delete holder.dataset.ghostText
          delete holder.dataset.ghostBase
          holder.style.removeProperty("color")
        }
      })
      return stop
    })

    ctx.add(Command, (): any => ({
      id: "suggest",
      title: "Ghost: suggest next prompt",
      description: "Generate a next-prompt suggestion and insert it",
      keywords: "ghost suggestion autocomplete next prompt",
      group: "Ghost",
      section: "prompt",
      bind: "mod+shift+g",
      slash: { name: "ghost" },
      enabled: !!current(),
      run: () => {
        if (suggestion()) insert()
        else void generate()
      },
    }))

    note("Ghost loaded", "default")
    console.warn("[ghost] setup complete", { model: configuredModel || "(composer model)" })
    return () => {
      dispose()
    }
  },
})
