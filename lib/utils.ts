// Dev-only stub so the registry sources typecheck against `@/lib/utils`.
// Consumers get shadcn's real `cn` (clsx + tailwind-merge) from their own project.
export type ClassValue = string | number | null | false | undefined

export function cn(...inputs: ClassValue[]): string {
  return inputs.filter(Boolean).join(" ")
}
