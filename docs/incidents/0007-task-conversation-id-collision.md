# Short random IDs allowed one conversation to overwrite another

## Symptom and cause

The commit-baseline full suite on 2026-11-20 failed the foreign-Task fork rejection. Two different Tasks had distinct native sessions but the same Conversation ID. The later `Foreign` conversation replaced `Source`; the ownership check then legitimately accepted the foreign Task as belonging to that overwritten identity.

Both Task and Conversation IDs used a seconds-resolution timestamp plus only four random decimal digits. They were persisted as JSON filenames without collision reservation. Repeating time and the short random value reproduced overwritten identities; ordinary reruns could pass and hide the bug.

## Fix and prevention

Task and Conversation ID generation now retain the sortable timestamp/prefix but use a full UUID suffix. Existing record IDs and lookup routes remain valid; no stored records are renamed. Other entity IDs are outside this narrow change.

`test_concurrent_chat_identities_survive_repeated_clock_and_legacy_entropy` drives real Scheduler submission with FakeRuntime under a frozen clock and repeated legacy random value. It failed before the fix and verifies independent Task/Conversation records, preserved source content and rejection of cross-conversation forks after the fix. This is a state-preservation regression, not a retry of the flaky test with weaker assertions.
