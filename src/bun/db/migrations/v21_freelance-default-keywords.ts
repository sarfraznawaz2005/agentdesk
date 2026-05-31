export const name = "freelance-default-keywords";

export const DEFAULT_KEYWORDS = [
  ...new Set([
    ".Net", "Agent", "Android", "Angular", "API", "Article", "Automation",
    "Blog", "C#", "Chatbot", "CMS", "Code", "Commerce", "Content", "CSS",
    "Data", "Debug", "Design", "Dev", "Dotnet", "English", "Entry", "Excel",
    "Figma", "Flutter", "Go", "HTML", "JavaScript", "Kotlin", "Laravel", "LLM",
    "Mobile", "PHP", "Podcast", "Proofreading", "Python", "RAG", "React",
    "Responsive", "Resume", "Script", "Scrap", "Shopify", "SQL", "Subtitle",
    "Swift", "Testing", "Transcript", "Translation", "Translator", "TypeScript",
    "Video", "Voiceover", "Vue", "Web", "Word", "Writing",
  ]),
];

// Superseded — keyword seeding moved to a UI button in the freelance settings tab.
export function run(): void {}
