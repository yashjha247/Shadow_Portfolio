1. The Core Problem (Why this exists)
Developers write hundreds of lines of code and solve complex bugs every week. But updating a resume or portfolio is tedious, so we never do it. This leaves a massive gap between our actual competence and what we can prove to a recruiter.

2. The Solution (The Big Idea)
The Shadow Portfolio is an automated, event-driven backend pipeline. It quietly watches your GitHub in the background. It filters out the noise (README edits, dependency bumps), looks at your real code, and uses an AI to group your commits into Learning Milestones (e.g., "Implemented JWT Authentication").

You aren't just building a portfolio app; you are building an automated engineering progress tracker.

3. The Architecture (The 5-Stage Pipeline)
You are building a system that is decoupled, asynchronous, and cost-effective. Here is how data flows through the system you are building:

Stage 1: The Trigger — You push code to GitHub. GitHub sends a webhook (a JSON payload) across the internet.
Stage 2: The Gateway (✅ Phase 1 Complete) — Your Express server catches it, verifies the security signature (HMAC), drops the raw JSON into a Supabase Outbox table (raw_events), and instantly replies 200 OK so GitHub doesn't time out.
Stage 3: The Engine (✅ Phase 2 Complete) — A Background Worker wakes up every 10 seconds, reads the Outbox, and fetches the actual code diff from GitHub. A deterministic Decision Engine scores the code. If it's junk, it's marked ignored. If it's real code, it's marked processed. The AI never sees junk code, saving you money.
Stage 4: The Intelligence (🚧 Phase 3 - Up Next) — When a commit is processed, the worker sends the diff to an AI (Gemini/Llama). The AI looks at the code and the 5 most recent active milestones. It decides: "Does this belong to an existing milestone, or is this a new feature?" It returns a strict JSON contract (merge or create).
Stage 5: The Ledger (🚧 Phase 3 & 4) — The AI's decision is saved into relational Supabase tables (learning_milestones, engineering_commits, extracted_skills). Eventually, a React frontend will read these tables and display a beautiful timeline of your engineering journey for recruiters.
4. The Real Purpose (The Interview Pitch)
If a recruiter asks you what this project is, you don't say: "It's an app that uses AI to read my GitHub."

You say: "It's an event-driven backend pipeline. I implemented the Outbox pattern to decouple webhook ingestion from AI processing, ensuring GitHub never times out. I built a deterministic Decision Engine to filter noise before making expensive API calls. And I used context-windowed prompting to semantically group commits into milestones without needing a vector database."

That is why we are building this. To prove you understand system architecture, data flow, and cost control.