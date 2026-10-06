import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 对调用方仍是受控用法（value + onChange），内部渲染为非受控 textarea，只在外部值与 DOM 不一致时
 * 直接写 node.value。
 *
 * 原因：React 每次提交 textarea 的属性更新时都会写 defaultValue（受控时写成当前值，非受控时写成
 * defaultValue 属性），也就是改写 textarea 的子文本节点。受控用法因此不向 React 传 value/defaultValue，
 * 初始值和后续同步都由下面的 layout effect 直接写 node.value。
 * 只要样式表里存在任意 :has() 规则，Chromium 就会因此重算整页样式；长会话页面有数万个元素，
 * 每次按键（含输入法组字）70ms 以上（见 docs/long-session-input-lag-fix.md）。直接写 value 属性不改子节点。
 *
 * 与 React 受控语义保持一致：
 * - 外部改值（清空、回填、调用方对输入做过滤）后，渲染时把 DOM 同步为新值；
 * - 调用方在 onChange 里没有同步更新 value（拒绝输入）时，事件结束后把 DOM 恢复为当前 value，
 *   与 React 对受控组件的事件后恢复一致；
 * - 值相同不写 DOM，因此不打断输入法组字，也不移动光标。
 * 非受控用法（defaultValue）同理：React 会在每次属性更新时重写 defaultValue，所以只在挂载时把
 * defaultValue 写进 node.value，不交给 React。唯一差别是表单 reset 会清空而不是回到 defaultValue
 * （项目内没有对 textarea 使用表单 reset）。
 */
/**
 * 挂载时写入初始内容。原生受控 textarea 在 autoFocus 聚焦前就已有内容，光标停在开头；
 * 这里内容是在聚焦之后写入的，写 value 会把光标移到末尾，所以对已聚焦的节点把光标放回开头，保持原行为。
 */
function writeInitialValue(node: HTMLTextAreaElement, text: string) {
  node.value = text
  if (node.ownerDocument.activeElement === node) node.setSelectionRange(0, 0)
}

function Textarea({
  className,
  value,
  defaultValue,
  onChange,
  ref,
  ...props
}: React.ComponentProps<"textarea">) {
  const nodeRef = React.useRef<HTMLTextAreaElement | null>(null)
  const controlledText = value === undefined ? undefined : value === null ? "" : String(value)
  const latestTextRef = React.useRef(controlledText)
  latestTextRef.current = controlledText
  const initialDefaultRef = React.useRef(defaultValue)
  const hasSyncedRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const node = nodeRef.current
    const initial = initialDefaultRef.current
    if (node && latestTextRef.current === undefined && initial != null) writeInitialValue(node, String(initial))
  }, [])

  React.useLayoutEffect(() => {
    const node = nodeRef.current
    const text = latestTextRef.current
    if (!node || text === undefined) return
    const first = !hasSyncedRef.current
    hasSyncedRef.current = true
    if (node.value === text) return
    if (first) writeInitialValue(node, text)
    else node.value = text
  })

  const setRefs = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      nodeRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) (ref as React.RefObject<HTMLTextAreaElement | null>).current = node
    },
    [ref],
  )

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(event)
    if (latestTextRef.current === undefined) return
    const node = event.currentTarget
    // React 在事件结束时同步刷新离散事件触发的更新；微任务里 latestTextRef 已是本次渲染后的值。
    queueMicrotask(() => {
      const text = latestTextRef.current
      if (text !== undefined && node.isConnected && node.value !== text) node.value = text
    })
  }

  return (
    <textarea
      ref={setRefs}
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
        className
      )}
      // value/defaultValue 都不交给 React：它只会把 defaultValue 写成空串，空 textarea 没有子文本可改写。
      onChange={handleChange}
      {...props}
    />
  )
}

export { Textarea }
