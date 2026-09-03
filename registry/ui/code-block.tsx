"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { CopyButton } from "@/registry/ui/copy-button"

interface CodeBlockProps extends React.ComponentPropsWithoutRef<"div"> {
  code: string
  /** Shown as a small label and set on the <code> element's data-language. */
  language?: string
}

export function CodeBlock({
  code,
  language,
  className,
  ...props
}: CodeBlockProps) {
  return (
    <div
      className={cn("group relative rounded-lg border bg-muted/50", className)}
      {...props}
    >
      <div className="absolute right-2 top-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <CopyButton value={code} />
      </div>
      {language ? (
        <span className="absolute left-3 top-2.5 font-mono text-[10px] uppercase text-muted-foreground">
          {language}
        </span>
      ) : null}
      {/*
        Focusable so a keyboard user can scroll a long line (WCAG 2.1.1). The panel holds nothing
        focusable of its own — the copy button is a sibling, outside it — so without a tab stop the
        part of a snippet that is off to the right is reachable by mouse and by nothing else.
      */}
      <pre
        tabIndex={0}
        className={cn(
          "overflow-x-auto p-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          language ? "pt-7" : ""
        )}
      >
        <code data-language={language}>{code}</code>
      </pre>
    </div>
  )
}
