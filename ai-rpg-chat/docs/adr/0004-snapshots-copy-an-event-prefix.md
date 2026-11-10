# Snapshots copy an event prefix when rewinding

A Snapshot is a named event sequence within a Campaign. Rewind creates a playable Campaign ID containing the selected timeline's event prefix, copies eligible Snapshots, and indexes the copied events for Recall. The previous timeline keeps its ID and its full event log. Both IDs appear in the same Branch family.

The copy is transactional. Transcript, Journal, combat, clock and summaries all follow the selected prefix. Recall is scoped to the active timeline. The storage cost is proportional to the length of the shared history. Token totals follow the timeline and include the work from its shared prefix.
