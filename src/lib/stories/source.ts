/** Source delimiters are removed before the user confirms the outbound text. */
export const neutralizeStorySource = (text: string) => text.replace(/<\/?\s*story_source\s*>/gi, "[tag removed]");
