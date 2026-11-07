/** Source delimiters must already be neutralized in the confirmed preview. */
export const neutralizeCareerSource = (text: string) => text.replace(/<\/?\s*career_source\b[^>]*>/gi, "[tag removed]");
