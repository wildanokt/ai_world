import { emailSchema, hashPassword } from "./login.js";
import { openPostgres, transaction } from "../postgres.js";

const email = emailSchema.parse(process.argv[2]);
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 512) throw new Error("Password input is too long.");
}
const password = input.replace(/\r?\n$/, "");
if (password.length < 12 || password.length > 256) throw new Error("Use a password between 12 and 256 characters.");
const { pool } = await openPostgres(process.env.DATABASE_URL);
try {
  const hash = await hashPassword(password);
  await transaction(pool, async (client) => {
    await client.query("INSERT INTO app_users VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET password_hash = $2", [email, hash]);
    await client.query("DELETE FROM app_sessions WHERE email = $1", [email]);
  });
  console.log("AI World account is ready.");
} finally { await pool.end(); }
