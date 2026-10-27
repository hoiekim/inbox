import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { Editor, type EditorOptions } from "./editor";

/**
 * Creates an editor that lives as long as the calling component. The editor
 * exists from the first render, so effects can set content right away.
 */
export const useRichTextEditor = (options: EditorOptions): Editor => {
  const ref = useRef<Editor | null>(null);
  if (!ref.current) ref.current = new Editor(options);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    // StrictMode unmounts and remounts once in development; rebuild the
    // editor the first cleanup destroyed, keeping its content.
    if (ref.current!.isDestroyed) {
      ref.current = new Editor({ ...options, content: ref.current!.getHTML() });
      rerender();
    }
    const editor = ref.current!;
    return () => editor.destroy();
  }, []);

  return ref.current;
};

/** Mounts an editor's element. */
export const RichTextEditor = ({ editor }: { editor: Editor }) => {
  const container = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = container.current;
    if (!host) return;
    host.appendChild(editor.dom);
    return () => {
      editor.dom.remove();
    };
  }, [editor]);

  return <div ref={container} />;
};
