export const aiConfig = {
  openAiApiKey:
    import.meta.env.VITE_OPENAI_BROWSER_CREDENTIAL ?? '',
  openAiModel: import.meta.env.VITE_OPENAI_MODEL ?? 'gpt-4.1-mini',
}
