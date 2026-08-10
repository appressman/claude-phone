# Apple Watch → Eve Capture Shortcut

Send voice dictations from your Apple Watch directly to Eve via Telegram in under 5 seconds.

## How It Works

Apple Watch microphone → Dictate Text → Get Contents of URL (GET to Telegram Bot API) → Hermes → Eve processes as your message.

No extra server. No extra app. The Telegram bot token is embedded in the Shortcut (personal device, acceptable for single-user use).

## Build the Shortcut (5 minutes)

### On iPhone — open Shortcuts app → tap `+` to create new

**Add these actions in order:**

---

### Action 1: Dictate Text

- Action name: **Dictate Text**
- Language: English (United States)
- Stop listening: After Pause

> This is the action that runs on Apple Watch. No settings to name or configure beyond those two fields.

---

### Action 2: Get Contents of URL

- Action name: **Get Contents of URL**
- Method: **GET** (no body needed — parameters go in the URL)
- URL: tap the URL field and build it in two parts:
  1. Type or paste this entire string first:
     ```
     https://api.telegram.org/bot8533329294:AAGFMwh6b2sfU-H4QAOeRw0Yqkacvp7AXMY/sendMessage?chat_id=7813857981&text=[Watch] 
     ```
     (leave a space after `[Watch] ` — the variable goes right after it)
  2. With your cursor at the end, tap the **{x}** variable icon above the keyboard and choose **Dictated Text**

> The URL field's variable picker is reliable on all iOS versions. iOS Shortcuts automatically URL-encodes the variable when it's embedded in a URL. No JSON, no body, no type fields.

---

### Action 3: Show Notification (optional)

- Action name: **Show Notification**
- Title: `Sent to Eve`
- Body: tap the **{x}** variable icon and choose **Dictated Text**

> Gives Watch haptic confirmation. Skip it if you want the shortcut to be silent.

---

### Name and Save

- Tap the name field at the top and call it: **Send to Eve**
- Tap Done

---

## Add to Apple Watch

1. On iPhone, open **Watch app** → **My Watch** tab → **Shortcuts**
2. Find **Send to Eve** and toggle it ON
3. It will appear in the Shortcuts app on your Watch

### Optionally: Add to Apple Watch complication
1. Long-press Watch face → **Edit**
2. Tap a complication slot → scroll to **Shortcuts**
3. Select **Send to Eve**

Now you can tap the complication to trigger it directly from the watch face.

## Testing

1. Run the Shortcut from iPhone first — dictate "testing one two three"
2. Check your Telegram for the message `[Watch] testing one two three`
3. Eve will respond via Telegram
4. Then test from Watch (Shortcut app on Watch → Send to Eve)

## Upgrading Later

When iOS 27 ships (fall 2026), Siri Extensions will let Claude/Eve integrate directly into Siri. At that point:
- "Hey Siri, ask Eve about [topic]" will work natively
- This Shortcut becomes the fallback for non-conversational quick capture

The Telegram channel stays the same — only the trigger mechanism changes.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Shortcut times out | Check internet on Watch (needs paired phone or Watch cellular) |
| No Telegram message | Verify the bot token hasn't changed in ~/.hermes/.env |
| Watch runs but no audio | Check Watch microphone permissions in Watch app settings |
| "Get Contents of URL" fails | Check the URL ends with `&text=[Watch] ` followed immediately by the Dictated Text variable token |
| Variable picker ({x}) shows nothing | Make sure Dictate Text (Action 1) is above Get Contents of URL in the list |
| Message arrives garbled | Normal — iOS URL-encodes spaces as `%20`, Telegram decodes them correctly |

## Quick Reference

| Field | Value |
|-------|-------|
| Full URL (paste into URL field, then append Dictated Text variable) | `https://api.telegram.org/bot8533329294:AAGFMwh6b2sfU-H4QAOeRw0Yqkacvp7AXMY/sendMessage?chat_id=7813857981&text=[Watch] ` |
| Method | GET |
| Message prefix | `[Watch] ` |
