/**
 * Project steps that use the editor chrome and `html[data-surface="editor"]`
 * (ADR 0014). Sync and Preview move here in a follow-up. Not a client module:
 * the root layout also reads it to set the surface before first paint.
 */
export const EDITOR_STEPS = ["customize"] as const;

/** Is this pathname an editor step (`/projects/<id>/<step>`)? */
export function isEditorPath(pathname: string): boolean {
  return EDITOR_STEPS.some((s) => pathname.endsWith("/" + s));
}

/**
 * Inline script for <head>: sets the editor surface while the HTML is parsed,
 * so a full page load of /customize never paints the Direction A tokens
 * first. Client-side navigation is handled by `WorkflowFrame`.
 */
export const EDITOR_SURFACE_SCRIPT = `(function(){try{var p=location.pathname.replace(/\\/+$/,"");if(${JSON.stringify(EDITOR_STEPS)}.some(function(s){return /^\\/projects\\/[^/]+$/.test(p.slice(0,-(s.length+1)))&&p.slice(-(s.length+1))==="/"+s}))document.documentElement.dataset.surface="editor"}catch(e){}})();`;
