// X changes its generated CSS classes frequently. Keep every DOM repair point here
// and prefer semantic roles, stable href shapes, datetime, aria attributes, and
// product-owned data-testid values.
export const X_DOM = Object.freeze({
  main: 'main[role="main"], main',
  controlState: 'main[role="dialog"], main [role="dialog"], main form',
  authenticatedAccount: '[data-testid="SideNav_AccountSwitcher_Button"]',
  authenticatedHomeLink: 'a[data-testid="AppTabBar_Home_Link"], a[href="/home"]',
  loginIdentifier: 'input[autocomplete="username"]',
  loginPassword: 'input[autocomplete="current-password"]',
  loginLink: 'a[href="/login"], a[data-testid="loginButton"]',
  followingTab: '[role="tab"]',
  timelinePost: 'article[data-testid="tweet"]',
  postText: '[data-testid="tweetText"]',
  postTime: 'time[datetime]',
  postStatusLink: 'a[href*="/status/"]',
  userName: '[data-testid="User-Name"]',
  replyMetric: '[data-testid="reply"]',
  repostMetric: '[data-testid="retweet"], [data-testid="unretweet"]',
  likeMetric: '[data-testid="like"], [data-testid="unlike"]',
  viewMetric: 'a[href*="/analytics"], [aria-label*="View" i]',
  listLink: 'a[href^="/i/lists/"], a[href^="https://x.com/i/lists/"]',
  conversationLink: 'a[href^="/messages/"], a[href^="https://x.com/messages/"]',
  pageHeading: 'main h1, main h2, [role="main"] [role="heading"]',
  chatMessage: [
    'main [data-testid="messageEntry"]',
    'main [data-message-id]',
    'main [data-event-id]',
  ].join(", "),
  chatMessageText: [
    '[data-testid="messageText"]',
    '[data-testid="tweetText"]',
    '[role="paragraph"]',
    '[dir="auto"][lang]',
  ].join(", "),
  chatReaction: [
    '[data-testid*="reaction" i]',
    '[data-reaction]',
    '[data-emoji]',
    '[aria-label*="reaction" i]',
    '[aria-label*="reacted" i]',
  ].join(", "),
  chatComposer: [
    'main [data-testid="dmComposerTextInput"]',
    'main textarea[placeholder*="message" i]',
    'main [contenteditable="true"][role="textbox"]',
  ].join(", "),
  chatUnlockInput: [
    'main input[type="password"]',
    'main input[autocomplete="current-password"]',
    'main input[inputmode="numeric"]',
  ].join(", "),
  chatShell: [
    'main a[href^="/messages/"]:not([href="/messages/compose"]):not([href="/messages/requests"]):not([href="/messages/settings"])',
    'main [data-testid="messageEntry"]',
    'main [data-message-id]',
    'main [data-event-id]',
    'main [data-testid="dmComposerTextInput"]',
    'main [contenteditable="true"][role="textbox"]',
  ].join(", "),
});

export const X_ACCESSIBLE_NAMES = Object.freeze({
  followingTab: /^Following$/i,
  login: /^(?:log in|sign in)$/i,
  chatUnlock: /(?:unlock|set up|enable|restore|continue).*(?:chat|message)|(?:chat|message).*(?:passcode|password|unlock)/i,
});

export const X_VISIBLE_TEXT = Object.freeze({
  chatUnlock: /(?:unlock (?:your )?(?:chat|messages)|enter (?:your )?(?:chat )?passcode|set up (?:x )?chat|restore (?:your )?(?:chat|messages)|secure storage (?:password|passcode))/i,
  login: /(?:log in to x|sign in to x|create your account)/i,
});
