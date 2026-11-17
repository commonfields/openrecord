// Signs this computer's bridge in to Cursor with the person's own account:
// opens the browser to Cursor's sign-in and stores a user key where the SDK
// reads it (~/.cursor/sdk/auth.json). Run: pnpm --filter @openrecord/bridge cursor:login
import { Cursor } from "@cursor/sdk"

const result = await Cursor.auth.login({ onLoginUrl: url => console.log(`If the browser did not open, sign in here:\n${url}`) })
console.log(`Signed in to Cursor${result.email ? ` as ${result.email}` : ""}. OpenRecord lists your Cursor models within a minute.`)
