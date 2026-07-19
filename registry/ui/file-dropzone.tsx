"use client"

import * as React from "react"
import { Upload } from "lucide-react"

import { cn } from "@/lib/utils"

/** Why a candidate file was skipped, so you can surface it to the user. */
export interface FileRejection {
  file: File
  reason: "type" | "size" | "too-many"
}

interface FileDropzoneProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "onChange" | "onDrop" | "defaultValue"
  > {
  /** Controlled list of accepted files. Pair with `onChange` to own the state. */
  value?: File[]
  /** Initial files when uncontrolled. */
  defaultValue?: File[]
  /** Called with the next list whenever files are added or one is cleared. */
  onChange?: (files: File[]) => void
  /** Called with the files that were skipped and why (bad type, too big, over the cap). */
  onReject?: (rejections: FileRejection[]) => void
  /** Same syntax as an <input> accept attr, e.g. "image/*,.pdf". Also filters drops. */
  accept?: string
  /** Allow selecting more than one file (default false). */
  multiple?: boolean
  /** Reject files larger than this many bytes. */
  maxSize?: number
  /** Cap the total number of files kept. */
  maxFiles?: number
  disabled?: boolean
}

function extOf(name: string) {
  const dot = name.lastIndexOf(".")
  return dot === -1 ? "" : name.slice(dot).toLowerCase()
}

/** Match a file against an `accept` string (mime, mime wildcard, or .ext). */
function matchesAccept(file: File, accept?: string) {
  if (!accept) return true
  const type = file.type.toLowerCase()
  const ext = extOf(file.name)
  return accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => {
      if (token.startsWith(".")) return ext === token
      if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1))
      return type === token
    })
}

export const FileDropzone = React.forwardRef<HTMLInputElement, FileDropzoneProps>(
  function FileDropzone(
    {
      className,
      children,
      value,
      defaultValue,
      onChange,
      onReject,
      accept,
      multiple = false,
      maxSize,
      maxFiles,
      disabled,
      ...props
    },
    forwardedRef
  ) {
    const inputRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(
      forwardedRef,
      () => inputRef.current as HTMLInputElement
    )

    const isControlled = value !== undefined
    const [internal, setInternal] = React.useState<File[]>(
      () => (isControlled ? value : defaultValue) ?? []
    )
    const files = isControlled ? (value as File[]) : internal

    const [dragging, setDragging] = React.useState(false)
    // Visually-hidden message so screen readers hear each add/reject.
    const [announce, setAnnounce] = React.useState("")
    // A drop can fire nested dragleave/dragenter; count depth to avoid flicker.
    const dragDepth = React.useRef(0)

    function commit(next: File[], message: string) {
      if (!isControlled) setInternal(next)
      setAnnounce(message)
      onChange?.(next)
    }

    function ingest(incoming: FileList | File[]) {
      if (disabled) return
      const candidates = Array.from(incoming)
      const passed: File[] = []
      const rejected: FileRejection[] = []

      for (const file of candidates) {
        if (!matchesAccept(file, accept)) {
          rejected.push({ file, reason: "type" })
        } else if (maxSize !== undefined && file.size > maxSize) {
          rejected.push({ file, reason: "size" })
        } else {
          passed.push(file)
        }
      }

      let next: File[]
      if (multiple) {
        next = [...files, ...passed]
        if (maxFiles !== undefined && next.length > maxFiles) {
          for (const file of next.slice(maxFiles)) {
            rejected.push({ file, reason: "too-many" })
          }
          next = next.slice(0, maxFiles)
        }
      } else {
        // A single-file dropzone keeps only the last valid file; the earlier ones
        // are over the cap, so report them through onReject instead of dropping
        // them silently.
        next = passed.slice(-1)
        for (const file of passed.slice(0, -1)) {
          rejected.push({ file, reason: "too-many" })
        }
      }

      if (rejected.length) onReject?.(rejected)
      if (passed.length || !rejected.length) {
        const added = next.length - files.length
        commit(
          next,
          rejected.length
            ? `Added ${Math.max(added, 0)} file${added === 1 ? "" : "s"}, ${rejected.length} skipped`
            : `Added ${passed.length} file${passed.length === 1 ? "" : "s"}`
        )
      } else {
        setAnnounce(`${rejected.length} file${rejected.length === 1 ? "" : "s"} skipped`)
      }
    }

    function open() {
      if (!disabled) inputRef.current?.click()
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        open()
      }
    }

    function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
      e.preventDefault()
      if (disabled) return
      dragDepth.current += 1
      setDragging(true)
    }

    function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
      e.preventDefault()
      if (disabled) return
      dragDepth.current -= 1
      if (dragDepth.current <= 0) {
        dragDepth.current = 0
        setDragging(false)
      }
    }

    function handleDrop(e: React.DragEvent<HTMLDivElement>) {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (disabled) return
      if (e.dataTransfer?.files?.length) ingest(e.dataTransfer.files)
    }

    return (
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        data-dragging={dragging || undefined}
        onClick={open}
        onKeyDown={handleKeyDown}
        onDragEnter={handleDragEnter}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex min-h-32 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-input bg-transparent p-6 text-center text-sm text-muted-foreground transition-colors hover:border-ring/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[dragging]:border-ring data-[dragging]:bg-accent/50",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
        {...props}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => {
            if (e.target.files?.length) ingest(e.target.files)
            // Reset so selecting the same file again re-fires onChange.
            e.target.value = ""
          }}
          tabIndex={-1}
        />
        {children ?? (
          <>
            <Upload className="h-6 w-6" aria-hidden="true" />
            <div>
              <span className="font-medium text-foreground">
                Click to upload
              </span>{" "}
              or drag and drop
            </div>
            {accept ? <div className="text-xs">{accept}</div> : null}
          </>
        )}
        <span aria-live="polite" className="sr-only">
          {announce}
        </span>
      </div>
    )
  }
)
