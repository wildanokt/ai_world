# Game state is owned by code, not by the AI

HP, inventory, location, quests, and dice live in code and the database. The Game Master only narrates and proposes changes through tools (such as `roll_dice` and `give_item`), which the game validates. We rejected keeping state in the conversation text because the AI forgets items, invents values, and can't be rewound reliably.

Status: accepted
