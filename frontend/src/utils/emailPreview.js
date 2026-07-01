/**
 * Lightweight HTML sanitizer for email preview (defense in depth after backend sanitize).
 */
export function sanitizeEmailHtml(html) {
  if (!html) return "";
  let out = html;
  out = out.replace(
    /<\s*(script|iframe|object|embed|form|link|meta)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    "",
  );
  out = out.replace(/<\s*(script|iframe|object|embed|form|link|meta)\b[^>]*\/?>/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, "");
  out = out.replace(/(href|src)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '$1="#"');
  return out;
}

export function resolvePreviewMode(data) {
  if (!data) return "fallback";
  if (data.preview_mode && data.preview_mode !== "fallback") {
    return data.preview_mode;
  }
  if (data.preview_html) return data.preview_images?.length ? "html_images" : "html";
  if (data.preview_images?.length) return "images";
  if (data.preview_plain) return "plain";
  return "fallback";
}
