// Messages with no letter characters (pure emoji / punctuation / stickers) add
// noise in group chats. "yes" and "no" pass this filter; "👍" and "😂🔥" do not.
export function isEmojiOnly(text: string): boolean {
  return !/\p{L}/u.test(text.trim());
}
