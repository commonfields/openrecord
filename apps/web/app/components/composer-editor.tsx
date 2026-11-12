// The composer's text field, on Tiptap: a plain-text document (paragraphs and
// line breaks only, no formatting marks), so the message it sends is the same
// string the old textarea produced. Pasted rich text arrives as clean text
// because the schema has nothing else to hold it. The composer keeps the text
// in its own state; this field mirrors it both ways.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { cn } from "@/lib/utils"

export type ComposerEditorHandle = {
  /** Focuses the field, with the caret at the end when `atEnd`. */
  focus: (atEnd?: boolean) => void
}

type Props = {
  id?: string | undefined
  value: string
  onChange: (text: string) => void
  placeholder: string
  autoFocus?: boolean | undefined
  disabled?: boolean | undefined
  /** Return true when the key was handled (the editor then does nothing). */
  onKeyDown?: (event: KeyboardEvent) => boolean
  /** Return true when the paste was handled (files, long text). */
  onPaste?: (event: ClipboardEvent) => boolean
  ariaExpanded?: boolean | undefined
  ariaAutocomplete?: "list" | undefined
  className?: string | undefined
}

/** Text as paragraphs, one per line. */
const toDoc = (text: string) => ({
  type: "doc",
  content: text.split("\n").map(line => ({ type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {}) })),
})

export const ComposerEditor = forwardRef<ComposerEditorHandle, Props>(function ComposerEditor(
  { id, value, onChange, placeholder, autoFocus, disabled, onKeyDown, onPaste, ariaExpanded, ariaAutocomplete, className },
  ref,
) {
  // The latest handlers, read by the editor's callbacks without rebuilding it.
  const handlers = useRef({ onChange, onKeyDown, onPaste })
  handlers.current = { onChange, onKeyDown, onPaste }
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false, heading: false, horizontalRule: false,
        italic: false, link: false, listItem: false, listKeymap: false, orderedList: false, strike: false, underline: false,
      }),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
    ],
    content: toDoc(value),
    autofocus: autoFocus ? "end" : false,
    editable: !disabled,
    editorProps: {
      attributes: {
        id: id ?? "agent-input",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Message the agent",
        class: cn("block max-h-48 min-h-6 min-w-0 overflow-y-auto py-1 text-base leading-6 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className),
      },
      handleKeyDown: (_view, event) => handlers.current.onKeyDown?.(event) ?? false,
      handlePaste: (_view, event) => handlers.current.onPaste?.(event) ?? false,
    },
    onUpdate: ({ editor }) => handlers.current.onChange(editor.getText({ blockSeparator: "\n" })),
  })
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder

  // The composer changed the text (sent, a command, a playbook, dictation): mirror it.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (editor.getText({ blockSeparator: "\n" }) !== value) editor.commands.setContent(toDoc(value), { emitUpdate: false })
  }, [editor, value])
  useEffect(() => { editor?.setEditable(!disabled) }, [editor, disabled])
  // The placeholder is read on each render of the empty line; nudge it when it changes.
  useEffect(() => { if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr) }, [editor, placeholder])
  useEffect(() => {
    const dom = editor?.view.dom
    if (!dom) return
    if (ariaExpanded === undefined) dom.removeAttribute("aria-expanded"); else dom.setAttribute("aria-expanded", String(ariaExpanded))
    if (ariaAutocomplete) dom.setAttribute("aria-autocomplete", ariaAutocomplete); else dom.removeAttribute("aria-autocomplete")
  }, [editor, ariaExpanded, ariaAutocomplete])

  useImperativeHandle(ref, () => ({
    focus: (atEnd = false) => { editor?.commands.focus(atEnd ? "end" : undefined) },
  }), [editor])

  return <EditorContent editor={editor} className="composer-editor min-w-0 flex-1" />
})
