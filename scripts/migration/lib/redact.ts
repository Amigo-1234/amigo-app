/** Mask anything that looks like an email: "sam@example.com" → "s***@example.com". */
export function redact(text: string): string {
  return text.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***@$2");
}
