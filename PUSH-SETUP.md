# iPhone push notifications — setup

Code: `src/push.js` (APNs sender, device tokens) and `src/routes/notifications.js`
(`notify()` pushes every in-app notification; `POST`/`DELETE
/api/notifications/push-token`). The app side is `src/js/push-notifications.js`
in the app repo.

Push stays **off** (nothing is sent, no errors) until `APNS_KEY`, `APNS_KEY_ID`
and `APNS_TEAM_ID` are all set. Mute switches and blocks apply to pushes the
same way they apply to the inbox.

## 1. Create the APNs key (once, at developer.apple.com)

1. Certificates, IDs & Profiles → **Keys** → **+**.
2. Name it `Pocket Coach Push`, tick **Apple Push Notifications service (APNs)**,
   Configure → Environment **Sandbox & Production**, Continue → Register.
3. **Download** the `AuthKey_XXXXXXXXXX.p8` file. Apple lets you download it
   only once; keep it somewhere safe.
4. Note the **Key ID** (10 characters, shown on the key's page).

One key works for every app on the team and never expires.

## 2. Configure the backend

Set the secret **before deploying**: `functions-entry.js` declares `APNS_KEY`,
and a declared secret that doesn't exist fails the deploy.

```
firebase functions:secrets:set APNS_KEY < AuthKey_XXXXXXXXXX.p8
```

In `.env`: `APNS_KEY_ID=` the Key ID. `APNS_TEAM_ID` is already `WD37WHSYG7`.

Then deploy functions and rules (the new `pushTokens` collection is server-only):

```
firebase deploy --only functions,firestore
```

## 3. The App ID and the build

- The App ID `org.pocketcoachcoms.app` needs **Push Notifications** ticked.
- After ticking it, fetch the App Store provisioning profile again in
  Codemagic, so the profile includes push.
- The app's entitlements are written during the Codemagic build by
  `scripts/ios/add-capabilities.rb` (app repo).

## How it behaves

- Token storage: `pushTokens/{token}` `{ user, platform, env }`. A phone that
  signs in to another account moves its token there. Sign-out and account
  deletion remove it. Tokens APNs reports as gone are deleted.
- Text: `"<name> <text>"`, e.g. "Sam sent you a friend request". Group posts,
  feed posts and leaderboard passes use `apns-collapse-id`, so a busy group
  replaces its banner instead of stacking them.
- TestFlight and App Store builds use the production APNs server. Builds run
  from Xcode use sandbox; the sender tries the other server on `BadDeviceToken`
  and remembers which one worked.

Test: `node scripts/test-push.js`
