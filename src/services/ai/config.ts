export const aiConfig = {
  provider: import.meta.env.VITE_AI_PROVIDER ?? 'gemini',
  geminiApiKey: import.meta.env.VITE_GEMINI_API_KEY ?? '',
  geminiModel: import.meta.env.VITE_GEMINI_MODEL ?? 'gemini-2.5-flash',
}
