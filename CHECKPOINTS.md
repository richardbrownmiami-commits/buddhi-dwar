# Saraha APK — Checkpoints

## How this works
Every session ends with completed checkpoints ticked and next steps written.
Next session starts by reading this file to know exact status.

## Phase 0: Brain capability endpoint
[X] GET /brain/capabilities added to Brain
[X] Returns features, status, endpoint list
[X] APK can discover Brain features dynamically (verified live)

## Phase 1: Base APK shell (one and only APK build)
[X] 1a: BrainApi → SarahaApi (rename, LLM call, new methods added)
[ ] 1b: ChatActivity — system prompt, gateway LLM, greeting flow
[ ] 1c: MainActivity — dynamic cards from /brain/capabilities
[X] 1d: SettingsActivity — LLM API key field added
[X] 1e: MonitorActivity — label rename ("Brain Activity Log" → "My Activity Log")
[ ] 1f: WebView container activity
[ ] 1g: SyncWorker — replace api.think()
[ ] CI/CD build — first and last APK rebuild

## Phase 2: Brain features (no APK rebuilds)
[ ] POST /brain/task — task scheduling
[ ] POST /brain/heal — self-diagnosis
[ ] POST /brain/set-cron — cron interval control
[ ] Proposal management moved to APK

## Phase 3: Remove legacy Brain endpoints
[ ] /think removed
[ ] /avatar removed
[ ] /monitor/* removed from Brain

## Phase 4: Monitor focuses on Saraha
[ ] Monitor adds APK watching
[ ] Brain removed from Monitor scope
