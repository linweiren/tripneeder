export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const tsSpecifier = `${specifier.slice(0, -3)}.ts`

    try {
      return await nextResolve(tsSpecifier, context)
    } catch {
      // Fall through to Node's normal resolver for real JavaScript files.
    }
  }

  return nextResolve(specifier, context)
}
