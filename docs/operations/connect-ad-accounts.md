# Connect ad accounts (Meta and Google Ads)

OpenRecord reads a client's own ad accounts so the agent can answer "what did the ads cost and what did they bring in". Access is read-only. OpenRecord never creates, changes or pauses an ad.

Each platform turns on when its credentials are in the API's environment. Until then the Channels page shows "Not switched on for this OpenRecord server yet" with what's missing.

## What the agent gets

`read_ad_performance` covers every ad account bound to the business, for the last 7, 28 or 90 days and the period before:
- spend, impressions, clicks, conversions and conversion value;
- cost per click, cost per conversion and return on ad spend;
- the top campaigns by spend.

Each platform counts conversions its own way and credits its own ads. The tool says so, and the agent is told never to add Meta's and Google's conversions together as if they were separate sales.

## Shared settings

```
ADS_OAUTH_REDIRECT_URI=https://<app host>/api/ads/oauth/callback
ADS_TOKEN_ENCRYPTION_KEYS=k1:<base64 of 32 random bytes>   # optional; GA4_TOKEN_ENCRYPTION_KEYS is used when absent
APP_BASE_URL=https://<app host>
```

The callback goes through the app's address, like GA4's, so the person's sign-in cookie comes with it. For local development use `http://localhost:3000/api/ads/oauth/callback`. Generate a key with `openssl rand -base64 32`.

## Meta (Facebook and Instagram ads)

1. Create an app at developers.facebook.com of the **Business** type, and add **Facebook Login for Business**.
2. Add the redirect URI above to the login product's valid OAuth redirect URIs.
3. Request the **ads_read** permission. It needs Meta's App Review, and Business Verification of the company that owns the app. Until approval, only people with a role on the app (admins, developers, testers) can connect.
4. Set these in the API's environment:
   ```
   META_APP_ID=...
   META_APP_SECRET=...
   META_GRAPH_VERSION=v23.0   # optional
   ```

OpenRecord asks only for `ads_read`. Meta sometimes grants more; if it does, OpenRecord revokes the sign-in and keeps nothing. Meta issues no refresh token: the long-lived token lasts about 60 days, after which the Channels page asks the person to reconnect. Every call carries `appsecret_proof`.

## Google Ads

1. Use the Google OAuth client GA4 already uses (`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`). Add the redirect URI above to its authorized redirect URIs, and add the Google Ads API to the Google Cloud project.
2. Get a **developer token** from the API Center of a Google Ads manager account. A new token starts at test access, which only reads test accounts. Apply for Basic access to read real client accounts.
3. Set:
   ```
   GOOGLE_ADS_DEVELOPER_TOKEN=...
   GOOGLE_ADS_API_VERSION=v21   # optional
   ```

Google offers no read-only scope for Ads: the `adwords` scope could change campaigns. OpenRecord only ever calls `customers:listAccessibleCustomers` and `googleAds:search`, both of which read. Accounts reached through a manager account are listed one level down and read with `login-customer-id`.

## Storage and removal

- Tokens are stored only as AES-256-GCM ciphertext, bound to their connection and purpose (migration `0046_ad_connections_v1.sql`). A token never appears in a response, a log line or a redirect.
- An ad account can be bound to a business only if the sign-in can read it at that moment.
- **Disconnect** revokes the access at the platform when it can, deletes the stored tokens and stops reading every ad account that came through that sign-in.

## API versions

Meta retires a Graph API version about two years after its release, and Google retires an Ads API version about a year after its release. When a version nears retirement, raise `META_GRAPH_VERSION` or `GOOGLE_ADS_API_VERSION`.
