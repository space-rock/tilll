/** Join class names, skipping anything falsy. */
export const cn = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");
