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
      <pre className={cn("overflow-x-auto p-4 text-sm", language ? "pt-7" : "")}>
        <code data-language={language}>{code}</code>
      </pre>
    </div>
  )
}
