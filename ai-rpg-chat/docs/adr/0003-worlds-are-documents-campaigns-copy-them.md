# Worlds are editable documents; a Campaign copies its World when it starts

Worlds are templates the user rewrites freely in the God Console, so each World is stored as one validated JSON document (`worlds` table), not as an event log. When a Campaign starts, its `campaign_started` event carries a full copy of the World and its Character Profiles, with everyone at full HP. Later World edits therefore never change a Campaign already being played, and a Campaign's history can always be replayed from its own events.

Changing a live Campaign (the Player Character's stats, a God's Blessing) is a separate path: it will append events to that Campaign (milestone 4), and it never edits the World.

Campaigns saved before Worlds existed have a legacy `campaign_started` shape. `applyEvent` still reads it, filling in an empty World.
