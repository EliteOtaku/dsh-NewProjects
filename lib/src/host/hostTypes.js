/**
 * Minimal structural views of the Host services this plugin uses.
 *
 * These are intentionally *not* imports from `@deepseek-ai/dsh-*`: an out-of-tree
 * plugin cannot resolve those packages (they live inside the Host's own module tree),
 * so importing them would make the plugin fail to load. Declaring the exact shapes we
 * depend on keeps the surface small, auditable, and loadable.
 *
 * Each declaration below mirrors a verified Host contract; the comment above it says
 * which service or event it comes from.
 */
export {};
