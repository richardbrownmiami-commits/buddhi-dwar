# Saraha APK — Master Plan

## CRITICAL RULES
- Plan never changes mid-session without user approval. If I discover something during coding that shifts direction, I stop and ask.
- If user changes direction mid-session, I update this file first before continuing.
- Max 50 lines per edit. Every edit must be deployable independently.

## Current Phase: 0 — Brain capability endpoint

### Progress
- [ ] Phase 0: Brain capability endpoint (add GET /brain/capabilities to Brain)
- [ ] Phase 1a: SarahaApi class (rename BrainApi, add LLM call, task/heal/capabilities methods)
- [ ] Phase 1b: ChatActivity rework (system prompt, LLM via gateway, greeting flow)
- [ ] Phase 1c: MainActivity dynamic cards (read /brain/capabilities, render UI)
- [ ] Phase 1d: SettingsActivity — add LLM API key field
- [ ] Phase 1e: MonitorActivity — rename labels, no logic changes
- [ ] Phase 1f: New WebView container activity (for Brain-served HTML)
- [ ] Phase 1g: SyncWorker — replace api.think() with api.callLLM()
- [ ] Phase 2: Brain feature migration (task system, heal, cron control — no APK builds)
- [ ] Phase 3: Remove /think from Brain
- [ ] Phase 4: Monitor shifts to watch Saraha, not Brain

### Decisions locked
- Exactly ONE APK build (Phase 1). Everything else via Brain updates
- Chat via Budhhi Dwar API key, not Brain's /think
- System prompt: never mentions "brain" as separate — "my core", "my system"
- APK DB: Room (phone). Brain DB: D1. Separate concerns.
- Monitor stays watching both until Phase 4
- Avatar: Brain's /avatar endpoint for now, move to APK in Phase 3

### What I read at session start
1. PLAN.md — where we are, what's next
2. AGENTS.md — session history, known issues, credentials
3. CHECKPOINTS.md — milestone completion status
